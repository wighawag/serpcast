import {describe, expect, it} from 'vitest';
import {fetchSite, registrableDomain, secChUa} from '../src/chrome.js';
import {
	CHROME_MAJOR,
	headerTable,
	IMPERSONATE_TARGET,
	SerpcastError,
} from '../src/index.js';

const UA =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';
const SEC_CH_UA =
	'"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"';
const NAV_ACCEPT =
	'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const REFERER = 'https://example.test/search?q=x';

describe('pinned Chrome', () => {
	it('derives the impersonation target and the header tables from one version', () => {
		expect(CHROME_MAJOR).toBe(146);
		expect(IMPERSONATE_TARGET).toBe(`chrome${CHROME_MAJOR}`);
		for (const kind of ['document', 'fetch'] as const) {
			const table = Object.fromEntries(headerTable(kind, {referer: REFERER}));
			expect(table['user-agent']).toContain(`Chrome/${CHROME_MAJOR}.0.0.0`);
			expect(table['sec-ch-ua']).toBe(secChUa(CHROME_MAJOR));
		}
	});

	it("computes sec-ch-ua with Chromium's brand GREASE (known Chrome values)", () => {
		expect(secChUa(146)).toBe(SEC_CH_UA); // also embedded in libcurl-impersonate 2.1.1's chrome146
		expect(secChUa(120)).toBe(
			'"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
		);
		expect(secChUa(124)).toBe(
			'"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
		);
	});
});

describe('header tables (Chrome 146, Linux; the finding impers-fingerprint-vs-curl-cffi)', () => {
	it('document', () => {
		expect(headerTable('document', {})).toEqual([
			['sec-ch-ua', SEC_CH_UA],
			['sec-ch-ua-mobile', '?0'],
			['sec-ch-ua-platform', '"Linux"'],
			['upgrade-insecure-requests', '1'],
			['user-agent', UA],
			['accept', NAV_ACCEPT],
			['sec-fetch-site', 'none'],
			['sec-fetch-mode', 'navigate'],
			['sec-fetch-user', '?1'],
			['sec-fetch-dest', 'document'],
			['accept-encoding', 'gzip, deflate, br, zstd'],
			['accept-language', 'en-US,en;q=0.9'],
			['priority', 'u=0, i'],
		]);
	});

	it('same-origin-navigation', () => {
		expect(headerTable('same-origin-navigation', {referer: REFERER})).toEqual([
			['sec-ch-ua', SEC_CH_UA],
			['sec-ch-ua-mobile', '?0'],
			['sec-ch-ua-platform', '"Linux"'],
			['upgrade-insecure-requests', '1'],
			['user-agent', UA],
			['accept', NAV_ACCEPT],
			['sec-fetch-site', 'same-origin'],
			['sec-fetch-mode', 'navigate'],
			['sec-fetch-user', '?1'],
			['sec-fetch-dest', 'document'],
			['referer', REFERER],
			['accept-encoding', 'gzip, deflate, br, zstd'],
			['accept-language', 'en-US,en;q=0.9'],
			['priority', 'u=0, i'],
		]);
	});

	it('fetch', () => {
		expect(headerTable('fetch', {referer: REFERER})).toEqual([
			['sec-ch-ua-platform', '"Linux"'],
			['user-agent', UA],
			['sec-ch-ua', SEC_CH_UA],
			['sec-ch-ua-mobile', '?0'],
			['accept', '*/*'],
			['sec-fetch-site', 'same-origin'],
			['sec-fetch-mode', 'cors'],
			['sec-fetch-dest', 'empty'],
			['referer', REFERER],
			['accept-encoding', 'gzip, deflate, br, zstd'],
			['accept-language', 'en-US,en;q=0.9'],
			['priority', 'u=1, i'],
		]);
	});

	it('script (no priority header)', () => {
		expect(headerTable('script', {referer: REFERER})).toEqual([
			['sec-ch-ua-platform', '"Linux"'],
			['user-agent', UA],
			['sec-ch-ua', SEC_CH_UA],
			['sec-ch-ua-mobile', '?0'],
			['accept', '*/*'],
			['sec-fetch-site', 'same-origin'],
			['sec-fetch-mode', 'no-cors'],
			['sec-fetch-dest', 'script'],
			['referer', REFERER],
			['accept-encoding', 'gzip, deflate, br, zstd'],
			['accept-language', 'en-US,en;q=0.9'],
		]);
	});

	it('puts cookie between accept-language and priority, and last for script', () => {
		const names = (kind: 'document' | 'fetch' | 'script') =>
			headerTable(kind, {referer: REFERER, cookie: 'a=1'}).map(
				([name]) => name,
			);
		expect(names('document').slice(-3)).toEqual([
			'accept-language',
			'cookie',
			'priority',
		]);
		expect(names('fetch').slice(-3)).toEqual([
			'accept-language',
			'cookie',
			'priority',
		]);
		expect(names('script').slice(-2)).toEqual(['accept-language', 'cookie']);
	});

	it('refuses a page-initiated kind without a referer (a recipe error)', () => {
		for (const kind of ['same-origin-navigation', 'fetch', 'script'] as const) {
			const error = (() => {
				try {
					headerTable(kind, {});
				} catch (e) {
					return e;
				}
			})();
			expect(error).toBeInstanceOf(SerpcastError);
			expect(error).toMatchObject({kind: 'recipe'});
		}
	});
});

// work/notes/findings/sec-fetch-site-by-initiator.md: from the page
// https://www.example.com:39383/page?q=x, credentialed (as serpcast always is).
describe('same-site and cross-site tables (the finding sec-fetch-site-by-initiator)', () => {
	const PAGE = 'https://www.example.com:39383/page?q=x';
	const HINTS: [string, string][] = [
		['sec-ch-ua-platform', '"Linux"'],
		['user-agent', UA],
		['sec-ch-ua', SEC_CH_UA],
		['sec-ch-ua-mobile', '?0'],
	];
	const TAIL: [string, string][] = [
		['accept-encoding', 'gzip, deflate, br, zstd'],
		['accept-language', 'en-US,en;q=0.9'],
		['cookie', 'a=1'],
	];

	it('script, same-site (sibling subdomain, or another port)', () => {
		const expected = [
			...HINTS,
			['accept', '*/*'],
			['sec-fetch-site', 'same-site'],
			['sec-fetch-mode', 'no-cors'],
			['sec-fetch-dest', 'script'],
			['referer', 'https://www.example.com:39383/'],
			...TAIL,
		];
		for (const url of [
			'https://cdn.example.com:39383/x.js',
			'https://www.example.com:39871/x.js',
		]) {
			expect(
				headerTable('script', {referer: PAGE, url, cookie: 'a=1'}),
			).toEqual(expected);
		}
	});

	it('script, cross-site', () => {
		expect(
			headerTable('script', {
				referer: PAGE,
				url: 'https://www.example.net:39383/x.js',
				cookie: 'a=1',
			}),
		).toEqual([
			...HINTS,
			['accept', '*/*'],
			['sec-fetch-site', 'cross-site'],
			['sec-fetch-mode', 'no-cors'],
			['sec-fetch-dest', 'script'],
			['sec-fetch-storage-access', 'active'],
			['referer', 'https://www.example.com:39383/'],
			...TAIL,
		]);
	});

	it('fetch, same-site', () => {
		expect(
			headerTable('fetch', {
				referer: PAGE,
				url: 'https://cdn.example.com:39383/api',
				cookie: 'a=1',
			}),
		).toEqual([
			...HINTS,
			['accept', '*/*'],
			['origin', 'https://www.example.com:39383'],
			['sec-fetch-site', 'same-site'],
			['sec-fetch-mode', 'cors'],
			['sec-fetch-dest', 'empty'],
			['referer', 'https://www.example.com:39383/'],
			...TAIL,
			['priority', 'u=1, i'],
		]);
	});

	it('fetch, cross-site', () => {
		expect(
			headerTable('fetch', {
				referer: PAGE,
				url: 'https://www.example.net:39383/api',
				cookie: 'a=1',
			}),
		).toEqual([
			...HINTS,
			['accept', '*/*'],
			['origin', 'https://www.example.com:39383'],
			['sec-fetch-site', 'cross-site'],
			['sec-fetch-mode', 'cors'],
			['sec-fetch-dest', 'empty'],
			['sec-fetch-storage-access', 'active'],
			['referer', 'https://www.example.com:39383/'],
			...TAIL,
			['priority', 'u=1, i'],
		]);
	});

	it('a same-origin url gives the same-origin table, full referer', () => {
		for (const kind of ['fetch', 'script'] as const) {
			expect(
				headerTable(kind, {
					referer: PAGE,
					url: 'https://www.example.com:39383/api',
				}),
			).toEqual(headerTable(kind, {referer: PAGE}));
		}
	});

	it('fetchSite overrides the derivation, and the dependent headers follow it', () => {
		const derived = headerTable('fetch', {
			referer: 'https://alice.github.io/page',
			url: 'https://bob.github.io/api',
		});
		expect(Object.fromEntries(derived)['sec-fetch-site']).toBe('same-site');
		const overridden = headerTable('fetch', {
			referer: 'https://alice.github.io/page',
			url: 'https://bob.github.io/api',
			fetchSite: 'cross-site',
		});
		expect(Object.fromEntries(overridden)).toMatchObject({
			origin: 'https://alice.github.io',
			'sec-fetch-site': 'cross-site',
			'sec-fetch-storage-access': 'active',
			referer: 'https://alice.github.io/',
		});
		expect(
			headerTable('script', {
				referer: PAGE,
				url: 'https://www.example.net/x.js',
				fetchSite: 'same-origin',
			}),
		).toEqual(headerTable('script', {referer: PAGE}));
	});

	it('keeps navigations as they were: document none, same-origin-navigation same-origin', () => {
		expect(
			headerTable('same-origin-navigation', {
				referer: PAGE,
				url: 'https://www.example.net/',
			}),
		).toEqual(headerTable('same-origin-navigation', {referer: PAGE}));
		expect(headerTable('document', {url: 'https://www.example.net/'})).toEqual(
			headerTable('document', {}),
		);
	});

	it('refuses a fetchSite the kind cannot have, and a relative referer it must parse (recipe errors)', () => {
		const attempts = [
			() => headerTable('document', {fetchSite: 'same-origin'}),
			() =>
				headerTable('same-origin-navigation', {
					referer: PAGE,
					fetchSite: 'same-site',
				}),
			() =>
				headerTable('fetch', {
					referer: PAGE,
					fetchSite: 'nearby' as never,
				}),
			() => headerTable('fetch', {referer: '/page', url: 'https://x.test/'}),
		];
		for (const attempt of attempts) {
			expect(attempt).toThrow(SerpcastError);
			try {
				attempt();
			} catch (error) {
				expect(error).toMatchObject({kind: 'recipe'});
			}
		}
	});
});

describe('fetchSite derivation', () => {
	it.each([
		['https://www.example.com/a', 'https://www.example.com/b?q', 'same-origin'],
		[
			'https://www.example.com:443/a',
			'https://www.example.com/b',
			'same-origin',
		],
		['https://cdn.example.com/x.js', 'https://www.example.com/', 'same-site'],
		['https://example.com/x.js', 'https://www.example.com/', 'same-site'],
		['https://www.example.com:8443/', 'https://www.example.com/', 'same-site'],
		['https://www.example.com/', 'http://www.example.com/', 'cross-site'],
		['http://cdn.example.com/', 'https://www.example.com/', 'cross-site'],
		['https://www.example.net/', 'https://www.example.com/', 'cross-site'],
		['https://b.example.co.uk/', 'https://a.example.co.uk/', 'same-site'],
		['https://bob.co.uk/', 'https://alice.co.uk/', 'cross-site'],
		['https://x.shop.com.au/', 'https://shop.com.au/', 'same-site'],
		['https://localhost:2/', 'https://localhost:1/', 'same-site'],
		['https://127.0.0.2/', 'https://127.0.0.1/', 'cross-site'],
		['https://[::1]:2/', 'https://[::1]:1/', 'same-site'],
		['https://WWW.Example.COM./', 'https://cdn.example.com/', 'same-site'],
	] as const)('%s from %s is %s', (url, referer, expected) => {
		expect(fetchSite(url, referer)).toBe(expected);
	});

	it('documented limit: private suffixes are not known (github.io comes out same-site; Chrome says cross-site)', () => {
		expect(registrableDomain('alice.github.io')).toBe('github.io');
		expect(
			fetchSite('https://bob.github.io/', 'https://alice.github.io/'),
		).toBe('same-site');
	});

	it('registrableDomain', () => {
		expect(registrableDomain('a.b.example.com')).toBe('example.com');
		expect(registrableDomain('a.example.co.uk')).toBe('example.co.uk');
		expect(registrableDomain('example.co.uk')).toBe('example.co.uk');
		expect(registrableDomain('co.uk')).toBe('co.uk');
		expect(registrableDomain('www.example.co')).toBe('example.co');
		expect(registrableDomain('localhost')).toBe('localhost');
		expect(registrableDomain('192.168.1.2')).toBe('192.168.1.2');
	});
});
