// The transport never leaves the process hanging: libcurl runs on the main
// thread, so `process.exit()` returns while a request is in flight or right
// after an abort (with `curl_easy_perform` on a worker thread both hung
// forever). Also: concurrent requests in one process, and an idle in-flight
// request does not busy-loop. Needs libcurl-impersonate (SERPCAST_LIBCURL_PATH)
// and the build (`dist/`, as the CLI tests); skipped without the library.

import {spawn} from 'node:child_process';
import net from 'node:net';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {createTransport} from '../src/index.js';
import {CA_PATH, startH2Server, type H2Server} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;
const DIST = new URL('../dist/index.js', import.meta.url).href;

/** A TCP server that accepts connections and never answers. */
async function startSilentServer(): Promise<{port: number; close(): void}> {
	const sockets = new Set<net.Socket>();
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on('error', () => {});
		socket.on('close', () => sockets.delete(socket));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		port: (server.address() as net.AddressInfo).port,
		close() {
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}

/** Run `script` (an ES module) in a child Node; resolves with its exit code and how long it took, or 'hung' after `limitMs`. */
function runChild(
	script: string,
	limitMs: number,
): Promise<{code: number | null; ms: number} | 'hung'> {
	return new Promise((resolve) => {
		const started = Date.now();
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
			resolve({code, ms: Date.now() - started});
		});
	});
}

describe.skipIf(!LIB)('transport and process exit (native)', () => {
	let silent: Awaited<ReturnType<typeof startSilentServer>>;
	beforeAll(async () => {
		silent = await startSilentServer();
	});
	afterAll(() => silent?.close());

	const child = (onRequest: string) => `
		import {createTransport} from ${JSON.stringify(DIST)};
		const transport = createTransport({libcurlPath: ${JSON.stringify(LIB)}, timeoutMs: 20000});
		await transport.check();
		const controller = new AbortController();
		transport.session()
			.request('http://127.0.0.1:${silent.port}/', {kind: 'document', signal: controller.signal})
			.catch(() => {});
		${onRequest}
	`;

	it('process.exit() returns while a request is in flight', async () => {
		const result = await runChild(
			child('setTimeout(() => process.exit(1), 1000);'),
			5000,
		);
		expect(result).not.toBe('hung');
		expect(result).toMatchObject({code: 1});
	}, 10_000);

	it('process.exit() returns right after an abort', async () => {
		const result = await runChild(
			child(
				"setTimeout(() => { controller.abort(new Error('stop')); process.exit(1); }, 1000);",
			),
			5000,
		);
		expect(result).not.toBe('hung');
		expect(result).toMatchObject({code: 1});
	}, 10_000);
});

describe.skipIf(!LIB)('transport concurrency and idle cost (native)', () => {
	let server: H2Server;
	let silent: Awaited<ReturnType<typeof startSilentServer>>;
	const transport = createTransport({libcurlPath: LIB, caPath: CA_PATH});

	beforeAll(async () => {
		server = await startH2Server((req, res) => {
			const delay = Number(/^\/delay\/(\d+)/.exec(req.url)?.[1] ?? 0);
			setTimeout(() => res.end(`answer ${req.url}`), delay);
		});
		silent = await startSilentServer();
		await transport.check();
	});
	afterAll(async () => {
		silent?.close();
		await server?.close();
	});

	it('runs several requests at once in one process, each with its own answer', async () => {
		const delays = [400, 300, 200, 100, 0, 400, 300, 200];
		const started = Date.now();
		const controller = new AbortController();
		const aborted = transport
			.session()
			.request(`http://127.0.0.1:${silent.port}/`, {
				kind: 'document',
				signal: controller.signal,
			})
			.catch((error: unknown) => error);
		setTimeout(() => controller.abort(new Error('stop')), 150);
		const answers = await Promise.all(
			delays.map((delay, i) =>
				transport
					.session()
					.request(`https://localhost:${server.port}/delay/${delay}/${i}`, {
						kind: 'document',
					})
					.then((response) => response.text()),
			),
		);
		const elapsed = Date.now() - started;
		expect(answers).toEqual(
			delays.map((delay, i) => `answer /delay/${delay}/${i}`),
		);
		// Serialized, the delays alone would add up to 1.9 s.
		expect(elapsed).toBeLessThan(1500);
		expect(await aborted).toMatchObject({message: 'stop'});
	});

	it('does not busy-loop while a request waits for an answer', async () => {
		const controller = new AbortController();
		const pending = transport
			.session()
			.request(`http://127.0.0.1:${silent.port}/`, {
				kind: 'document',
				signal: controller.signal,
			})
			.catch(() => {});
		await new Promise((resolve) => setTimeout(resolve, 200));
		const before = process.cpuUsage();
		const started = performance.now();
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const used = process.cpuUsage(before);
		const share =
			(used.user + used.system) / 1000 / (performance.now() - started);
		controller.abort();
		await pending;
		// Measured about 0.6% of a core on Linux x64; a busy loop is about 100%.
		expect(share).toBeLessThan(0.25);
	});
});
