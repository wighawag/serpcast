import {describe, expect, it} from 'vitest';
import {parseSetCookie} from '../src/cookies.js';
import {CookieStore} from '../src/index.js';

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
