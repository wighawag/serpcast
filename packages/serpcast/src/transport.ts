// The transport: one HTTP exchange per request, sent as the pinned Chrome
// (IMPERSONATE_TARGET, library default headers OFF) with exactly the header
// table of the request kind, through the caller's proxy only. Redirects are
// NOT followed and statuses are NOT interpreted: each hop is its own request,
// so cookies and the header table apply per hop, and the caller decides what
// a status means. Bodies are decoded in response.ts. One easy handle (so one
// connection) per request: no connection reuse across requests yet.
//
// Egress: CURLOPT_PROXY is always set (to "" when the caller gave no proxy) and
// CURLOPT_NOPROXY to "", so libcurl's proxy environment variables (http_proxy,
// HTTPS_PROXY, ALL_PROXY, NO_PROXY) can neither add nor bypass a proxy: the
// caller's option is the only egress policy (ADR 0002). Only http and https
// are allowed.

import {DEFAULT_TIMEOUT_MS} from 'serpcast-recipe';
import {headerTable, IMPERSONATE_TARGET, type RequestKind} from './chrome.js';
import {CookieStore, type StoredCookie} from './cookies.js';
import {SerpcastError} from './errors.js';
import {respond, type TransportResponse} from './response.js';
import {
	assertImpersonation,
	loadLibcurl,
	resolveLibraryPath,
	type Libcurl,
} from './libcurl.js';

export interface TransportOptions {
	/** The libcurl-impersonate shared library; else SERPCAST_LIBCURL_PATH, LIBCURL_PATH, the data dir. */
	libcurlPath?: string;
	/**
	 * Proxy URL (`http://`, `socks5://`, `socks5h://`), passed to libcurl as
	 * given; none means a direct connection (proxy environment variables are
	 * ignored). The scheme decides where DNS is resolved: `socks5h://` at the
	 * proxy, `socks5://` LOCALLY. Pass `socks5h://` to keep DNS off this host.
	 */
	proxy?: string;
	/** Refuse to send unless libcurl-impersonate accepts the pinned target. Default true. */
	strict?: boolean;
	/** Per-request time limit in ms. Default `DEFAULT_TIMEOUT_MS` of serpcast-recipe. */
	timeoutMs?: number;
	/** A PEM CA bundle to verify servers against, instead of the library's default. */
	caPath?: string;
	/** Largest body accepted, before and after decoding, in bytes. Default 16 MiB. */
	maxBodyBytes?: number;
}

export type RequestOptions = {signal?: AbortSignal; timeoutMs?: number} & (
	| {kind: 'document'; referer?: undefined}
	| {kind: Exclude<RequestKind, 'document'>; referer: string}
);

export type {TransportResponse};

/** What `check()` found. */
export interface LibraryInfo {
	path: string;
	version: string;
	target: string;
	/** Whether requests carry the impersonated fingerprint (always true in strict mode). */
	impersonating: boolean;
}

/** Requests sharing one set of cookies; `cookies()` is plain JSON for a state store. */
export interface TransportSession {
	request(url: string, options: RequestOptions): Promise<TransportResponse>;
	cookies(): StoredCookie[];
	clearCookies(): void;
}

export interface Transport {
	/** Load and (in strict mode) check the library. No network call. */
	check(): Promise<LibraryInfo>;
	/** A new session, optionally restoring saved cookies. */
	session(cookies?: readonly StoredCookie[]): TransportSession;
}

// libcurl option and error numbers (curl/curl.h).
const OPT = {
	URL: 10002,
	PROXY: 10004,
	ERRORBUFFER: 10010,
	WRITEFUNCTION: 20011,
	HTTPHEADER: 10023,
	NOPROGRESS: 43,
	CAINFO: 10065,
	HEADERFUNCTION: 20079,
	NOSIGNAL: 99,
	TIMEOUT_MS: 155,
	NOPROXY: 10177,
	XFERINFOFUNCTION: 20219,
	PROTOCOLS_STR: 10318,
};
const E_WRITE = 23;
const E_TIMEDOUT = 28;
const E_ABORTED = 42;

export function createTransport(options: TransportOptions = {}): Transport {
	const strict = options.strict ?? true;
	let ready: Promise<{curl: Libcurl; info: LibraryInfo}> | undefined;
	const check = () => {
		ready ??= (async () => {
			const curl = await loadLibcurl(resolveLibraryPath(options.libcurlPath));
			let impersonating = true;
			try {
				assertImpersonation(curl);
			} catch (error) {
				if (strict) throw error;
				impersonating = false;
			}
			const info = {
				path: curl.path,
				version: curl.version,
				target: IMPERSONATE_TARGET,
				impersonating,
			};
			return {curl, info};
		})().catch((error: unknown) => {
			ready = undefined; // not cached: a later call may find the library
			throw error;
		});
		return ready;
	};
	return {
		check: async () => (await check()).info,
		session(saved) {
			const jar = new CookieStore(saved);
			return {
				cookies: () => jar.list(),
				clearCookies: () => jar.clear(),
				async request(url, request) {
					const target = parseUrl(url);
					const table = headerTable(request.kind, {
						referer: request.referer,
						cookie: jar.header(target),
					});
					request.signal?.throwIfAborted();
					const {curl, info} = await check();
					const response = await perform(
						curl,
						info.impersonating,
						target.href,
						table,
						options,
						request,
					);
					jar.store(target, response.headers.getSetCookie());
					return response;
				},
			};
		},
	};
}

function parseUrl(url: string): URL {
	let parsed: URL | undefined;
	try {
		parsed = new URL(url);
	} catch {
		parsed = undefined;
	}
	if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') {
		throw new SerpcastError('recipe', `not an http(s) URL: ${url}`);
	}
	return parsed;
}

let protos: {data: unknown; progress: unknown} | undefined;

async function perform(
	curl: Libcurl,
	impersonate: boolean,
	url: string,
	table: [string, string][],
	options: TransportOptions,
	request: RequestOptions,
): Promise<TransportResponse> {
	const {koffi} = curl;
	protos ??= {
		data: koffi.pointer(
			koffi.proto(
				'size_t serpcast_data_cb(void *ptr, size_t size, size_t n, void *user)',
			),
		),
		progress: koffi.pointer(
			koffi.proto(
				'int serpcast_progress_cb(void *user, int64_t dt, int64_t dn, int64_t ut, int64_t un)',
			),
		),
	};
	const max = options.maxBodyBytes ?? 16 * 1024 * 1024;
	const chunks: Buffer[] = [];
	let size = 0;
	let tooLarge = false;
	let headerLines: string[] = [];
	const onData = koffi.register((ptr: unknown, n: number, m: number) => {
		size += n * m;
		if (size > max) return ((tooLarge = true), 0);
		chunks.push(Buffer.from(new Uint8Array(koffi.view(ptr, n * m)))); // copy
		return n * m;
	}, protos.data as never);
	const onHeader = koffi.register((ptr: unknown, n: number, m: number) => {
		const line = Buffer.from(new Uint8Array(koffi.view(ptr, n * m))).toString(
			'latin1',
		);
		if (/^HTTP\/\S+ \d{3}/.test(line)) headerLines = [];
		headerLines.push(line.replace(/\r?\n$/, ''));
		return n * m;
	}, protos.data as never);
	const onProgress = koffi.register(
		() => (request.signal?.aborted ? 1 : 0),
		protos.progress as never,
	);
	const errbuf = koffi.alloc('char', 256);
	const handle = curl.init();
	let list: unknown = null;
	try {
		if (!handle) throw new SerpcastError('transport', 'curl_easy_init failed');
		if (impersonate && curl.impersonate!(handle, IMPERSONATE_TARGET, 0) !== 0) {
			throw new SerpcastError(
				'impersonation',
				`impersonating ${IMPERSONATE_TARGET} failed`,
			);
		}
		for (const [name, value] of table)
			list = curl.slistAppend(list, `${name}: ${value}`);
		const set = (opt: number, type: unknown, value: unknown) =>
			curl.setopt(handle, opt, type, value);
		set(OPT.URL, 'str', url);
		set(OPT.HTTPHEADER, 'void *', list);
		set(OPT.PROXY, 'str', options.proxy ?? '');
		set(OPT.NOPROXY, 'str', '');
		set(OPT.PROTOCOLS_STR, 'str', 'http,https');
		set(OPT.NOSIGNAL, 'long', 1);
		set(
			OPT.TIMEOUT_MS,
			'long',
			request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		if (options.caPath) set(OPT.CAINFO, 'str', options.caPath);
		set(OPT.ERRORBUFFER, 'void *', errbuf);
		set(OPT.WRITEFUNCTION, protos.data, onData);
		set(OPT.HEADERFUNCTION, protos.data, onHeader);
		set(OPT.NOPROGRESS, 'long', 0);
		set(OPT.XFERINFOFUNCTION, protos.progress, onProgress);
		const code = await new Promise<number>((resolve, reject) =>
			curl.perform.async(handle, (cause: unknown, res: number) =>
				cause
					? reject(
							new SerpcastError('transport', `request to ${url} failed`, {
								cause,
							}),
						)
					: resolve(res),
			),
		);
		if (code === E_ABORTED && request.signal?.aborted)
			throw request.signal.reason;
		if (code === E_TIMEDOUT)
			throw new SerpcastError('timeout', `request to ${url} timed out`);
		if (code === E_WRITE && tooLarge) {
			throw new SerpcastError(
				'transport',
				`response from ${url} is larger than ${max} bytes`,
			);
		}
		if (code !== 0) {
			const detail = koffi.decode.string(errbuf) || curl.strerror(code);
			throw new SerpcastError(
				'transport',
				`request to ${url} failed: ${detail} (curl ${code})`,
			);
		}
		return respond(url, headerLines, Buffer.concat(chunks), max);
	} finally {
		if (handle) curl.cleanup(handle);
		if (list) curl.slistFree(list);
		koffi.free(errbuf);
		for (const cb of [onData, onHeader, onProgress]) koffi.unregister(cb);
	}
}
