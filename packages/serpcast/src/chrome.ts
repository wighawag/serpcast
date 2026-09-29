// The pinned browser identity: the libcurl-impersonate target (TLS and HTTP/2
// side) and the header tables (header side) both derive from CHROME_MAJOR, so
// they cannot drift apart (ADR 0001). Upgrading Chrome means changing
// CHROME_MAJOR and re-checking every table against a capture of that version.
//
// Source of the tables: work/notes/findings/impers-fingerprint-vs-curl-cffi.md
// (net-log capture of real Chromium on Linux, 2026-09-28; order and per-kind
// structure), with branded Chrome values on Linux. Same-site and cross-site
// `fetch` and `script`: work/notes/findings/sec-fetch-site-by-initiator.md
// (2026-09-29). Not measured, so not offered: navigations to another origin,
// POST, non-English `accept-language`.

import {SerpcastError} from './errors.js';

/** The pinned Chrome major version. */
export const CHROME_MAJOR = 146;

/** The libcurl-impersonate target, never the moving `chrome` alias. */
export const IMPERSONATE_TARGET = `chrome${CHROME_MAJOR}`;

/**
 * What a request is from the browser's point of view; selects its header
 * table. `document` is a typed-URL top-level navigation, the other kinds come
 * from a page and carry that page as `referer`.
 */
export type RequestKind =
	'document' | 'same-origin-navigation' | 'fetch' | 'script';

export const REQUEST_KINDS: readonly RequestKind[] = [
	'document',
	'same-origin-navigation',
	'fetch',
	'script',
];

/**
 * The `sec-ch-ua` value Chrome sends for a major version: Chromium's brand
 * GREASE, seeded by the major version (`GenerateBrandVersionList` and
 * `GetGreasedUserAgentBrandVersion` in
 * components/embedder_support/user_agent_utils.cc).
 */
export function secChUa(major: number): string {
	const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
	const versions = ['8', '99', '24'];
	const orders = [
		[0, 1, 2],
		[0, 2, 1],
		[1, 0, 2],
		[1, 2, 0],
		[2, 0, 1],
		[2, 1, 0],
	];
	const grease = `"Not${chars[major % 11]}A${chars[(major + 1) % 11]}Brand";v="${versions[major % 3]}"`;
	const order = orders[major % 6];
	const list: string[] = [];
	list[order[0]] = grease;
	list[order[1]] = `"Chromium";v="${major}"`;
	list[order[2]] = `"Google Chrome";v="${major}"`;
	return list.join(', ');
}

const UA = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
const SEC_CH_UA = secChUa(CHROME_MAJOR);
const NAV_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';
const ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/** A header table: ordered `[name, value]` pairs, sent exactly as listed. */
export type HeaderTable = [name: string, value: string][];

/**
 * How a page-initiated request relates to the page it comes from (its
 * `referer`): the value of Chrome's `sec-fetch-site` header.
 */
export type FetchSite = 'same-origin' | 'same-site' | 'cross-site';

export const FETCH_SITES: readonly FetchSite[] = [
	'same-origin',
	'same-site',
	'cross-site',
];

/**
 * Second-level labels that, under a two-letter country TLD, are part of the
 * public suffix (`example.co.uk`, `example.com.au`, `example.ac.jp`).
 */
const CC_SECOND_LEVEL = new Set([
	'ac',
	'co',
	'com',
	'edu',
	'go',
	'gob',
	'gov',
	'ltd',
	'mil',
	'ne',
	'net',
	'or',
	'org',
	'plc',
	'sch',
]);

/**
 * The registrable domain ("site" without the scheme) of a host, by a small
 * built-in rule instead of the public suffix list (which serpcast does not
 * ship): an IP address or a single-label host is its own site; otherwise the
 * last two labels, or the last three when the TLD has two letters and the
 * label before it is a common second level (`co.uk`, `com.au`, ...).
 *
 * Known limit: private suffixes (`github.io`, hosting platforms) and the
 * rarer public ones are not known, so two customers of one platform
 * (`alice.github.io`, `bob.github.io`) come out `same-site` where Chrome says
 * `cross-site`. A caller who knows better passes `fetchSite` explicitly.
 */
export function registrableDomain(host: string): string {
	const name = host.toLowerCase().replace(/\.$/, '');
	if (name.startsWith('[') || /^[\d.]+$/.test(name)) return name;
	const labels = name.split('.');
	const tld = labels.at(-1)!;
	const keep =
		labels.length >= 3 &&
		tld.length === 2 &&
		CC_SECOND_LEVEL.has(labels.at(-2)!)
			? 3
			: 2;
	return labels.slice(-keep).join('.');
}

/**
 * `sec-fetch-site` for a request to `url` from the page `referer`, as Chrome
 * computes it: same scheme, host and port is `same-origin`; same scheme and
 * registrable domain (any port) is `same-site` (sites are schemeful: `http`
 * to `https` is `cross-site`); anything else is `cross-site`.
 */
export function fetchSite(url: string | URL, referer: string | URL): FetchSite {
	const target = new URL(url);
	const page = new URL(referer);
	if (target.origin === page.origin) return 'same-origin';
	if (
		target.protocol === page.protocol &&
		registrableDomain(target.hostname) === registrableDomain(page.hostname)
	) {
		return 'same-site';
	}
	return 'cross-site';
}

function pageUrl(kind: RequestKind, referer: string): URL {
	try {
		return new URL(referer);
	} catch {
		throw new SerpcastError(
			'recipe',
			`a ${kind} request to another origin needs an absolute referer URL, got ${JSON.stringify(referer)}`,
		);
	}
}

/**
 * The exact headers Chrome sends for `kind`, in order. `cookie` (when the
 * session has any) goes where Chrome puts it: after `accept-language`, before
 * `priority` (last for `script`, which has no `priority`).
 *
 * For `fetch` and `script`, `sec-fetch-site` is `context.fetchSite` when
 * given, else derived from `context.url` relative to the `referer` (see
 * `fetchSite()`), else `same-origin`. A request that is not same-origin sends
 * the page's origin as `referer` (Chrome's default `strict-origin-when-cross-
 * origin`), and a `fetch` adds `origin`; a cross-site one adds
 * `sec-fetch-storage-access: active` (a credentialed request, as serpcast
 * always sends the session's cookies). `same-origin-navigation` is always
 * same-origin and `document` always `none`.
 */
export function headerTable(
	kind: RequestKind,
	context: {
		referer?: string;
		cookie?: string;
		/** The request URL, to derive `sec-fetch-site` from. */
		url?: string | URL;
		/** Overrides the derived `sec-fetch-site` (`fetch` and `script` only). */
		fetchSite?: FetchSite;
	},
): HeaderTable {
	const {referer, cookie} = context;
	if (kind !== 'document' && !referer) {
		throw new SerpcastError(
			'recipe',
			`a ${kind} request needs a referer (the page it comes from)`,
		);
	}
	if (context.fetchSite !== undefined) {
		const allowed: readonly FetchSite[] =
			kind === 'fetch' || kind === 'script' ? FETCH_SITES : ['same-origin'];
		if (kind === 'document' || !allowed.includes(context.fetchSite)) {
			throw new SerpcastError(
				'recipe',
				`fetchSite ${JSON.stringify(context.fetchSite)} is not allowed for a ${kind} request (${kind === 'document' ? 'none' : allowed.join(', ')})`,
			);
		}
	}
	const tail = (priority?: string): HeaderTable => [
		['accept-encoding', ACCEPT_ENCODING],
		['accept-language', ACCEPT_LANGUAGE],
		...(cookie ? [['cookie', cookie] as [string, string]] : []),
		...(priority ? [['priority', priority] as [string, string]] : []),
	];
	if (kind === 'document' || kind === 'same-origin-navigation') {
		return [
			['sec-ch-ua', SEC_CH_UA],
			['sec-ch-ua-mobile', '?0'],
			['sec-ch-ua-platform', '"Linux"'],
			['upgrade-insecure-requests', '1'],
			['user-agent', UA],
			['accept', NAV_ACCEPT],
			['sec-fetch-site', kind === 'document' ? 'none' : 'same-origin'],
			['sec-fetch-mode', 'navigate'],
			['sec-fetch-user', '?1'],
			['sec-fetch-dest', 'document'],
			...(kind === 'document'
				? []
				: [['referer', referer!] as [string, string]]),
			...tail('u=0, i'),
		];
	}
	const site =
		context.fetchSite ??
		(context.url === undefined
			? 'same-origin'
			: fetchSite(context.url, pageUrl(kind, referer!)));
	const origin = site === 'same-origin' ? '' : pageUrl(kind, referer!).origin;
	return [
		['sec-ch-ua-platform', '"Linux"'],
		['user-agent', UA],
		['sec-ch-ua', SEC_CH_UA],
		['sec-ch-ua-mobile', '?0'],
		['accept', '*/*'],
		...(kind === 'fetch' && origin
			? [['origin', origin] as [string, string]]
			: []),
		['sec-fetch-site', site],
		['sec-fetch-mode', kind === 'fetch' ? 'cors' : 'no-cors'],
		['sec-fetch-dest', kind === 'fetch' ? 'empty' : 'script'],
		...(site === 'cross-site'
			? [['sec-fetch-storage-access', 'active'] as [string, string]]
			: []),
		['referer', origin ? `${origin}/` : referer!],
		...tail(kind === 'fetch' ? 'u=1, i' : undefined),
	];
}
