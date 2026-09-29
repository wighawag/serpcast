// A code recipe in the engine chain through the real transport
// (libcurl-impersonate): its requests take the caller's proxy, carry the
// header table of their kind and share the engine's cookies. Skipped without
// SERPCAST_LIBCURL_PATH, like the other native tests (see test/native-notice.ts).

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createSerpcast, headerTable, type CodeRecipe} from '../src/index.js';
import {
	CA_PATH,
	startConnectProxy,
	startH2Server,
	type H2Server,
	type RecordingProxy,
} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;

describe.skipIf(!LIB)('code recipes (native libcurl-impersonate)', () => {
	let server: H2Server;
	let proxy: RecordingProxy;
	const seen: {path: string; headers: string[]; body?: string}[] = [];

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			if (req.method === 'POST') {
				const chunks: Buffer[] = [];
				req.on('data', (c: Buffer) => chunks.push(c));
				req.on('end', () => {
					const body = Buffer.concat(chunks).toString();
					seen.push({path: req.url, headers: req.rawHeaders, body});
					const {query} = JSON.parse(body) as {query: string};
					res.setHeader('content-type', 'application/json');
					res.end(JSON.stringify([{title: query, url: 'https://p.example/'}]));
				});
				return;
			}
			seen.push({path: req.url, headers: req.rawHeaders});
			if (req.url === '/') res.setHeader('set-cookie', 'sid=abc; Path=/');
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({hits: [{t: 'One', u: 'https://one.example/'}]}));
		});
		proxy = await startConnectProxy();
	});
	afterAll(async () => {
		await server.close();
		await proxy.close();
	});

	it('sends through the proxy, with the kind header table and the session cookies', async () => {
		const origin = `https://localhost:${server.port}`;
		const recipe: CodeRecipe = {
			name: 'api',
			async search(query, ctx) {
				await ctx.http.get(`${origin}/`, {kind: 'document'});
				const data = (await ctx.http.json(`${origin}/api?q=${query}`, {
					kind: 'fetch',
					referer: `${origin}/`,
				})) as {hits: {t: string; u: string}[]};
				return data.hits.map((h) => ({title: h.t, url: h.u}));
			},
		};
		const serpcast = createSerpcast({
			libcurlPath: LIB,
			caPath: CA_PATH,
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		const response = await serpcast.search('x', {engines: [recipe]});
		expect(response.results).toEqual([
			{title: 'One', url: 'https://one.example/'},
		]);
		// Both requests go through ONE tunnel: the engine's session reuses its
		// connection (session-connection-reuse).
		expect(proxy.requests).toEqual([{host: 'localhost', port: server.port}]);
		const names = (raw: string[]) =>
			raw.filter((_, i) => i % 2 === 0 && !raw[i]!.startsWith(':'));
		const api = seen.find((s) => s.path === '/api?q=x')!;
		const expected = headerTable('fetch', {
			referer: `${origin}/`,
			cookie: 'sid=abc',
		}).map(([name]) => name);
		expect(names(api.headers)).toEqual(expected);
		const cookie = api.headers[api.headers.indexOf('cookie') + 1];
		expect(cookie).toBe('sid=abc');
	});

	it('postJson sends the captured POST table with the cookies and the JSON body, and parses the answer', async () => {
		const origin = `https://localhost:${server.port}`;
		const recipe: CodeRecipe = {
			name: 'poster',
			async search(query, ctx) {
				await ctx.http.get(`${origin}/`, {kind: 'document'});
				return (await ctx.http.postJson(
					`${origin}/answer`,
					{query},
					{kind: 'fetch', referer: `${origin}/`},
				)) as {title: string; url: string}[];
			},
		};
		const serpcast = createSerpcast({libcurlPath: LIB, caPath: CA_PATH});
		const response = await serpcast.search('hello', {engines: [recipe]});
		expect(response.results).toEqual([
			{title: 'hello', url: 'https://p.example/'},
		]);
		const post = seen.find((s) => s.path === '/answer')!;
		expect(post.body).toBe('{"query":"hello"}');
		expect(post.headers.slice(8)).toEqual(
			headerTable('fetch', {
				referer: `${origin}/`,
				url: `${origin}/answer`,
				cookie: 'sid=abc',
				method: 'POST',
				contentType: 'application/json',
				contentLength: post.body!.length,
			}).flat(),
		);
		await serpcast.close();
	});
	it('a cookie set with ctx.cookies (a name with #) reaches the server byte for byte, where Chrome puts it', async () => {
		const origin = `https://localhost:${server.port}`;
		const recipe: CodeRecipe = {
			name: 'setter',
			async search(query, ctx) {
				ctx.cookies.set(`${origin}/`, 'chal#1=a+b/c=; Path=/api; Secure');
				ctx.cookies.set(`${origin}/`, 'other=1; Path=/elsewhere');
				await ctx.http.get(`${origin}/api?q=${query}`, {kind: 'document'});
				return [];
			},
		};
		const serpcast = createSerpcast({libcurlPath: LIB, caPath: CA_PATH});
		await serpcast.search('set', {engines: [recipe]});
		const request = seen.find((s) => s.path === '/api?q=set')!;
		const names = request.headers.filter(
			(_, i) => i % 2 === 0 && !request.headers[i]!.startsWith(':'),
		);
		expect(names).toEqual(
			headerTable('document', {cookie: 'x'}).map(([name]) => name),
		);
		expect(request.headers[request.headers.indexOf('cookie') + 1]).toBe(
			'chal#1=a+b/c=',
		);
		await serpcast.close();
	});
});
