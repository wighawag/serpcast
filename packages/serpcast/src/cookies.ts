// The transport session's cookies. serpcast owns them (libcurl's cookie engine
// is never used) so the `cookie` header lands where Chrome puts it in the
// header table. RFC 6265 storage and matching, Chrome's send order (longest
// path first, then oldest). SameSite is not enforced (not even stored): a
// cross-site `fetch` or `script` (chrome.ts `fetchSite`) is sent every cookie
// that matches its URL, where Chrome would drop those without
// `SameSite=None`. There is no public suffix list, so a `Domain` attribute
// must equal the host or contain a dot.
//
// A page's script can also write and read the store (`document.cookie`, see
// `DocumentCookies`): a code recipe's `ctx.cookies` (code.ts). The string is
// parsed as a `Set-Cookie` from the page's URL (the same rules), minus what a
// script cannot do: `HttpOnly` is ignored, a script cannot overwrite (or
// delete) an `HttpOnly` cookie, and it never sees one (RFC 6265 5.3 step 11,
// as Chrome). Decisions: work/notes/observations/2026-09-29-recipe-set-cookie-decisions.md.

import {SerpcastError} from './errors.js';

/** One stored cookie; plain JSON, so a caller's state store can keep it. */
export interface StoredCookie {
	name: string;
	value: string;
	/** Lower-case, no leading dot. */
	domain: string;
	/** True when set without a `Domain` attribute: sent to that exact host only. */
	hostOnly: boolean;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	/** Expiry in ms since the epoch; absent for a session cookie. */
	expires?: number;
	/** Creation time in ms since the epoch (keeps Chrome's send order). */
	created: number;
}

const isIp = (host: string) => /^[\d.]+$/.test(host) || host.includes(':');

function domainMatch(host: string, domain: string): boolean {
	return host === domain || (!isIp(host) && host.endsWith(`.${domain}`));
}

function pathMatch(requestPath: string, cookiePath: string): boolean {
	if (requestPath === cookiePath) return true;
	if (!requestPath.startsWith(cookiePath)) return false;
	return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function defaultPath(url: URL): string {
	const p = url.pathname;
	const slash = p.lastIndexOf('/');
	return slash <= 0 ? '/' : p.slice(0, slash);
}

/** Parse one `Set-Cookie` value received from `url`; undefined when rejected. */
export function parseSetCookie(
	header: string,
	url: URL,
	now: number,
): StoredCookie | undefined {
	const [pair = '', ...attrs] = header.split(';');
	const eq = pair.indexOf('=');
	const name = eq < 0 ? '' : pair.slice(0, eq).trim();
	const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
	if (!name && !value) return undefined;
	const host = url.hostname.toLowerCase();
	const cookie: StoredCookie = {
		name,
		value,
		domain: host,
		hostOnly: true,
		path: defaultPath(url),
		secure: false,
		httpOnly: false,
		created: now,
	};
	let maxAge: number | undefined;
	for (const attr of attrs) {
		const i = attr.indexOf('=');
		const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
		const val = i < 0 ? '' : attr.slice(i + 1).trim();
		if (key === 'expires') {
			const t = Date.parse(val);
			if (!Number.isNaN(t)) cookie.expires = t;
		} else if (key === 'max-age' && /^-?\d+$/.test(val)) {
			maxAge = Number(val);
		} else if (key === 'domain' && val) {
			const domain = val.replace(/^\./, '').toLowerCase();
			if (!domainMatch(host, domain)) return undefined;
			if (domain !== host && !domain.includes('.')) return undefined;
			cookie.domain = domain;
			cookie.hostOnly = false;
		} else if (key === 'path') {
			cookie.path = val.startsWith('/') ? val : defaultPath(url);
		} else if (key === 'secure') {
			cookie.secure = true;
		} else if (key === 'httponly') {
			cookie.httpOnly = true;
		}
	}
	if (maxAge !== undefined)
		cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
	if (cookie.secure && url.protocol !== 'https:') return undefined;
	if (name.startsWith('__Secure-') && !cookie.secure) return undefined;
	if (
		name.startsWith('__Host-') &&
		(!cookie.secure || !cookie.hostOnly || cookie.path !== '/')
	) {
		return undefined;
	}
	return cookie;
}

const same = (a: StoredCookie, b: StoredCookie) =>
	a.name === b.name && a.domain === b.domain && a.path === b.path;
const live = (c: StoredCookie, now: number) =>
	c.expires === undefined || c.expires > now;
const serialize = (cookies: readonly StoredCookie[]) =>
	cookies.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ');

/** A cookie store for one transport session. */
export class CookieStore {
	#cookies: StoredCookie[];

	constructor(cookies: readonly StoredCookie[] = []) {
		this.#cookies = cookies.map((c) => ({...c}));
	}

	/** Store the `Set-Cookie` values of a response from `url`. */
	store(url: URL, setCookies: readonly string[], now = Date.now()): void {
		for (const header of setCookies) {
			const cookie = parseSetCookie(header, url, now);
			if (cookie) this.#put(cookie, now);
		}
	}

	/**
	 * Apply `cookie` (what a script assigns to `document.cookie`) as the page
	 * at `url` would. False when rejected (as `document.cookie` silently does):
	 * invalid for `url` (the `Set-Cookie` rules), or it would replace an
	 * `HttpOnly` cookie.
	 */
	setFromScript(url: URL, cookie: string, now = Date.now()): boolean {
		const parsed = parseSetCookie(cookie, url, now);
		if (!parsed) return false;
		parsed.httpOnly = false;
		const httpOnly = this.#cookies.some(
			(c) => c.httpOnly && same(c, parsed) && live(c, now),
		);
		if (httpOnly) return false;
		this.#put(parsed, now);
		return true;
	}

	/** What `document.cookie` reads at `url`: the cookies sent to it, without the `HttpOnly` ones; '' when none. */
	documentCookie(url: URL, now = Date.now()): string {
		return serialize(this.#sent(url, now).filter((c) => !c.httpOnly));
	}

	/** Remove the cookies named `name` that `documentCookie(url)` shows (never an `HttpOnly` one). */
	deleteFromScript(url: URL, name: string, now = Date.now()): void {
		const gone = new Set(
			this.#sent(url, now).filter((c) => !c.httpOnly && c.name === name),
		);
		this.#cookies = this.#cookies.filter((c) => !gone.has(c));
	}

	/** The `cookie` header value for a request to `url`, or undefined when none apply. */
	header(url: URL, now = Date.now()): string | undefined {
		return serialize(this.#sent(url, now)) || undefined;
	}

	/** Store one parsed cookie, replacing (and keeping the creation time of) the same one; an expired one deletes it. */
	#put(cookie: StoredCookie, now: number): void {
		const old = this.#cookies.find((c) => same(c, cookie));
		if (old) cookie.created = old.created;
		this.#cookies = this.#cookies.filter((c) => !same(c, cookie));
		if (live(cookie, now)) this.#cookies.push(cookie);
	}

	/** The stored cookies (not copies) sent to `url`, in Chrome's order. */
	#sent(url: URL, now: number): StoredCookie[] {
		this.list(now);
		const host = url.hostname.toLowerCase();
		return this.#cookies
			.filter(
				(c) =>
					(c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) &&
					pathMatch(url.pathname, c.path) &&
					(!c.secure || url.protocol === 'https:'),
			)
			.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
	}

	/** The unexpired cookies, as plain JSON (for a state store). */
	list(now = Date.now()): StoredCookie[] {
		this.#cookies = this.#cookies.filter((c) => live(c, now));
		return this.#cookies.map((c) => ({...c}));
	}

	/** Drop every cookie. */
	clear(): void {
		this.#cookies = [];
	}
}

/**
 * A transport session's cookies as a page's script sees them
 * (`document.cookie`), each call acting as the page at `url` (an http(s)
 * URL, else a `recipe` error).
 */
export interface DocumentCookies {
	/** The `name=value; ...` string `document.cookie` reads at `url` (no `HttpOnly` cookie); '' when none. */
	get(url: string): string;
	/**
	 * Assign `cookie` (`name=value; Path=/; Secure; Max-Age=...`) as
	 * `document.cookie = cookie` would at `url`. True when applied, false when
	 * rejected as a browser silently would (see `CookieStore.setFromScript`).
	 */
	set(url: string, cookie: string): boolean;
	/** Remove the cookies named `name` that `get(url)` shows. */
	delete(url: string, name: string): void;
}

/** The `DocumentCookies` view of `jar` (URLs checked; `now` is the store's clock). */
export function documentCookies(
	jar: CookieStore,
	now: () => number = Date.now,
): DocumentCookies {
	const page = (url: string) => {
		let parsed: URL | undefined;
		try {
			parsed = new URL(url);
		} catch {
			parsed = undefined;
		}
		if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:')
			throw new SerpcastError('recipe', `not an http(s) URL: ${url}`);
		return parsed;
	};
	return {
		get: (url) => jar.documentCookie(page(url), now()),
		set: (url, cookie) => jar.setFromScript(page(url), String(cookie), now()),
		delete: (url, name) => jar.deleteFromScript(page(url), String(name), now()),
	};
}
