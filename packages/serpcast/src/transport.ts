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
//
// Threads: every libcurl call, and so every write/header callback, runs on the
// main thread. A request is one easy handle in its own multi handle, driven by
// `drive` from event-loop timers; nothing stays in native code between turns.
// `curl_easy_perform` on a worker thread (koffi `.async`) deadlocked
// `process.exit()`: the worker waited for the main thread to run its JS
// callbacks while exit waited for the worker.

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
	CAINFO: 10065,
	HEADERFUNCTION: 20079,
	NOSIGNAL: 99,
	TIMEOUT_MS: 155,
	NOPROXY: 10177,
	PROTOCOLS_STR: 10318,
	QUICK_EXIT: 322,
};
const E_WRITE = 23;
const E_TIMEDOUT = 28;
const CURLMSG_DONE = 1;

/**
 * How long an in-flight request waits between two looks at its sockets when
 * they had nothing to read or write (sooner when libcurl asks for it). While
 * data flows, it looks again on the next event-loop turn. Each look is one
 * non-blocking `curl_multi_perform` plus one `curl_multi_poll` with a zero
 * timeout. Measured on Linux x64 (Node 24, 2026-09-29) with a server that
 * never answers: one idle in-flight request costs about 0.6% of one core, ten
 * about 1%. It adds at most 5 ms of latency to a network event that arrives
 * while idle.
 */
const IDLE_POLL_MS = 5;

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

let proto: unknown;

async function perform(
	curl: Libcurl,
	impersonate: boolean,
	url: string,
	table: [string, string][],
	options: TransportOptions,
	request: RequestOptions,
): Promise<TransportResponse> {
	const {koffi} = curl;
	proto ??= koffi.pointer(
		koffi.proto(
			'size_t serpcast_data_cb(void *ptr, size_t size, size_t n, void *user)',
		),
	);
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
	}, proto as never);
	const onHeader = koffi.register((ptr: unknown, n: number, m: number) => {
		const line = Buffer.from(new Uint8Array(koffi.view(ptr, n * m))).toString(
			'latin1',
		);
		if (/^HTTP\/\S+ \d{3}/.test(line)) headerLines = [];
		headerLines.push(line.replace(/\r?\n$/, ''));
		return n * m;
	}, proto as never);
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
		// Do not wait for a pending DNS lookup when an aborted or timed-out
		// request is cleaned up: that wait would now block the main thread.
		set(OPT.QUICK_EXIT, 'long', 1);
		set(
			OPT.TIMEOUT_MS,
			'long',
			request.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
		);
		if (options.caPath) set(OPT.CAINFO, 'str', options.caPath);
		set(OPT.ERRORBUFFER, 'void *', errbuf);
		set(OPT.WRITEFUNCTION, proto, onData);
		set(OPT.HEADERFUNCTION, proto, onHeader);
		const code = await drive(curl, handle, url, request.signal);
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
		for (const cb of [onData, onHeader]) koffi.unregister(cb);
	}
}

/**
 * Run one easy handle to completion in its own multi handle, from the main
 * thread: the transfer's libcurl result code, or the signal's reason once it
 * aborts (the handle is then dropped at once, whatever it was doing). The
 * multi handle is removed before this settles, so the caller may clean the
 * easy handle up.
 */
function drive(
	curl: Libcurl,
	easy: unknown,
	url: string,
	signal: AbortSignal | undefined,
): Promise<number> {
	return new Promise<number>((resolve, reject) => {
		const multiError = (call: string, code: number) =>
			new SerpcastError(
				'transport',
				`request to ${url} failed: ${call}: ${curl.multiStrerror(code)} (curlm ${code})`,
			);
		const multi = curl.multiInit();
		if (!multi) {
			reject(new SerpcastError('transport', 'curl_multi_init failed'));
			return;
		}
		const added: number = curl.multiAdd(multi, easy);
		if (added !== 0) {
			curl.multiCleanup(multi);
			reject(multiError('curl_multi_add_handle', added));
			return;
		}
		let timer: NodeJS.Timeout | undefined;
		let immediate: NodeJS.Immediate | undefined;
		let settled = false;
		const cancel = () => {
			if (timer) clearTimeout(timer);
			if (immediate) clearImmediate(immediate);
			timer = immediate = undefined;
		};
		const schedule = (ms: number) => {
			cancel();
			if (ms <= 0) immediate = setImmediate(tick);
			else timer = setTimeout(tick, ms);
		};
		const settle = (done: () => void) => {
			settled = true;
			cancel();
			signal?.removeEventListener('abort', onAbort);
			curl.multiRemove(multi, easy);
			curl.multiCleanup(multi);
			done();
		};
		const onAbort = () => schedule(0);
		function tick() {
			timer = immediate = undefined;
			if (settled) return;
			try {
				step();
			} catch (error) {
				if (!settled) settle(() => reject(error));
			}
		}
		function step() {
			if (signal?.aborted) {
				settle(() => reject(signal.reason));
				return;
			}
			const running = [0];
			const performed: number = curl.multiPerform(multi, running);
			if (performed !== 0) {
				settle(() => reject(multiError('curl_multi_perform', performed)));
				return;
			}
			const queued = [0];
			for (;;) {
				const pointer = curl.multiInfoRead(multi, queued);
				if (!pointer) break;
				const message = curl.koffi.decode(
					pointer,
					curl.multiMessage as never,
				) as {msg: number; data: {result: number}};
				if (message.msg === CURLMSG_DONE) {
					const result = message.data.result;
					settle(() => resolve(result));
					return;
				}
			}
			// Nothing finished: look again now if a socket is ready or libcurl
			// wants to run at once, else after its own timeout, at most IDLE_POLL_MS.
			const ready = [0];
			const polled: number = curl.multiPoll(multi, null, 0, 0, ready);
			if (polled !== 0) {
				settle(() => reject(multiError('curl_multi_poll', polled)));
				return;
			}
			const wait = [0];
			curl.multiTimeout(multi, wait);
			const due = wait[0]! < 0 ? IDLE_POLL_MS : wait[0]!;
			schedule(ready[0]! > 0 ? 0 : Math.min(due, IDLE_POLL_MS));
		}
		signal?.addEventListener('abort', onAbort, {once: true});
		tick();
	});
}
