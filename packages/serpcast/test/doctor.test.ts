// `serpcast doctor`, and `serpcast query` after `serpcast install-libcurl`. The
// first block needs no native library; the second runs only with
// SERPCAST_LIBCURL_PATH (see test/native-notice.ts). Every data directory is a
// temp dir, and the real one is checked untouched.

import {execFile} from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {doctor, formatReport, healthy} from '../src/doctor.js';
import {libraryFileName} from '../src/index.js';
import {installLibcurl} from '../src/install.js';
import {item, recipe, resultsPage, startPageServer} from './pages.js';
import {
	LIBRARY,
	realDataDirs,
	release,
	sha256,
	startReleaseServer,
	tarGz,
} from './release.js';
import {CA_PATH, startConnectProxy, startH2Server} from './servers.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = promisify(execFile);

const snapshot = realDataDirs();
let before: unknown[];
let tmp: string;
/** No library configured anywhere; the data directory is a temp dir. */
let env: NodeJS.ProcessEnv;
beforeEach(() => {
	before = snapshot();
	tmp = mkdtempSync(join(tmpdir(), 'serpcast-doctor-'));
	env = {
		...process.env,
		SERPCAST_LIBCURL_PATH: '',
		LIBCURL_PATH: '',
		HOME: tmp,
		XDG_DATA_HOME: join(tmp, 'data'),
	};
});
afterEach(() => {
	rmSync(tmp, {recursive: true, force: true});
	expect(snapshot()).toEqual(before); // the real data directory is untouched
});

/** A TCP server that only counts connections: any network request would show. */
async function listener() {
	const server = net.createServer((socket) => socket.destroy());
	let connections = 0;
	server.on('connection', () => connections++);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
		connections: () => connections,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

const failed = (promise: Promise<unknown>) =>
	promise.then(
		() => expect.fail('expected exit 1'),
		(e: {code: number; stdout: string; stderr: string}) => e,
	);

describe('serpcast doctor (no native library needed)', () => {
	it('reports a missing library and how to fix it (exit 1), with no network request', async () => {
		const proxy = await listener();
		try {
			for (const extra of [[], ['--remote']]) {
				const {code, stdout} = await failed(
					run(
						process.execPath,
						[cli, 'doctor', '--proxy', proxy.url, ...extra],
						{env},
					),
				);
				expect(code).toBe(1);
				expect(stdout).toMatch(/^library: +not found$/m);
				expect(stdout).toMatch(/^pinned: +libcurl-impersonate 2\.1\.1$/m);
				expect(stdout).toMatch(/^impersonation: +NOT active$/m);
				expect(stdout).toMatch(/^problem: .*serpcast install-libcurl/m);
			}
			expect(proxy.connections()).toBe(0);
		} finally {
			await proxy.close();
		}
	});

	it('names a data-directory file that is not a library, and skips --remote', async () => {
		mkdirSync(join(tmp, 'data', 'serpcast'), {recursive: true});
		const path = join(tmp, 'data', 'serpcast', libraryFileName());
		writeFileSync(path, 'not a library');
		const report = await doctor({env, remote: true});
		expect(report).toMatchObject({
			library: {path, source: 'data directory'},
			impersonating: false,
			problem: expect.stringContaining(`cannot load ${path}`),
			remote: {error: 'skipped: impersonation is not active'},
		});
		expect(healthy(report)).toBe(false);
		expect(formatReport(report)).toMatch(
			/^from: +the data directory \(serpcast install-libcurl\)$/m,
		);
	});
});

describe.skipIf(!LIB)('serpcast doctor (native libcurl-impersonate)', () => {
	it('reports the library, where it came from and that impersonation is active, without any request', async () => {
		const proxy = await startConnectProxy();
		try {
			const {stdout} = await run(
				process.execPath,
				[
					cli,
					'doctor',
					'--libcurl',
					LIB!,
					'--proxy',
					`http://127.0.0.1:${proxy.port}`,
				],
				{env},
			);
			expect(stdout).toMatch(/^from: +--libcurl$/m);
			expect(stdout).toMatch(/^version: +libcurl\/\S+ BoringSSL/m);
			expect(stdout).toMatch(/^impersonation: +active \(chrome\d+\)$/m);
			expect(stdout).not.toMatch(/^echo:/m);
			expect(proxy.requests).toEqual([]);
		} finally {
			await proxy.close();
		}
	});

	it('with remote, asks the echo service through the transport and the proxy and reports what it saw', async () => {
		const echo = await startH2Server((_req, res) => {
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					ja3_hash: 'j3',
					ja3n_hash: 'j3n',
					ja4: 't13d1516h2_x_y',
					akamai_text: '1:65536|15663105|0|m,a,s,p',
					akamai_hash: 'ak',
				}),
			);
		});
		const proxy = await startConnectProxy();
		try {
			const report = await doctor({
				libcurlPath: LIB,
				proxy: `http://127.0.0.1:${proxy.port}`,
				remote: true,
				echoUrl: `https://localhost:${echo.port}/json`,
				caPath: CA_PATH,
			});
			expect(report.impersonating).toBe(true);
			expect(report.remote).toEqual({
				url: `https://localhost:${echo.port}/json`,
				seen: {
					ja3: 'j3',
					ja3n: 'j3n',
					ja4: 't13d1516h2_x_y',
					http2: '1:65536|15663105|0|m,a,s,p',
					'http2 hash': 'ak',
				},
			});
			expect(healthy(report)).toBe(true);
			expect(proxy.requests).toEqual([{host: 'localhost', port: echo.port}]);
			expect(echo.connections).toBe(1);
		} finally {
			await proxy.close();
			await echo.close();
		}
	});
});

describe.skipIf(!LIB)('serpcast query after install-libcurl (native)', () => {
	it('finds the installed library with no path configured', async () => {
		const archive = tarGz([{name: LIBRARY, body: readFileSync(LIB!)}]);
		const releases = await startReleaseServer({'/rel/lib.tar.gz': archive});
		const pages = await startPageServer({
			'/search': {body: resultsPage(item('One', 'one', 'snip'))},
		});
		try {
			const {path} = await installLibcurl({
				env,
				release: release(`${releases.origin}/rel/`, sha256(archive)),
			});
			expect(path).toBe(join(tmp, 'data', 'serpcast', libraryFileName()));
			const file = join(tmp, 'r.json');
			writeFileSync(file, JSON.stringify(recipe(pages.origin)));
			const {stdout} = await run(
				process.execPath,
				[cli, 'query', '--recipe', file, 'hello'],
				{env},
			);
			expect(JSON.parse(stdout).results).toEqual([
				{
					title: 'One',
					url: `${pages.origin}/one`,
					content: 'snip',
					snippet: 'snip',
				},
			]);
			const doctored = await run(process.execPath, [cli, 'doctor'], {env});
			expect(doctored.stdout).toContain(`library:       ${path}`);
			expect(doctored.stdout).toMatch(/^from: +the data directory/m);
		} finally {
			await releases.close();
			await pages.close();
		}
	});
});
