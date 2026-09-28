// Tests through the real native library. They need libcurl-impersonate: set
// SERPCAST_LIBCURL_PATH (CI fetches the pinned release, see
// .github/workflows/test.yml); without it they are skipped with a message.

import * as zlib from 'node:zlib';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	createTransport,
	headerTable,
	IMPERSONATE_TARGET,
	REQUEST_KINDS,
	SerpcastError,
} from '../src/index.js';
import {
	CA_PATH,
	firstHeadersFrame,
	startConnectProxy,
	startH2Server,
	startSocksProxy,
	type H2Server,
} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;

const REFERER = 'https://localhost/page';

/** Run `fn` with extra environment variables (libcurl reads the real environment), then restore it. */
async function withEnv<T>(
	vars: Record<string, string>,
	fn: () => Promise<T>,
): Promise<T> {
	const saved = Object.fromEntries(
		Object.keys(vars).map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

describe.skipIf(!LIB)('transport (native libcurl-impersonate)', () => {
	let server: H2Server;
	const seen = new Map<string, string[]>();
	const transport = createTransport({libcurlPath: LIB, caPath: CA_PATH});
	const url = (path: string) => `https://localhost:${server.port}${path}`;

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			const path = req.url;
			seen.set(path, req.rawHeaders);
			if (path.startsWith('/slow')) return; // never answers
			if (path === '/set-cookie')
				res.setHeader('set-cookie', ['sid=abc; Path=/', 'pref=1; Path=/']);
			const encoding = /^\/enc\/(\w+)/.exec(path)?.[1];
			const body = Buffer.from('héllo wörld'.repeat(20));
			const encoders: Record<string, (b: Buffer) => Buffer> = {
				gzip: zlib.gzipSync,
				deflate: zlib.deflateSync,
				br: zlib.brotliCompressSync,
				zstd: zlib.zstdCompressSync,
			};
			res.setHeader('content-type', 'text/plain; charset=utf-8');
			if (encoding) res.setHeader('content-encoding', encoding);
			res.end(encoding ? encoders[encoding]!(body) : body);
		});
		await transport.check();
	});
	afterAll(() => server?.close());

	it('loads the library and impersonates the pinned target', async () => {
		const info = await transport.check();
		expect(info.target).toBe(IMPERSONATE_TARGET);
		expect(info.impersonating).toBe(true);
		expect(info.version).toContain('IMPERSONATE');
	});

	it.each(REQUEST_KINDS)(
		'sends exactly the %s header table, in order, and nothing else',
		async (kind) => {
			const session = transport.session();
			const path = `/kind/${kind}`;
			const request = kind === 'document' ? {kind} : {kind, referer: REFERER};
			const response = await session.request(url(path), request as never);
			expect(response.status).toBe(200);
			const expected = headerTable(kind, {
				referer: kind === 'document' ? undefined : REFERER,
			});
			expect(seen.get(path)).toEqual([
				...[
					':method',
					'GET',
					':authority',
					`localhost:${server.port}`,
					':scheme',
					'https',
					':path',
					path,
				],
				...expected.flat(),
			]);
		},
	);

	it('sets the PRIORITY flag on the HTTP/2 HEADERS frame (exclusive, weight 256), as Chrome does', async () => {
		const before = server.received.length;
		await transport.session().request(url('/priority'), {kind: 'document'});
		const frame = firstHeadersFrame(server.received[before]!);
		expect(frame).toBeDefined();
		expect(frame!.flags & 0x20).toBe(0x20);
		expect(frame!.exclusive).toBe(true);
		expect(frame!.weight).toBe(256);
	});

	it('keeps cookies within a session, placed where Chrome puts them, and not in another session', async () => {
		const session = transport.session();
		await session.request(url('/set-cookie'), {kind: 'document'});
		await session.request(url('/after'), {kind: 'fetch', referer: REFERER});
		const headers = seen.get('/after')!;
		const names = headers.filter((_, i) => i % 2 === 0);
		expect(headers[headers.indexOf('cookie') + 1]).toBe('sid=abc; pref=1');
		expect(names.slice(-3)).toEqual(['accept-language', 'cookie', 'priority']);
		expect(session.cookies().map((c) => c.name)).toEqual(['sid', 'pref']);

		await transport.session().request(url('/other'), {kind: 'document'});
		expect(seen.get('/other')).not.toContain('cookie');

		const restored = transport.session(session.cookies());
		await restored.request(url('/restored'), {kind: 'document'});
		expect(seen.get('/restored')).toContain('cookie');
	});

	it.each(['gzip', 'deflate', 'br', 'zstd'])(
		'decodes a %s body',
		async (encoding) => {
			const response = await transport
				.session()
				.request(url(`/enc/${encoding}`), {kind: 'document'});
			expect(response.text()).toBe('héllo wörld'.repeat(20));
			expect(response.headers.get('content-encoding')).toBe(encoding);
		},
	);

	it('rejects a body larger than maxBodyBytes with a transport error', async () => {
		const small = createTransport({
			libcurlPath: LIB,
			caPath: CA_PATH,
			maxBodyBytes: 10,
		});
		await expect(
			small.session().request(url('/big'), {kind: 'document'}),
		).rejects.toMatchObject({
			kind: 'transport',
		});
	});

	it('raises timeout when the server does not answer in time', async () => {
		const error = await transport
			.session()
			.request(url('/slow/timeout'), {kind: 'document', timeoutMs: 300})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SerpcastError);
		expect(error).toMatchObject({kind: 'timeout'});
	});

	it("rejects with the signal's reason when aborted", async () => {
		const controller = new AbortController();
		const reason = new Error('stop');
		setTimeout(() => controller.abort(reason), 200);
		await expect(
			transport.session().request(url('/slow/abort'), {
				kind: 'document',
				signal: controller.signal,
			}),
		).rejects.toBe(reason);
	});

	it('raises transport when the connection fails', async () => {
		await expect(
			transport.session().request('https://localhost:1/', {kind: 'document'}),
		).rejects.toMatchObject({kind: 'transport'});
	});

	it('goes through an http proxy (CONNECT)', async () => {
		const proxy = await startConnectProxy();
		try {
			const viaProxy = createTransport({
				libcurlPath: LIB,
				caPath: CA_PATH,
				proxy: `http://127.0.0.1:${proxy.port}`,
			});
			const response = await viaProxy
				.session()
				.request(url('/via-http-proxy'), {kind: 'document'});
			expect(response.status).toBe(200);
			expect(proxy.requests).toEqual([{host: 'localhost', port: server.port}]);
		} finally {
			await proxy.close();
		}
	});

	it('sends every host through the given proxy, whatever NO_PROXY says', async () => {
		const proxy = await startConnectProxy();
		const viaProxy = createTransport({
			libcurlPath: LIB,
			caPath: CA_PATH,
			proxy: `http://127.0.0.1:${proxy.port}`,
		});
		try {
			await withEnv({NO_PROXY: '*', no_proxy: '*'}, () =>
				viaProxy.session().request(url('/no-proxy-env'), {kind: 'document'}),
			);
			expect(proxy.requests).toHaveLength(1);
		} finally {
			await proxy.close();
		}
	});

	it('goes through a socks5h proxy, which resolves the host name (no local DNS)', async () => {
		const proxy = await startSocksProxy();
		try {
			const viaProxy = createTransport({
				libcurlPath: LIB,
				caPath: CA_PATH,
				proxy: `socks5h://127.0.0.1:${proxy.port}`,
			});
			await viaProxy.session().request(url('/via-socks5h'), {kind: 'document'});
			expect(proxy.requests).toEqual([
				{atyp: 3, host: 'localhost', port: server.port},
			]);
		} finally {
			await proxy.close();
		}
	});

	it('with socks5 (no h), resolves the host LOCALLY and sends the proxy an IP', async () => {
		const proxy = await startSocksProxy();
		try {
			const viaProxy = createTransport({
				libcurlPath: LIB,
				caPath: CA_PATH,
				proxy: `socks5://127.0.0.1:${proxy.port}`,
			});
			await viaProxy.session().request(url('/via-socks5'), {kind: 'document'});
			expect(proxy.requests).toHaveLength(1);
			expect(proxy.requests[0]!.atyp).not.toBe(3);
		} finally {
			await proxy.close();
		}
	});

	it('ignores proxy environment variables when no proxy is given', async () => {
		const dead = 'http://127.0.0.1:1';
		const response = await withEnv(
			{HTTPS_PROXY: dead, https_proxy: dead, ALL_PROXY: dead, all_proxy: dead},
			() =>
				transport.session().request(url('/no-env-proxy'), {kind: 'document'}),
		);
		expect(response.status).toBe(200);
	});

	it('refuses a second instance that asks for a different library path in the same process', async () => {
		const other = createTransport({
			libcurlPath: '/elsewhere/libcurl-impersonate.so',
		});
		const before = server.connections;
		await expect(
			other.session().request(url('/second'), {kind: 'document'}),
		).rejects.toMatchObject({
			kind: 'impersonation',
			message: expect.stringContaining('already loaded'),
		});
		expect(server.connections).toBe(before);
	});
});
