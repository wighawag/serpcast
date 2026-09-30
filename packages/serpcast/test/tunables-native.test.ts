// The transport's tuning options and off switches through the real native
// library: reuseConnections (one connection per request when false, counted
// like connection-reuse.test.ts), idlePollMs, maxRequestBodyBytes,
// preflightCache and maxPreflightAgeS. Needs libcurl-impersonate
// (SERPCAST_LIBCURL_PATH); skipped without it.

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createTransport, type TransportOptions} from '../src/index.js';
import {CA_PATH, startH2Server, type H2Server} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;

/** Wait (up to 2 s) until the server has exactly `n` connections open; then how many it has. */
async function openSettles(server: H2Server, n: number): Promise<number> {
	for (let i = 0; i < 40 && server.open !== n; i++)
		await new Promise((resolve) => setTimeout(resolve, 50));
	return server.open;
}

describe.skipIf(!LIB)('transport tunables (native)', () => {
	let server: H2Server;
	const seen: {method: string; path: string}[] = [];
	const at = (method: string, path: string) =>
		seen.filter((s) => s.method === method && s.path === path);
	const url = (path: string) => `https://localhost:${server.port}${path}`;
	const transport = (options: TransportOptions = {}) =>
		createTransport({libcurlPath: LIB, caPath: CA_PATH, ...options});
	// A page on another port of localhost: same-site, so a JSON POST is preflighted.
	const referer = 'https://localhost:1/page';

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			seen.push({method: req.method, path: req.url});
			if (req.method === 'OPTIONS') {
				res.setHeader('access-control-allow-origin', req.headers.origin!);
				res.setHeader('access-control-allow-credentials', 'true');
				res.setHeader('access-control-allow-headers', 'Content-Type');
				if (req.url.startsWith('/long'))
					res.setHeader('access-control-max-age', '600');
				res.statusCode = 204;
				res.end();
				return;
			}
			const delay = Number(/^\/delay\/(\d+)/.exec(req.url)?.[1] ?? 0);
			req.resume();
			req.on('end', () =>
				setTimeout(() => res.end(`answer ${req.url}`), delay),
			);
		});
		await transport().check();
	});
	afterAll(() => server?.close());

	const post = (
		session: ReturnType<ReturnType<typeof transport>['session']>,
		path: string,
		body = '{}',
	) =>
		session.request(url(path), {
			kind: 'fetch',
			method: 'POST',
			referer,
			body,
			contentType: 'application/json',
		});

	it('reuseConnections: true (default) keeps one connection; false opens one per request and closes it', async () => {
		const kept = transport().session();
		let before = server.connections;
		await kept.request(url('/reuse/1'), {kind: 'document'});
		await kept.request(url('/reuse/2'), {kind: 'document'});
		expect(server.connections).toBe(before + 1);
		kept.close();
		expect(await openSettles(server, 0)).toBe(0);

		const fresh = transport({reuseConnections: false}).session();
		before = server.connections;
		await fresh.request(url('/fresh/1'), {kind: 'document'});
		expect(await openSettles(server, 0)).toBe(0); // closed after the request
		const second = await fresh.request(url('/fresh/2'), {kind: 'document'});
		expect(second.text()).toBe('answer /fresh/2');
		await post(fresh, '/fresh/post'); // the preflight and the POST: two more
		expect(server.connections).toBe(before + 4);
		expect(await openSettles(server, 0)).toBe(0);
	});

	it('reuseConnections: false still answers concurrent requests, each on its own connection', async () => {
		const fresh = transport({reuseConnections: false}).session();
		const before = server.connections;
		const answers = await Promise.all(
			[50, 0].map((delay, i) =>
				fresh
					.request(url(`/delay/${delay}/${i}`), {kind: 'document'})
					.then((r) => r.text()),
			),
		);
		expect(answers).toEqual(['answer /delay/50/0', 'answer /delay/0/1']);
		expect(server.connections).toBe(before + 2);
	});

	it('idlePollMs: a longer interval notices a waiting answer later', async () => {
		const timed = async (options: TransportOptions) => {
			const session = transport(options).session();
			await session.request(url('/delay/0/warm'), {kind: 'document'}); // connected
			const start = performance.now();
			await session.request(url('/delay/30/timed'), {kind: 'document'});
			session.close();
			return performance.now() - start;
		};
		expect(await timed({})).toBeLessThan(250);
		expect(await timed({idlePollMs: 400})).toBeGreaterThanOrEqual(300);
	});

	it('maxRequestBodyBytes: a set value is the cap (recipe error, nothing sent); the default allows more', async () => {
		const small = transport({maxRequestBodyBytes: 10}).session();
		await expect(post(small, '/capped', '"123456789"')).rejects.toMatchObject({
			kind: 'recipe',
			message: expect.stringContaining('limited to 10 bytes'),
		});
		expect(at('POST', '/capped')).toHaveLength(0);
		expect(at('OPTIONS', '/capped')).toHaveLength(0);
		await post(small, '/capped', '"1234567"'); // 9 bytes
		await post(transport().session(), '/capped', '"123456789"');
		expect(at('POST', '/capped')).toHaveLength(2);
	});

	it('preflightCache: false preflights every POST', async () => {
		const cached = transport().session();
		await post(cached, '/cache/on');
		await post(cached, '/cache/on');
		expect(at('OPTIONS', '/cache/on')).toHaveLength(1);
		const uncached = transport({preflightCache: false}).session();
		await post(uncached, '/cache/off');
		await post(uncached, '/cache/off');
		expect(at('OPTIONS', '/cache/off')).toHaveLength(2);
		expect(at('POST', '/cache/off')).toHaveLength(2);
	});

	it('maxPreflightAgeS caps a long access-control-max-age (default 7200 s keeps it)', async () => {
		const capped = transport({maxPreflightAgeS: 1}).session();
		const plain = transport().session();
		await post(capped, '/long/capped');
		await post(plain, '/long/plain');
		await new Promise((resolve) => setTimeout(resolve, 1100));
		await post(capped, '/long/capped');
		await post(plain, '/long/plain');
		expect(at('OPTIONS', '/long/capped')).toHaveLength(2);
		expect(at('OPTIONS', '/long/plain')).toHaveLength(1);
	});
});
