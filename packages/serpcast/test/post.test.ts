// POST requests (a page's `fetch()` POST) and their CORS preflight, through
// the real native library against a local HTTP/2 server: the exact captured
// header tables on the wire (work/notes/findings/post-requests.md), the
// preflight on a connection of its own, its cache and its refusals. Skipped
// without SERPCAST_LIBCURL_PATH, like the other native tests.

import type http2 from 'node:http2';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	createTransport,
	headerTable,
	MAX_REQUEST_BODY_BYTES,
	preflightTable,
	SerpcastError,
} from '../src/index.js';
import {
	CA_PATH,
	headersFrames,
	startH2Server,
	type H2Server,
} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;

interface Seen {
	method: string;
	path: string;
	/** Header names and values, pseudo-headers excluded, in wire order. */
	headers: string[];
	body: Buffer;
	/** Which connection it came on (1, 2, ... in accept order). */
	connection: number;
}

describe.skipIf(!LIB)('POST (native libcurl-impersonate)', () => {
	let server: H2Server;
	const seen: Seen[] = [];
	const connections = new WeakMap<object, number>();
	let nextConnection = 1;
	const transport = createTransport({libcurlPath: LIB, caPath: CA_PATH});
	const url = (path: string) => `https://localhost:${server.port}${path}`;
	const at = (method: string, path: string) =>
		seen.filter((s) => s.method === method && s.path === path);

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				const session = (req.stream as http2.ServerHttp2Stream).session!;
				if (!connections.has(session))
					connections.set(session, nextConnection++);
				const raw = req.rawHeaders;
				seen.push({
					method: req.method,
					path: req.url,
					headers: raw.slice(8),
					body: Buffer.concat(chunks),
					connection: connections.get(session)!,
				});
				const origin = req.headers.origin;
				if (req.url === '/set-cookie')
					res.setHeader('set-cookie', 'sid=abc; Path=/; SameSite=None; Secure');
				if (req.method === 'OPTIONS') {
					if (req.url.startsWith('/forbidden')) res.statusCode = 403;
					else if (!req.url.startsWith('/no-cors')) {
						res.setHeader('access-control-allow-origin', origin!);
						res.setHeader('access-control-allow-credentials', 'true');
						res.setHeader('access-control-allow-headers', 'Content-Type');
					}
					if (req.url.startsWith('/max-age-0'))
						res.setHeader('access-control-max-age', '0');
					res.statusCode = res.statusCode === 403 ? 403 : 204;
					res.end();
					return;
				}
				if (origin) {
					res.setHeader('access-control-allow-origin', origin);
					res.setHeader('access-control-allow-credentials', 'true');
				}
				res.setHeader('content-type', 'application/json');
				res.end(JSON.stringify({length: Buffer.concat(chunks).length}));
			});
		});
		await transport.check();
	});
	afterAll(() => server?.close());

	const pages = {
		'same-origin': () => url('/page?q=x'),
		'same-site': () => 'https://localhost:1/page?q=x', // another port
		'cross-site': () => 'https://example.test/page?q=x',
	} as const;
	const bodies = {
		json: ['application/json', '{"a":1,"b":"x"}'],
		form: ['application/x-www-form-urlencoded', 'a=1&b=x'],
	} as const;

	for (const site of ['same-origin', 'same-site', 'cross-site'] as const) {
		for (const kind of ['json', 'form'] as const) {
			it(`sends exactly the captured POST ${kind} table, ${site}, with the preflight Chrome would send`, async () => {
				const referer = pages[site]();
				const [contentType, body] = bodies[kind];
				const path = `/post/${site}/${kind}`;
				const response = await transport.session().request(url(path), {
					kind: 'fetch',
					method: 'POST',
					referer,
					body,
					contentType,
				});
				expect(response.status).toBe(200);
				const [post] = at('POST', path);
				expect(post!.headers).toEqual(
					headerTable('fetch', {
						referer,
						url: url(path),
						method: 'POST',
						contentType,
						contentLength: body.length,
					}).flat(),
				);
				expect(post!.body.toString()).toBe(body);
				const expected = preflightTable({referer, url: url(path), contentType});
				const preflights = at('OPTIONS', path);
				if (kind === 'json' && site !== 'same-origin') {
					expect(expected).toBeDefined();
					expect(preflights).toHaveLength(1);
					expect(preflights[0]!.headers).toEqual(expected!.flat());
					expect(preflights[0]!.body.length).toBe(0);
					expect(seen.indexOf(preflights[0]!)).toBeLessThan(
						seen.indexOf(post!),
					);
					// Chrome sends the credential-less preflight on its own connection.
					expect(preflights[0]!.connection).not.toBe(post!.connection);
				} else {
					expect(expected).toBeUndefined();
					expect(preflights).toHaveLength(0);
				}
			});
		}
	}

	it('sends the session cookie with the POST, never with the preflight', async () => {
		const session = transport.session();
		await session.request(url('/set-cookie'), {kind: 'document'});
		const path = '/post/cookie';
		await session.request(url(path), {
			kind: 'fetch',
			method: 'POST',
			referer: pages['cross-site'](),
			body: '{}',
			contentType: 'application/json',
		});
		const [preflight] = at('OPTIONS', path);
		const [post] = at('POST', path);
		expect(preflight!.headers).not.toContain('cookie');
		expect(post!.headers[post!.headers.indexOf('cookie') + 1]).toBe('sid=abc');
	});

	it('remembers an allowed preflight per page origin and URL (default 5 s); max-age 0 is not remembered', async () => {
		const session = transport.session();
		const post = (path: string, referer = pages['same-site']()) =>
			session.request(url(path), {
				kind: 'fetch',
				method: 'POST',
				referer,
				body: '{}',
				contentType: 'application/json',
			});
		await post('/cached');
		await post('/cached');
		expect(at('OPTIONS', '/cached')).toHaveLength(1);
		expect(at('POST', '/cached')).toHaveLength(2);
		await post('/cached', pages['cross-site']()); // another page origin
		expect(at('OPTIONS', '/cached')).toHaveLength(2);
		await post('/max-age-0');
		await post('/max-age-0');
		expect(at('OPTIONS', '/max-age-0')).toHaveLength(2);
		// Another session knows nothing of this one's preflights.
		await transport.session().request(url('/cached'), {
			kind: 'fetch',
			method: 'POST',
			referer: pages['same-site'](),
			body: '{}',
			contentType: 'application/json',
		});
		expect(at('OPTIONS', '/cached')).toHaveLength(3);
	});

	it('does not send the POST when the preflight refuses it (recipe error; 403 is blocked)', async () => {
		const attempt = (path: string) =>
			transport.session().request(url(path), {
				kind: 'fetch',
				method: 'POST',
				referer: pages['cross-site'](),
				body: '{}',
				contentType: 'application/json',
			});
		await expect(attempt('/no-cors')).rejects.toMatchObject({kind: 'recipe'});
		await expect(attempt('/forbidden')).rejects.toMatchObject({
			kind: 'blocked',
		});
		expect(at('OPTIONS', '/no-cors')).toHaveLength(1);
		expect(at('POST', '/no-cors')).toHaveLength(0);
		expect(at('POST', '/forbidden')).toHaveLength(0);
	});

	it('sends bytes as given with no content-type, a string without one as text/plain;charset=UTF-8, and an empty body', async () => {
		const session = transport.session();
		const referer = pages['same-origin']();
		const bytes = new Uint8Array([0, 1, 2, 255]);
		await session.request(url('/bytes'), {
			kind: 'fetch',
			method: 'POST',
			referer,
			body: bytes,
		});
		const [binary] = at('POST', '/bytes');
		expect([...binary!.body]).toEqual([...bytes]);
		expect(binary!.headers).toEqual(
			headerTable('fetch', {
				referer,
				url: url('/bytes'),
				method: 'POST',
				contentLength: 4,
			}).flat(),
		);

		await session.request(url('/string'), {
			kind: 'fetch',
			method: 'POST',
			referer,
			body: 'héllo',
		});
		const [text] = at('POST', '/string');
		expect(text!.body.toString()).toBe('héllo');
		const header = (s: Seen, name: string) =>
			s.headers[s.headers.indexOf(name) + 1];
		expect(header(text!, 'content-type')).toBe('text/plain;charset=UTF-8');
		expect(header(text!, 'content-length')).toBe('6');

		await session.request(url('/empty'), {
			kind: 'fetch',
			method: 'POST',
			referer,
		});
		const [empty] = at('POST', '/empty');
		expect(empty!.body.length).toBe(0);
		expect(header(empty!, 'content-length')).toBe('0');
		expect(empty!.headers).not.toContain('content-type');
	});

	it('ends the stream on the HEADERS frame for an empty POST only, as Chrome does (PRIORITY flag on both)', async () => {
		const before = server.received.length;
		const session = transport.session();
		const referer = pages['same-origin']();
		await session.request(url('/frame/empty'), {
			kind: 'fetch',
			method: 'POST',
			referer,
		});
		await session.request(url('/frame/body'), {
			kind: 'fetch',
			method: 'POST',
			referer,
			body: 'abc',
		});
		expect(server.received.length).toBe(before + 1); // one connection
		const [empty, body] = headersFrames(server.received[before]!);
		expect(empty!.flags & 0x1).toBe(0x1); // END_STREAM
		expect(body!.flags & 0x1).toBe(0);
		for (const frame of [empty!, body!]) {
			expect(frame.flags & 0x20).toBe(0x20);
			expect(frame.exclusive).toBe(true);
			expect(frame.weight).toBe(256);
		}
	});

	it('refuses, before sending anything, a body over the cap, a POST that is not fetch, and a bad body or method (recipe errors)', async () => {
		const session = transport.session();
		const referer = pages['same-origin']();
		const attempts = [
			{
				kind: 'fetch',
				method: 'POST',
				referer,
				body: new Uint8Array(MAX_REQUEST_BODY_BYTES + 1),
			},
			{kind: 'script', method: 'POST', referer, body: 'x'},
			{kind: 'fetch', method: 'POST', referer, body: {a: 1}},
			{kind: 'fetch', method: 'PUT', referer, body: 'x'},
			{kind: 'fetch', method: 'POST', referer, contentType: 'a\r\nb: c'},
		];
		for (const attempt of attempts) {
			const error = await session
				.request(url('/refused'), attempt as never)
				.catch((e: unknown) => e);
			expect(error).toBeInstanceOf(SerpcastError);
			expect(error).toMatchObject({kind: 'recipe'});
		}
		expect(seen.filter((s) => s.path === '/refused')).toHaveLength(0);
	});
});
