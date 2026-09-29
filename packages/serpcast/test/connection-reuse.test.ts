// Connection reuse through the real native library: a transport session keeps
// its connection for its next request (through a proxy too), with Chrome's
// HTTP/2 HEADERS frame on every stream; two sessions never share one; `close()`
// releases them; the engine chain keeps an engine's connection between searches
// and releases it with the session; and an idle connection never keeps the
// process alive. Needs libcurl-impersonate (SERPCAST_LIBCURL_PATH) and, for the
// child-process tests, the build (`dist/`); skipped without the library.

import {spawn} from 'node:child_process';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	createSerpcast,
	createTransport,
	headerTable,
	type CodeRecipe,
} from '../src/index.js';
import {
	CA_PATH,
	headersFrames,
	startConnectProxy,
	startH2Server,
	startSocksProxy,
	type H2Server,
} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;
const DIST = new URL('../dist/index.js', import.meta.url).href;

/** Wait (up to 2 s) until the server has exactly `n` connections open; then how many it has. */
async function openSettles(server: H2Server, n: number): Promise<number> {
	for (let i = 0; i < 40 && server.open !== n; i++)
		await new Promise((resolve) => setTimeout(resolve, 50));
	return server.open;
}

describe.skipIf(!LIB)('transport session connection reuse (native)', () => {
	let server: H2Server;
	const seen = new Map<string, string[]>();
	const transport = createTransport({libcurlPath: LIB, caPath: CA_PATH});
	const url = (path: string) => `https://localhost:${server.port}${path}`;

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			seen.set(req.url, req.rawHeaders);
			if (req.url.startsWith('/slow')) return; // never answers
			const delay = Number(/^\/delay\/(\d+)/.exec(req.url)?.[1] ?? 0);
			setTimeout(() => res.end(`answer ${req.url}`), delay);
		});
		await transport.check();
	});
	afterAll(() => server?.close());

	it('reuses one connection for two requests of one session, with the exact header table and PRIORITY flag on both streams', async () => {
		const session = transport.session();
		const before = server.connections;
		await session.request(url('/reuse/1'), {kind: 'document'});
		const second = await session.request(url('/reuse/2'), {
			kind: 'fetch',
			referer: url('/reuse/1'),
		});
		expect(second.text()).toBe('answer /reuse/2');
		expect(server.connections).toBe(before + 1);
		const frames = headersFrames(server.received[before]!);
		expect(frames.map((f) => f.stream)).toEqual([1, 3]);
		for (const frame of frames) {
			expect(frame.flags & 0x20).toBe(0x20);
			expect(frame.exclusive).toBe(true);
			expect(frame.weight).toBe(256);
		}
		const expected = headerTable('fetch', {referer: url('/reuse/1')});
		expect(seen.get('/reuse/2')!.slice(8)).toEqual(expected.flat());
		session.close();
	});

	it('never shares a connection between two sessions', async () => {
		const [one, two] = [transport.session(), transport.session()];
		const before = server.connections;
		await one.request(url('/two/1'), {kind: 'document'});
		await two.request(url('/two/2'), {kind: 'document'});
		await one.request(url('/two/3'), {kind: 'document'});
		await two.request(url('/two/4'), {kind: 'document'});
		expect(server.connections).toBe(before + 2);
		one.close();
		two.close();
	});

	it('multiplexes concurrent requests of one session on one connection', async () => {
		const session = transport.session();
		const before = server.connections;
		const answers = await Promise.all(
			[200, 100, 0].map((delay, i) =>
				session
					.request(url(`/delay/${delay}/${i}`), {kind: 'document'})
					.then((r) => r.text()),
			),
		);
		expect(answers).toEqual([
			'answer /delay/200/0',
			'answer /delay/100/1',
			'answer /delay/0/2',
		]);
		expect(server.connections).toBe(before + 1);
		session.close();
	});

	it('close() closes the idle connection; the session then opens a new one', async () => {
		const session = transport.session();
		expect(await openSettles(server, 0)).toBe(0);
		await session.request(url('/close/1'), {kind: 'document'});
		expect(server.open).toBe(1);
		session.close();
		expect(await openSettles(server, 0)).toBe(0);
		const before = server.connections;
		const again = await session.request(url('/close/2'), {kind: 'document'});
		expect(again.text()).toBe('answer /close/2');
		expect(server.connections).toBe(before + 1);
		session.close();
	});

	it('close() during a request lets it finish, then closes the connection', async () => {
		const session = transport.session();
		expect(await openSettles(server, 0)).toBe(0);
		const pending = session.request(url('/delay/300/closing'), {
			kind: 'document',
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		session.close();
		expect(server.open).toBe(1);
		expect((await pending).text()).toBe('answer /delay/300/closing');
		expect(await openSettles(server, 0)).toBe(0);
	});

	it('an aborted request does not break the session', async () => {
		const session = transport.session();
		await session.request(url('/abort/1'), {kind: 'document'});
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error('stop')), 100);
		await expect(
			session.request(url('/slow/abort'), {
				kind: 'document',
				signal: controller.signal,
			}),
		).rejects.toMatchObject({message: 'stop'});
		const after = await session.request(url('/abort/2'), {kind: 'document'});
		expect(after.text()).toBe('answer /abort/2');
		session.close();
	});

	it.each(['http', 'socks5h', 'socks5'])(
		'reuses the connection through a %s proxy (one tunnel for two requests)',
		async (scheme) => {
			const proxy = await (scheme === 'http'
				? startConnectProxy()
				: startSocksProxy());
			try {
				const viaProxy = createTransport({
					libcurlPath: LIB,
					caPath: CA_PATH,
					proxy: `${scheme}://127.0.0.1:${proxy.port}`,
				});
				const session = viaProxy.session();
				await session.request(url(`/proxy/${scheme}/1`), {kind: 'document'});
				await session.request(url(`/proxy/${scheme}/2`), {kind: 'document'});
				expect(proxy.requests).toHaveLength(1);
				await viaProxy
					.session()
					.request(url(`/proxy/${scheme}/3`), {kind: 'document'});
				expect(proxy.requests).toHaveLength(2); // another session, another tunnel
				session.close();
			} finally {
				await proxy.close();
			}
		},
	);
});

describe.skipIf(!LIB)('engine chain connection reuse (native)', () => {
	let server: H2Server;

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({hits: [{t: req.url, u: 'https://x.example/'}]}));
		});
	});
	afterAll(() => server?.close());

	const recipe = (name: string): CodeRecipe => ({
		name,
		async search(query, ctx) {
			const data = (await ctx.http.json(
				`https://localhost:${server.port}/${name}?q=${query}`,
				{kind: 'document'},
			)) as {hits: {t: string; u: string}[]};
			return data.hits.map((h) => ({title: h.t, url: h.u}));
		},
	});

	it("keeps an engine's connection between searches, one per engine, and closes them on clearSessions() and close()", async () => {
		const serpcast = createSerpcast({libcurlPath: LIB, caPath: CA_PATH});
		const [a, b] = [recipe('a'), recipe('b')];
		expect(await openSettles(server, 0)).toBe(0);
		const before = server.connections;
		for (let i = 0; i < 3; i++) {
			await serpcast.search('q', {engines: [a]});
			await serpcast.search('q', {engines: [b]});
		}
		expect(server.connections).toBe(before + 2);
		expect(server.open).toBe(2);
		await serpcast.clearSessions('a');
		expect(await openSettles(server, 1)).toBe(1);
		await serpcast.search('q', {engines: [a]});
		expect(server.connections).toBe(before + 3);
		expect(server.open).toBe(2);
		await serpcast.close();
		expect(await openSettles(server, 0)).toBe(0);
	});

	it('drops the connection with the session after sessionIdleMs', async () => {
		let t = 0;
		const serpcast = createSerpcast({
			libcurlPath: LIB,
			caPath: CA_PATH,
			now: () => t,
			sessionIdleMs: 1000,
		});
		const before = server.connections;
		await serpcast.search('q', {engines: [recipe('idle')]});
		await serpcast.search('q', {engines: [recipe('idle')]});
		expect(server.connections).toBe(before + 1);
		t += 1000;
		await serpcast.search('q', {engines: [recipe('idle')]});
		expect(server.connections).toBe(before + 2);
		await serpcast.close();
	});

	/** Run `script` in a child Node; its exit code, or 'hung' if it is still running after `limitMs`. */
	function runChild(
		script: string,
		limitMs: number,
	): Promise<number | null | 'hung'> {
		return new Promise((resolve) => {
			const child = spawn(
				process.execPath,
				['--input-type=module', '-e', script],
				{stdio: ['ignore', 'ignore', 'inherit']},
			);
			const timer = setTimeout(() => {
				child.kill('SIGKILL');
				resolve('hung');
			}, limitMs);
			child.on('exit', (code) => {
				clearTimeout(timer);
				resolve(code);
			});
		});
	}

	const child = (after: string) => `
		import {createSerpcast} from ${JSON.stringify(DIST)};
		const serpcast = createSerpcast({libcurlPath: ${JSON.stringify(LIB)}, caPath: ${JSON.stringify(CA_PATH)}});
		const engine = {name: 'child', async search(query, ctx) {
			const r = await ctx.http.json('https://localhost:${server.port}/child?q=' + query, {kind: 'document'});
			return r.hits.map((h) => ({title: h.t, url: h.u}));
		}};
		const first = await serpcast.search('q', {engines: [engine]});
		const second = await serpcast.search('q', {engines: [engine]});
		process.exitCode = first.results.length === 1 && second.results.length === 1 ? 0 : 2;
		${after}
	`;

	it('Serpcast.close() leaves nothing that keeps the process alive', async () => {
		expect(await runChild(child('await serpcast.close();'), 5000)).toBe(0);
	}, 10_000);

	it('an idle connection alone does not keep the process alive (no close())', async () => {
		expect(await runChild(child(''), 5000)).toBe(0);
	}, 10_000);
});
