// `serpcast install-libcurl` against a local release server (no network, no
// native library). Every test installs into a temp XDG_DATA_HOME and checks
// the real data directory is untouched.

import {execFile} from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from 'vitest';
import {libraryFileName, resolveLibraryPath} from '../src/index.js';
import {extract, InstallError, installLibcurl} from '../src/install.js';
import {
	LIBRARY,
	realDataDirs,
	release,
	sha256,
	startReleaseServer,
	tarGz,
	type ReleaseServer,
} from './release.js';
import {startConnectProxy, startSocksProxy} from './servers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const lib = Buffer.from(
	'not really a shared library, but the bytes to install',
);
const archive = tarGz([
	{name: 'include/', type: '5'},
	{name: 'libcurl-impersonate.so', type: '2', link: 'libcurl-impersonate.so.4'},
	{name: LIBRARY, body: lib},
	{name: 'libcurl-impersonate.a', body: Buffer.from('static')},
]);
const other = tarGz([{name: LIBRARY, body: Buffer.from('another build')}]);

let server: ReleaseServer;
beforeAll(async () => {
	server = await startReleaseServer({
		'/rel/lib.tar.gz': {status: 302, location: '/blob/lib.tar.gz'},
		'/blob/lib.tar.gz': archive,
		'/other/lib.tar.gz': other,
		'/empty/lib.tar.gz': tarGz([{name: 'README', body: Buffer.from('x')}]),
	});
});
afterAll(() => server.close());

const snapshot = realDataDirs();
let before: unknown[];
let tmp: string;
let env: NodeJS.ProcessEnv;
let installed: string;
beforeEach(() => {
	before = snapshot();
	tmp = mkdtempSync(join(tmpdir(), 'serpcast-install-'));
	env = {XDG_DATA_HOME: join(tmp, 'data')};
	installed = join(tmp, 'data', 'serpcast', libraryFileName());
	server.hits.length = 0;
});
afterEach(() => {
	rmSync(tmp, {recursive: true, force: true});
	expect(snapshot()).toEqual(before); // the real data directory is untouched
});

const pinned = (path = 'rel', checksum = sha256(archive)) =>
	release(`${server.origin}/${path}/`, checksum);

describe('installLibcurl', () => {
	it('downloads the pinned archive, verifies it and installs the library where the transport finds it', async () => {
		const log: string[] = [];
		const result = await installLibcurl({
			env,
			release: pinned(),
			log: (line) => log.push(line),
		});
		expect(result).toEqual({
			path: installed,
			url: `${server.origin}/blob/lib.tar.gz`,
			status: 'installed',
		});
		expect(readFileSync(installed)).toEqual(lib);
		expect(readdirSync(join(tmp, 'data', 'serpcast'))).toEqual([
			libraryFileName(),
		]);
		expect(resolveLibraryPath(undefined, env)).toBe(installed);
		expect(server.hits).toEqual(['/rel/lib.tar.gz', '/blob/lib.tar.gz']);
		expect(log).toEqual([
			`downloading ${server.origin}/rel/lib.tar.gz`,
			expect.stringContaining(`verified sha256 ${sha256(archive)}`),
			`installed ${installed}`,
		]);
	});

	it('aborts on a checksum mismatch and installs nothing', async () => {
		const error = await installLibcurl({
			env,
			release: pinned('rel', '0'.repeat(64)),
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InstallError);
		expect((error as Error).message).toMatch(/checksum mismatch/);
		expect((error as Error).message).toContain(sha256(archive));
		expect(readdirSync(tmp)).toEqual([]); // not even the data directory
	});

	it('fails when the archive lacks the library, installing nothing', async () => {
		const empty = tarGz([{name: 'README', body: Buffer.from('x')}]);
		await expect(
			installLibcurl({env, release: pinned('empty', sha256(empty))}),
		).rejects.toThrow(/has no file libcurl-impersonate/);
		expect(readdirSync(tmp)).toEqual([]);
	});

	it('fails on an HTTP error, installing nothing', async () => {
		await expect(
			installLibcurl({env, release: pinned('missing')}),
		).rejects.toThrow(/HTTP 404.*Nothing was installed/);
		expect(readdirSync(tmp)).toEqual([]);
	});

	it('refuses a platform with no pinned archive, before any request', async () => {
		await expect(
			installLibcurl({env, release: {...pinned(), assets: {}}}),
		).rejects.toThrow(/no pinned .* archive .*SERPCAST_LIBCURL_PATH/);
		expect(server.hits).toEqual([]);
	});

	it('leaves an identical file alone, refuses a differing one without force, replaces it with force', async () => {
		mkdirSync(join(tmp, 'data', 'serpcast'), {recursive: true});
		writeFileSync(installed, lib);
		expect(await installLibcurl({env, release: pinned()})).toMatchObject({
			status: 'unchanged',
		});

		writeFileSync(installed, 'my own build');
		await expect(installLibcurl({env, release: pinned()})).rejects.toThrow(
			/already exists and differs.*--force/,
		);
		expect(readFileSync(installed, 'utf8')).toBe('my own build');

		expect(
			await installLibcurl({env, release: pinned(), force: true}),
		).toMatchObject({status: 'replaced'});
		expect(readFileSync(installed)).toEqual(lib);
		expect(readdirSync(join(tmp, 'data', 'serpcast'))).toEqual([
			libraryFileName(),
		]); // no temporary file left
	});

	it('downloads through an HTTP CONNECT proxy', async () => {
		const proxy = await startConnectProxy();
		try {
			const log: string[] = [];
			await installLibcurl({
				env,
				release: pinned(),
				proxy: `http://user:secret@127.0.0.1:${proxy.port}`,
				log: (line) => log.push(line),
			});
			expect(readFileSync(installed)).toEqual(lib);
			const port = Number(new URL(server.origin).port);
			expect(proxy.requests).toEqual([
				{host: '127.0.0.1', port},
				{host: '127.0.0.1', port},
			]);
			expect(log[0]).toBe(
				`downloading ${server.origin}/rel/lib.tar.gz via http://127.0.0.1:${proxy.port}`,
			); // no credentials in the output
		} finally {
			await proxy.close();
		}
	});

	it('resolves host names at a socks5h:// proxy and locally for socks5://', async () => {
		const proxy = await startSocksProxy();
		const port = Number(new URL(server.origin).port);
		const byName = release(`http://localhost:${port}/rel/`, sha256(archive));
		try {
			await installLibcurl({
				env,
				release: byName,
				proxy: `socks5h://127.0.0.1:${proxy.port}`,
			});
			expect(proxy.requests).toEqual([
				{atyp: 3, host: 'localhost', port},
				{atyp: 3, host: 'localhost', port}, // the redirect
			]);
			expect(readFileSync(installed)).toEqual(lib);
			// localhost may resolve to ::1, where the release server does not
			// listen: only where the name was resolved matters here.
			await installLibcurl({
				env,
				release: byName,
				proxy: `socks5://127.0.0.1:${proxy.port}`,
			}).catch(() => {});
			const local = proxy.requests[2]!;
			expect(local).toMatchObject({port});
			expect(local.atyp).not.toBe(3);
			expect(net.isIP(local.host)).not.toBe(0);
		} finally {
			await proxy.close();
		}
	});

	it('ignores proxy environment variables: the proxy option is the only egress', async () => {
		const proxy = await startConnectProxy();
		const keys = ['http_proxy', 'HTTP_PROXY', 'ALL_PROXY'];
		const saved = keys.map((k) => process.env[k]);
		try {
			for (const k of keys) process.env[k] = `http://127.0.0.1:${proxy.port}`;
			await installLibcurl({env, release: pinned()});
			expect(proxy.requests).toEqual([]);
		} finally {
			keys.forEach((k, i) =>
				saved[i] === undefined
					? delete process.env[k]
					: (process.env[k] = saved[i]),
			);
			await proxy.close();
		}
	});

	it('rejects an unsupported proxy scheme, installing nothing', async () => {
		await expect(
			installLibcurl({env, release: pinned(), proxy: 'ftp://127.0.0.1:1'}),
		).rejects.toThrow(/unsupported proxy scheme/);
		expect(server.hits).toEqual([]);
		expect(readdirSync(tmp)).toEqual([]);
	});
});

describe('extract', () => {
	it('finds a regular file by name, including a GNU long name, and skips symlinks', () => {
		const long = `${'d'.repeat(90)}/${'f'.repeat(40)}.so`;
		const tgz = tarGz([
			{name: 'a.so', type: '2', link: 'b.so'},
			{name: 'b.so', body: Buffer.from('B')},
			{name: long, body: Buffer.from('L')},
		]);
		expect(extract(tgz, 'b.so')?.toString()).toBe('B');
		expect(extract(tgz, long)?.toString()).toBe('L');
		expect(extract(tgz, 'a.so')).toBeUndefined();
	});

	it('rejects something that is not a .tar.gz', () => {
		expect(() => extract(Buffer.from('nope'), 'x')).toThrow(InstallError);
	});
});

describe('serpcast install-libcurl (bin)', () => {
	it('downloads the pinned release only through --proxy, and a failed download installs nothing', async () => {
		// A proxy that refuses every CONNECT: shows where the command goes
		// without reaching the network.
		const asked: string[] = [];
		const proxy = net.createServer((socket) => {
			socket.once('data', (chunk) => {
				asked.push(chunk.toString('latin1').split('\r\n')[0]!);
				socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
		const {port} = proxy.address() as net.AddressInfo;
		try {
			const error = await promisify(execFile)(
				process.execPath,
				[cli, 'install-libcurl', '--proxy', `http://127.0.0.1:${port}`],
				{env: {...process.env, HOME: tmp, XDG_DATA_HOME: join(tmp, 'data')}},
			).catch((e: {code: number; stdout: string; stderr: string}) => e);
			expect(error).toMatchObject({code: 1, stdout: ''});
			const stderr = (error as {stderr: string}).stderr;
			expect(stderr).toMatch(
				/^serpcast: downloading https:\/\/github\.com\/lexiforest\/curl-impersonate\/releases\/download\/v2\.1\.1\/libcurl-impersonate-v2\.1\.1\..*\.tar\.gz via http:\/\/127\.0\.0\.1:\d+$/m,
			);
			expect(stderr).toMatch(/refused.*403.*Nothing was installed/);
			expect(asked).toEqual(['CONNECT github.com:443 HTTP/1.1']);
			expect(existsSync(join(tmp, 'data'))).toBe(false);
		} finally {
			await new Promise((resolve) => proxy.close(resolve));
		}
	});

	it('rejects arguments and options it does not take (exit 2)', async () => {
		for (const args of [
			['install-libcurl', 'extra'],
			['install-libcurl', '--recipe', 'x.json'],
			['doctor', '--force'],
		]) {
			await expect(
				promisify(execFile)(process.execPath, [cli, ...args]),
			).rejects.toMatchObject({code: 2});
		}
	});
});

describe('the only download path', () => {
	const src = fileURLToPath(new URL('../src/', import.meta.url));
	const importers = (module: string) =>
		readdirSync(src).filter((file) =>
			readFileSync(join(src, file), 'utf8').includes(`from './${module}'`),
		);

	it('is install-libcurl: only install.ts downloads, and only the bin imports it', () => {
		expect(importers('download.js')).toEqual(['install.ts']);
		expect(importers('install.js')).toEqual(['cli.ts']);
	});
});
