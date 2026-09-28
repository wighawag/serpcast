// Locating the library, and what happens when there is none. No native library
// is needed here. Tests that touch HOME or the data dir point them at a temp
// dir and check the real ones are untouched.

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
	createTransport,
	dataDir,
	LIBCURL_IMPERSONATE,
	libraryFileName,
	resolveLibraryPath,
} from '../src/index.js';
import {startH2Server} from './servers.js';

const ENV_KEYS = [
	'HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'SERPCAST_LIBCURL_PATH',
	'LIBCURL_PATH',
];

describe('pinned libcurl-impersonate release', () => {
	it('names one version and a sha256 per platform archive of that version', () => {
		expect(LIBCURL_IMPERSONATE.version).toBe('2.1.1');
		expect(LIBCURL_IMPERSONATE.baseUrl).toContain(
			`/v${LIBCURL_IMPERSONATE.version}/`,
		);
		const assets = Object.entries(LIBCURL_IMPERSONATE.assets);
		expect(assets.map(([platform]) => platform)).toEqual(
			expect.arrayContaining([
				'linux-x64',
				'linux-arm64',
				'darwin-x64',
				'darwin-arm64',
			]),
		);
		for (const [, asset] of assets) {
			expect(asset.archive).toContain(`-v${LIBCURL_IMPERSONATE.version}.`);
			expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
		}
	});
});

describe('resolveLibraryPath', () => {
	let tmp: string;
	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), 'serpcast-resolve-'));
	});
	afterEach(() => rmSync(tmp, {recursive: true, force: true}));

	it('prefers the option, then SERPCAST_LIBCURL_PATH, then LIBCURL_PATH, then the data dir', () => {
		const env = {
			XDG_DATA_HOME: tmp,
			SERPCAST_LIBCURL_PATH: '/a.so',
			LIBCURL_PATH: '/b.so',
		};
		expect(resolveLibraryPath('/opt.so', env)).toBe('/opt.so');
		expect(resolveLibraryPath(undefined, env)).toBe('/a.so');
		expect(
			resolveLibraryPath(undefined, {...env, SERPCAST_LIBCURL_PATH: ''}),
		).toBe('/b.so');
		expect(resolveLibraryPath(undefined, {XDG_DATA_HOME: tmp})).toBeUndefined();
		const installed = join(tmp, 'serpcast', libraryFileName());
		mkdirSync(join(tmp, 'serpcast'));
		writeFileSync(installed, '');
		expect(resolveLibraryPath(undefined, {XDG_DATA_HOME: tmp})).toBe(installed);
	});

	it('puts the data dir under XDG_DATA_HOME, else ~/.local/share', () => {
		expect(dataDir({XDG_DATA_HOME: '/x'})).toBe('/x/serpcast');
		expect(dataDir({})).toBe(join(homedir(), '.local', 'share', 'serpcast'));
	});
});

describe('with no library available', () => {
	const saved: Record<string, string | undefined> = {};
	const realHome = homedir();
	const realDirs = [
		join(realHome, '.local', 'share', 'serpcast'),
		join(realHome, '.cache', 'impers'),
		...(process.env.XDG_DATA_HOME
			? [join(process.env.XDG_DATA_HOME, 'serpcast')]
			: []),
		...(process.env.XDG_CACHE_HOME
			? [join(process.env.XDG_CACHE_HOME, 'impers')]
			: []),
	];
	const snapshot = () =>
		realDirs.map((d) => (existsSync(d) ? statSync(d).mtimeMs : 'absent'));
	let tmp: string;
	let before: unknown[];

	beforeEach(() => {
		before = snapshot();
		tmp = mkdtempSync(join(tmpdir(), 'serpcast-home-'));
		for (const key of ENV_KEYS) saved[key] = process.env[key];
		delete process.env.SERPCAST_LIBCURL_PATH;
		delete process.env.LIBCURL_PATH;
		process.env.HOME = tmp;
		process.env.XDG_DATA_HOME = join(tmp, 'data');
		process.env.XDG_CACHE_HOME = join(tmp, 'cache');
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
		rmSync(tmp, {recursive: true, force: true});
		expect(snapshot()).toEqual(before); // the real HOME and data dir are untouched
	});

	it('fails the first request with an impersonation error, makes no network call and writes nothing', async () => {
		const server = await startH2Server((_req, res) =>
			res.end('should not be reached'),
		);
		try {
			const error = await createTransport()
				.session()
				.request(`https://localhost:${server.port}/`, {kind: 'document'})
				.catch((e: unknown) => e);
			expect(error).toMatchObject({kind: 'impersonation'});
			expect((error as Error).message).toMatch(/serpcast install-libcurl/);
			expect((error as Error).message).toMatch(/SERPCAST_LIBCURL_PATH/);
			expect(server.connections).toBe(0);
		} finally {
			await server.close();
		}
		expect(readdirSync(tmp)).toEqual([]); // no download, no cache, no data dir
	});

	it('fails in non-strict mode too: there is nothing to send with', async () => {
		await expect(
			createTransport({strict: false}).check(),
		).rejects.toMatchObject({kind: 'impersonation'});
		expect(readdirSync(tmp)).toEqual([]);
	});

	it('names the missing file when the configured path does not exist', async () => {
		const missing = join(tmp, 'nope.so');
		await expect(
			createTransport({libcurlPath: missing}).check(),
		).rejects.toMatchObject({
			kind: 'impersonation',
			message: expect.stringContaining(missing),
		});
	});
});

describe('no runtime download path', () => {
	it('does not depend on impers (whose first import downloads the library)', () => {
		const manifest = JSON.parse(
			readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
		);
		expect(
			Object.keys({...manifest.dependencies, ...manifest.optionalDependencies}),
		).not.toContain('impers');
	});
});
