// The pinned browser identity: the libcurl-impersonate target (TLS and HTTP/2
// side) and the header tables (header side) both derive from CHROME_MAJOR, so
// they cannot drift apart (ADR 0001). Upgrading Chrome means changing
// CHROME_MAJOR and re-checking every table against a capture of that version.
//
// Source of the tables: work/notes/findings/impers-fingerprint-vs-curl-cffi.md
// (net-log capture of real Chromium on Linux, 2026-09-28; order and per-kind
// structure), with branded Chrome values on Linux. Not measured, so not
// offered: cross-site requests, POST, non-English `accept-language`.

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
 * The exact headers Chrome sends for `kind`, in order. `cookie` (when the
 * session has any) goes where Chrome puts it: after `accept-language`, before
 * `priority` (last for `script`, which has no `priority`).
 */
export function headerTable(
	kind: RequestKind,
	context: {referer?: string; cookie?: string},
): HeaderTable {
	const {referer, cookie} = context;
	if (kind !== 'document' && !referer) {
		throw new SerpcastError(
			'recipe',
			`a ${kind} request needs a referer (the page it comes from)`,
		);
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
	return [
		['sec-ch-ua-platform', '"Linux"'],
		['user-agent', UA],
		['sec-ch-ua', SEC_CH_UA],
		['sec-ch-ua-mobile', '?0'],
		['accept', '*/*'],
		['sec-fetch-site', 'same-origin'],
		['sec-fetch-mode', kind === 'fetch' ? 'cors' : 'no-cors'],
		['sec-fetch-dest', kind === 'fetch' ? 'empty' : 'script'],
		['referer', referer!],
		...tail(kind === 'fetch' ? 'u=1, i' : undefined),
	];
}
