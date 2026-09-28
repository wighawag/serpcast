// The transport session's cookies. serpcast owns them (libcurl's cookie engine
// is never used) so the `cookie` header lands where Chrome puts it in the
// header table. RFC 6265 storage and matching, Chrome's send order (longest
// path first, then oldest). SameSite is not enforced: every request kind
// serpcast sends is same-site. There is no public suffix list, so a `Domain`
// attribute must equal the host or contain a dot.

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
			if (!cookie) continue;
			const same = (c: StoredCookie) =>
				c.name === cookie.name &&
				c.domain === cookie.domain &&
				c.path === cookie.path;
			const old = this.#cookies.find(same);
			if (old) cookie.created = old.created;
			this.#cookies = this.#cookies.filter((c) => !same(c));
			if (cookie.expires === undefined || cookie.expires > now)
				this.#cookies.push(cookie);
		}
	}

	/** The `cookie` header value for a request to `url`, or undefined when none apply. */
	header(url: URL, now = Date.now()): string | undefined {
		const host = url.hostname.toLowerCase();
		const sent = this.list(now)
			.filter(
				(c) =>
					(c.hostOnly ? host === c.domain : domainMatch(host, c.domain)) &&
					pathMatch(url.pathname, c.path) &&
					(!c.secure || url.protocol === 'https:'),
			)
			.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
		return sent.length
			? sent.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join('; ')
			: undefined;
	}

	/** The unexpired cookies, as plain JSON (for a state store). */
	list(now = Date.now()): StoredCookie[] {
		this.#cookies = this.#cookies.filter(
			(c) => c.expires === undefined || c.expires > now,
		);
		return this.#cookies.map((c) => ({...c}));
	}

	/** Drop every cookie. */
	clear(): void {
		this.#cookies = [];
	}
}
