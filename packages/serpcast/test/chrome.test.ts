import {describe, expect, it} from 'vitest';
import {secChUa} from '../src/chrome.js';
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
