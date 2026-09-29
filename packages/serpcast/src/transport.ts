// The transport: one HTTP exchange per request, sent as the pinned Chrome
// (IMPERSONATE_TARGET, library default headers OFF) with exactly the header
// table of the request kind, through the caller's proxy only. Redirects are
// NOT followed and statuses are NOT interpreted: each hop is its own request,
// so cookies and the header table apply per hop, and the caller decides what
// a status means. Bodies are decoded in response.ts.
//
// Connections: each request is a fresh easy handle (impersonation applied to
// it, so the fingerprint is set up exactly as before), added to its SESSION's
// multi handle, whose connection cache keeps the connection open for the
// session's next request to the same origin (through the same proxy), as
// Chrome keeps one HTTP/2 connection per origin. Connections are shared ONLY
// within one session, never across sessions: sessions (two engines, two
// callers) must stay unlinkable, and a shared connection would link them at
// the TLS and IP layer. `close()` releases a session's connections. Decisions:
// work/notes/observations/session-connection-reuse-decisions.md.
//
// Egress: CURLOPT_PROXY is always set (to "" when the caller gave no proxy) and
// CURLOPT_NOPROXY to "", so libcurl's proxy environment variables (http_proxy,
// HTTPS_PROXY, ALL_PROXY, NO_PROXY) can neither add nor bypass a proxy: the
// caller's option is the only egress policy (ADR 0002). Only http and https
// are allowed.
//
// Threads: every libcurl call, and so every write/header callback, runs on the
// main thread. A session's multi handle is driven by `Connections` from
// event-loop timers while a request is in flight; nothing stays in native code
// between turns, and nothing is scheduled while the session is idle.
// `curl_easy_perform` on a worker thread (koffi `.async`) deadlocked
// `process.exit()`: the worker waited for the main thread to run its JS
// callbacks while exit waited for the worker.
//
// POST: only for the `fetch` kind, sent as Chrome's `fetch()` POST (header
// table in chrome.ts). When Chrome would send a CORS preflight first (another
// origin, a `content-type` that is not CORS-safelisted), the session sends it
// too, as Chrome does: without cookies, on a connection of its own (Chrome
// keeps credential-less requests off the credentialed connection), and
// remembers a successful one for its `access-control-max-age` (default 5 s)
// per page origin and URL. A preflight the server does not allow stops the
// POST, as in the browser. Decisions:
// work/notes/observations/2026-09-29-post-requests-decisions.md.

import {DEFAULT_TIMEOUT_MS} from 'serpcast-recipe';
import {
	headerTable,
	IMPERSONATE_TARGET,
	preflightTable,
	type FetchSite,
	type RequestKind,
} from './chrome.js';
import {CookieStore, type StoredCookie} from './cookies.js';
import {SerpcastError} from './errors.js';
import {checkPreflight, postBody, type PostOptions} from './post.js';
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

/**
 * `referer` is the page the request comes from. For `fetch` and `script`,
 * `sec-fetch-site` (and the headers that change with it) is derived from the
 * URL relative to it; `fetchSite` overrides that for a caller who knows
 * better (the built-in site rule does not know private suffixes such as
 * `github.io`, see `registrableDomain`).
 */
export type RequestOptions = {signal?: AbortSignal; timeoutMs?: number} & (
	| {
			kind: 'document';
			referer?: undefined;
			fetchSite?: undefined;
			method?: 'GET';
	  }
	| {
			kind: 'same-origin-navigation';
			referer: string;
			fetchSite?: undefined;
			method?: 'GET';
	  }
	| {
			kind: 'fetch' | 'script';
			referer: string;
			fetchSite?: FetchSite;
			method?: 'GET';
	  }
	| PostOptions
);

export type {TransportResponse};
export {MAX_REQUEST_BODY_BYTES, type PostOptions} from './post.js';

/** What `check()` found. */
export interface LibraryInfo {
	path: string;
	version: string;
	target: string;
	/** Whether requests carry the impersonated fingerprint (always true in strict mode). */
	impersonating: boolean;
}

/**
 * Requests sharing one set of cookies and one set of connections (never shared
 * with another session); `cookies()` is plain JSON for a state store.
 */
export interface TransportSession {
	request(url: string, options: RequestOptions): Promise<TransportResponse>;
	cookies(): StoredCookie[];
	clearCookies(): void;
	/**
	 * Close the session's connections: at once when no request is in flight,
	 * else as soon as those settle (they are not aborted). Cookies are kept,
	 * and a later request opens a new connection.
	 */
	close(): void;
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
	POST: 47,
	CUSTOMREQUEST: 10036,
	COPYPOSTFIELDS: 10165,
	POSTFIELDSIZE_LARGE: 30120,
	WRITEFUNCTION: 20011,
	HTTPHEADER: 10023,
	CAINFO: 10065,
	HEADERFUNCTION: 20079,
	NOSIGNAL: 99,
	TIMEOUT_MS: 155,
	NOPROXY: 10177,
	PIPEWAIT: 237,
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
			let connections: Connections | undefined;
			// Credential-less requests (CORS preflights) use their own
			// connections, as Chrome's do.
			let anonymous: Connections | undefined;
			/** Allowed preflights: `<page origin> <url>` to expiry (ms). */
			const preflights = new Map<string, number>();
			return {
				cookies: () => jar.list(),
				clearCookies: () => jar.clear(),
				close: () => {
					connections?.close();
					anonymous?.close();
				},
				async request(url, request) {
					const target = parseUrl(url);
					const post = postBody(request);
					const table = headerTable(request.kind, {
						referer: request.referer,
						url: target,
						fetchSite: request.fetchSite,
						cookie: jar.header(target),
						...(post && {
							method: 'POST',
							contentType: post.contentType,
							contentLength: post.body.length,
						}),
					});
					const preflight =
						post &&
						preflightTable({
							referer: request.referer!,
							url: target,
							fetchSite: request.fetchSite,
							contentType: post.contentType,
						});
					request.signal?.throwIfAborted();
					const {curl, info} = await check();
					if (preflight) {
						const origin = new URL(request.referer!).origin;
						const key = `${origin} ${target.href}`;
						if (!((preflights.get(key) ?? 0) > Date.now())) {
							preflights.delete(key);
							anonymous ??= new Connections(curl);
							const answer = await perform(
								curl,
								anonymous,
								info.impersonating,
								target.href,
								preflight,
								options,
								request,
								{method: 'OPTIONS'},
							);
							const age = checkPreflight(answer, origin);
							if (age > 0) preflights.set(key, Date.now() + age * 1000);
						}
					}
					connections ??= new Connections(curl);
					const response = await perform(
						curl,
						connections,
						info.impersonating,
						target.href,
						table,
						options,
						request,
						post ? {method: 'POST', body: post.body} : {method: 'GET'},
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

type Method =
	{method: 'GET'} | {method: 'OPTIONS'} | {method: 'POST'; body: Uint8Array};

async function perform(
	curl: Libcurl,
	connections: Connections,
	impersonate: boolean,
	url: string,
	table: [string, string][],
	options: TransportOptions,
	request: RequestOptions,
	method: Method,
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
		if (method.method === 'POST') {
			// libcurl's own POST headers, off: the table has content-length and
			// (when there is one) content-type; `Name:` removes a header.
			for (const name of ['Content-Type', 'Expect'])
				if (!table.some(([n]) => n.toLowerCase() === name.toLowerCase()))
					list = curl.slistAppend(list, `${name}:`);
		}
		const set = (opt: number, type: unknown, value: unknown) =>
			curl.setopt(handle, opt, type, value);
		set(OPT.URL, 'str', url);
		if (method.method === 'POST' && method.body.length === 0) {
			// No body: a bodiless transfer named POST, so the HEADERS frame ends
			// the stream (END_STREAM), as Chrome's does; libcurl's own POST
			// would send an empty DATA frame after it.
			set(OPT.CUSTOMREQUEST, 'str', 'POST');
		} else if (method.method === 'POST') {
			set(OPT.POST, 'long', 1);
			set(OPT.POSTFIELDSIZE_LARGE, 'int64', method.body.length);
			// Copied by libcurl at once, so the buffer need not outlive this call.
			set(OPT.COPYPOSTFIELDS, 'void *', Buffer.from(method.body));
		} else if (method.method === 'OPTIONS') {
			set(OPT.CUSTOMREQUEST, 'str', 'OPTIONS');
		}
		set(OPT.HTTPHEADER, 'void *', list);
		set(OPT.PROXY, 'str', options.proxy ?? '');
		set(OPT.NOPROXY, 'str', '');
		set(OPT.PROTOCOLS_STR, 'str', 'http,https');
		set(OPT.NOSIGNAL, 'long', 1);
		// A request to an origin whose connection is still being set up waits
		// for it to say whether it multiplexes (HTTP/2), instead of opening a
		// second connection: Chrome keeps one connection per origin.
		set(OPT.PIPEWAIT, 'long', 1);
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
		const code = await connections.run(handle, url, request.signal);
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

interface Transfer {
	easy: unknown;
	url: string;
	signal: AbortSignal | undefined;
	onAbort: () => void;
	resolve: (code: number) => void;
	reject: (error: unknown) => void;
}

/**
 * One session's connections: a multi handle (and so libcurl's connection
 * cache, and its TLS session cache) that every request of the session is
 * added to, driven from the main thread. `run` adds one easy handle and
 * settles with the transfer's libcurl result code, or the signal's reason once
 * it aborts (the handle is then dropped at once, whatever it was doing). The
 * easy handle is removed from the multi handle before `run` settles, so the
 * caller may clean it up; the connection it used stays in the cache for the
 * session's next request. Nothing runs while no request is in flight (no
 * timer, no Node handle), so idle connections do not keep the process alive.
 * `close` drops the multi handle, closing its connections, once no request is
 * in flight (at once when idle); the next request opens a new one.
 */
class Connections {
	private multi: unknown;
	private readonly transfers = new Map<bigint, Transfer>();
	private timer: NodeJS.Timeout | undefined;
	private immediate: NodeJS.Immediate | undefined;
	private closing = false;

	constructor(private readonly curl: Libcurl) {}

	run(
		easy: unknown,
		url: string,
		signal: AbortSignal | undefined,
	): Promise<number> {
		const {curl} = this;
		return new Promise<number>((resolve, reject) => {
			if (!this.multi) {
				this.multi = curl.multiInit();
				this.closing = false;
				if (!this.multi) {
					this.multi = undefined;
					reject(new SerpcastError('transport', 'curl_multi_init failed'));
					return;
				}
			}
			const added: number = curl.multiAdd(this.multi, easy);
			if (added !== 0) {
				reject(this.multiError(url, 'curl_multi_add_handle', added));
				this.release();
				return;
			}
			const transfer: Transfer = {
				easy,
				url,
				signal,
				onAbort: () => this.schedule(0),
				resolve,
				reject,
			};
			this.transfers.set(address(curl, easy), transfer);
			signal?.addEventListener('abort', transfer.onAbort, {once: true});
			this.schedule(0);
		});
	}

	/** Close the connections now if idle, else as soon as the requests in flight settle. */
	close(): void {
		this.closing = true;
		this.release();
	}

	private multiError(url: string, call: string, code: number) {
		return new SerpcastError(
			'transport',
			`request to ${url} failed: ${call}: ${this.curl.multiStrerror(code)} (curlm ${code})`,
		);
	}

	private cancel() {
		if (this.timer) clearTimeout(this.timer);
		if (this.immediate) clearImmediate(this.immediate);
		this.timer = this.immediate = undefined;
	}

	private schedule(ms: number) {
		this.cancel();
		if (ms <= 0) this.immediate = setImmediate(() => this.tick());
		else this.timer = setTimeout(() => this.tick(), ms);
	}

	private settle(transfer: Transfer, done: (t: Transfer) => void) {
		this.transfers.delete(address(this.curl, transfer.easy));
		transfer.signal?.removeEventListener('abort', transfer.onAbort);
		this.curl.multiRemove(this.multi, transfer.easy);
		done(transfer);
	}

	/** With nothing in flight: stop looking, and drop the multi handle if closing. */
	private release() {
		if (this.transfers.size > 0) return;
		this.cancel();
		if (this.closing && this.multi) {
			this.curl.multiCleanup(this.multi);
			this.multi = undefined;
		}
		this.closing = false;
	}

	private tick() {
		this.timer = this.immediate = undefined;
		try {
			this.step();
		} catch (error) {
			for (const transfer of [...this.transfers.values()])
				this.settle(transfer, (t) => t.reject(error));
		}
		this.release();
	}

	private step() {
		const {curl} = this;
		for (const transfer of [...this.transfers.values()]) {
			if (transfer.signal?.aborted)
				this.settle(transfer, (t) => t.reject(t.signal!.reason));
		}
		if (this.transfers.size === 0) return;
		const running = [0];
		const performed: number = curl.multiPerform(this.multi, running);
		if (performed !== 0) {
			for (const transfer of [...this.transfers.values()]) {
				this.settle(transfer, (t) =>
					t.reject(this.multiError(t.url, 'curl_multi_perform', performed)),
				);
			}
			return;
		}
		const queued = [0];
		for (;;) {
			const pointer = curl.multiInfoRead(this.multi, queued);
			if (!pointer) break;
			const message = curl.koffi.decode(
				pointer,
				curl.multiMessage as never,
			) as {msg: number; easy: unknown; data: {result: number}};
			if (message.msg !== CURLMSG_DONE) continue;
			const transfer = this.transfers.get(address(curl, message.easy));
			const result = message.data.result;
			if (transfer) this.settle(transfer, (t) => t.resolve(result));
		}
		if (this.transfers.size === 0) return;
		// Something is still in flight: look again now if a socket is ready or
		// libcurl wants to run at once, else after its own timeout, at most
		// IDLE_POLL_MS.
		const ready = [0];
		const polled: number = curl.multiPoll(this.multi, null, 0, 0, ready);
		if (polled !== 0) {
			for (const transfer of [...this.transfers.values()]) {
				this.settle(transfer, (t) =>
					t.reject(this.multiError(t.url, 'curl_multi_poll', polled)),
				);
			}
			return;
		}
		const wait = [0];
		curl.multiTimeout(this.multi, wait);
		const due = wait[0]! < 0 ? IDLE_POLL_MS : wait[0]!;
		this.schedule(ready[0]! > 0 ? 0 : Math.min(due, IDLE_POLL_MS));
	}
}

function address(curl: Libcurl, pointer: unknown): bigint {
	return BigInt(curl.koffi.address(pointer as never));
}
