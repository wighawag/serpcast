import {describe, expect, it} from 'vitest';
import {parseSetCookie} from '../src/cookies.js';
import {CookieStore, documentCookies} from '../src/index.js';

const NOW = Date.UTC(2026, 8, 28);
const site = new URL('https://www.example.test/search/results?q=1');

describe('parseSetCookie', () => {
	it('defaults to a host-only session cookie on the directory of the path', () => {
		expect(parseSetCookie('a=1', site, NOW)).toEqual({
			name: 'a',
			value: '1',
			domain: 'www.example.test',
			hostOnly: true,
			path: '/search',
			secure: false,
			httpOnly: false,
			created: NOW,
		});
	});

	it('reads the attributes; max-age wins over expires', () => {
		const c = parseSetCookie(
			'b=2; Domain=.Example.test; Path=/; Secure; HttpOnly; SameSite=Lax; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Max-Age=60',
			site,
			NOW,
		);
		expect(c).toMatchObject({
			domain: 'example.test',
			hostOnly: false,
			path: '/',
			secure: true,
			httpOnly: true,
		});
		expect(c!.expires).toBe(NOW + 60_000);
	});

	it('rejects a Domain the host does not belong to, and a dotless one', () => {
		expect(parseSetCookie('a=1; Domain=other.test', site, NOW)).toBeUndefined();
		expect(parseSetCookie('a=1; Domain=test', site, NOW)).toBeUndefined();
	});

	it('rejects a Secure cookie over http and enforces the __Secure-/__Host- prefixes', () => {
		const http = new URL('http://www.example.test/');
		expect(parseSetCookie('a=1; Secure', http, NOW)).toBeUndefined();
		expect(parseSetCookie('__Secure-a=1', site, NOW)).toBeUndefined();
		expect(
			parseSetCookie(
				'__Host-a=1; Secure; Path=/; Domain=example.test',
				site,
				NOW,
			),
		).toBeUndefined();
		expect(
			parseSetCookie('__Host-a=1; Secure; Path=/', site, NOW),
		).toBeDefined();
	});
});

describe('CookieStore', () => {
	it('sends matching cookies, longest path first then oldest', () => {
		const jar = new CookieStore();
		jar.store(site, ['root=1; Path=/'], NOW);
		jar.store(site, ['deep=2; Path=/search'], NOW + 1);
		jar.store(site, ['later=3; Path=/'], NOW + 2);
		expect(jar.header(site, NOW + 3)).toBe('deep=2; root=1; later=3');
		expect(jar.header(new URL('https://www.example.test/other'), NOW + 3)).toBe(
			'root=1; later=3',
		);
	});

	it('scopes host-only and domain cookies', () => {
		const jar = new CookieStore();
		jar.store(
			site,
			['host=1; Path=/', 'dom=2; Path=/; Domain=example.test'],
			NOW,
		);
		expect(jar.header(new URL('https://api.example.test/'), NOW)).toBe('dom=2');
		expect(
			jar.header(new URL('https://example.test.evil/'), NOW),
		).toBeUndefined();
	});

	it('keeps Secure cookies off http', () => {
		const jar = new CookieStore();
		jar.store(site, ['s=1; Path=/; Secure'], NOW);
		expect(
			jar.header(new URL('http://www.example.test/'), NOW),
		).toBeUndefined();
	});

	it('replaces, expires and deletes', () => {
		const jar = new CookieStore();
		jar.store(site, ['a=1; Path=/; Max-Age=10'], NOW);
		jar.store(site, ['a=2; Path=/; Max-Age=10'], NOW + 1);
		expect(jar.header(site, NOW + 2)).toBe('a=2');
		expect(jar.list(NOW + 2)[0]!.created).toBe(NOW);
		expect(jar.header(site, NOW + 20_000)).toBeUndefined();
		jar.store(site, ['b=1; Path=/'], NOW);
		jar.store(site, ['b=; Path=/; Max-Age=0'], NOW);
		expect(jar.list(NOW)).toEqual([]);
	});

	it('round-trips through plain JSON', () => {
		const jar = new CookieStore();
		jar.store(site, ['a=1; Path=/'], NOW);
		const restored = new CookieStore(JSON.parse(JSON.stringify(jar.list(NOW))));
		expect(restored.header(site, NOW)).toBe('a=1');
		restored.clear();
		expect(restored.list(NOW)).toEqual([]);
	});
});

describe('CookieStore: document.cookie (a script at the page URL)', () => {
	it('applies the string as a Set-Cookie from the page, ignoring HttpOnly', () => {
		const jar = new CookieStore();
		expect(
			jar.setFromScript(site, 'a=1; Path=/; HttpOnly; SameSite=Lax', NOW),
		).toBe(true);
		expect(jar.list(NOW)).toEqual([
			{
				name: 'a',
				value: '1',
				domain: 'www.example.test',
				hostOnly: true,
				path: '/',
				secure: false,
				httpOnly: false,
				created: NOW,
			},
		]);
		expect(
			jar.setFromScript(site, 'd=1; Domain=example.test; Path=/', NOW),
		).toBe(true);
		expect(jar.header(new URL('https://api.example.test/'), NOW)).toBe('d=1');
	});

	it('rejects what the Set-Cookie rules reject, and a Secure cookie from http', () => {
		const jar = new CookieStore();
		expect(jar.setFromScript(site, 'a=1; Domain=other.test', NOW)).toBe(false);
		expect(
			jar.setFromScript(
				new URL('http://www.example.test/'),
				's=1; Secure',
				NOW,
			),
		).toBe(false);
		expect(jar.list(NOW)).toEqual([]);
	});

	it('never reads, replaces or deletes an HttpOnly cookie', () => {
		const jar = new CookieStore();
		jar.store(site, ['h=server; Path=/; HttpOnly', 'v=1; Path=/'], NOW);
		expect(jar.documentCookie(site, NOW)).toBe('v=1');
		expect(jar.setFromScript(site, 'h=script; Path=/', NOW)).toBe(false);
		jar.deleteFromScript(site, 'h', NOW);
		expect(jar.header(site, NOW)).toBe('h=server; v=1');
	});

	it('get shows what is sent to the URL, in order; delete removes those by name', () => {
		const jar = new CookieStore();
		jar.setFromScript(site, 'a=1; Path=/', NOW);
		jar.setFromScript(site, 'a=2; Path=/search', NOW + 1);
		jar.setFromScript(site, 'b=3; Path=/other', NOW + 2);
		expect(jar.documentCookie(site, NOW + 3)).toBe('a=2; a=1');
		expect(jar.documentCookie(new URL('https://x.test/'), NOW)).toBe('');
		jar.deleteFromScript(site, 'a', NOW + 3);
		expect(jar.list(NOW + 3).map((c) => c.name)).toEqual(['b']);
	});

	it('honours Max-Age: a positive one expires, 0 deletes', () => {
		const jar = new CookieStore();
		jar.setFromScript(site, 'm=1; Path=/; Max-Age=10', NOW);
		expect(jar.header(site, NOW + 9_000)).toBe('m=1');
		expect(jar.header(site, NOW + 10_000)).toBeUndefined();
		jar.setFromScript(site, 'n=1; Path=/', NOW);
		expect(jar.setFromScript(site, 'n=; Path=/; Max-Age=0', NOW)).toBe(true);
		expect(jar.list(NOW)).toEqual([]);
	});

	it('keeps a name with # (and other token characters) byte for byte', () => {
		const jar = new CookieStore();
		jar.setFromScript(site, "a#b!$%&'*+-.^_`|~=v#1; Path=/", NOW);
		jar.store(site, ['s#t=2; Path=/'], NOW + 1);
		expect(jar.header(site, NOW + 2)).toBe("a#b!$%&'*+-.^_`|~=v#1; s#t=2");
		const restored = new CookieStore(
			JSON.parse(JSON.stringify(jar.list(NOW + 2))),
		);
		expect(restored.documentCookie(site, NOW + 2)).toBe(
			"a#b!$%&'*+-.^_`|~=v#1; s#t=2",
		);
	});
});

describe('documentCookies', () => {
	it('takes string URLs and refuses a non-http(s) one as a recipe error', () => {
		const jar = new CookieStore();
		const doc = documentCookies(jar, () => NOW);
		expect(doc.set(site.href, 'a=1; Path=/')).toBe(true);
		expect(doc.get(site.href)).toBe('a=1');
		doc.delete(site.href, 'a');
		expect(doc.get(site.href)).toBe('');
		for (const bad of ['nope', 'file:///etc/passwd']) {
			expect(() => doc.set(bad, 'a=1')).toThrow(
				expect.objectContaining({kind: 'recipe'}),
			);
		}
	});
});
