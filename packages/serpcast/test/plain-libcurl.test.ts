// Strict mode against a PLAIN libcurl, which loads silently. Its own file (the
// library path is process-global, and vitest runs each file in its own
// process). Needs SERPCAST_TEST_PLAIN_LIBCURL (a plain libcurl.so; CI sets it).

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createTransport} from '../src/index.js';
import {CA_PATH, startH2Server, type H2Server} from './servers.js';

const PLAIN = process.env.SERPCAST_TEST_PLAIN_LIBCURL;

describe.skipIf(!PLAIN)('with plain libcurl', () => {
	let server: H2Server;
	const url = () => `https://localhost:${server.port}/`;
	beforeAll(async () => {
		server = await startH2Server((_req, res) => res.end('ok'));
	});
	afterAll(() => server?.close());

	it('strict mode fails the first request with an impersonation error and makes no network call', async () => {
		const strict = createTransport({libcurlPath: PLAIN, caPath: CA_PATH});
		await expect(
			strict.session().request(url(), {kind: 'document'}),
		).rejects.toMatchObject({
			kind: 'impersonation',
			message: expect.stringContaining('plain libcurl'),
		});
		expect(server.connections).toBe(0);
	});

	it('non-strict mode proceeds, and says it is not impersonating', async () => {
		const loose = createTransport({
			libcurlPath: PLAIN,
			caPath: CA_PATH,
			strict: false,
		});
		expect(await loose.check()).toMatchObject({impersonating: false});
		const response = await loose.session().request(url(), {kind: 'document'});
		expect(response.text()).toBe('ok');
		expect(server.connections).toBe(1);
	});
});
