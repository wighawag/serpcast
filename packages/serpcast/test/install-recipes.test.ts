// `serpcast install-recipes` and `serpcast recipes list`, against a local
// release server and local files (no network). Every test installs into a temp
// XDG_DATA_HOME and checks the real data directory is untouched.

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
import {recipesDir} from '../src/index.js';
import {InstallError} from '../src/install.js';
import {installRecipes} from '../src/install-recipes.js';
import {listRecipeSets} from '../src/recipes.js';
import {
	realDataDirs,
	sha256,
	startReleaseServer,
	tarGz,
	type ReleaseServer,
	type TarEntry,
} from './release.js';
import {startConnectProxy} from './servers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = promisify(execFile);

const RECIPE = Buffer.from('{"name": "web"}\n');
const CODE = Buffer.from(
	'export default {name: "api", search() { return []; }};\n',
);
const HELPER = Buffer.from('export const x = 1;\n');
const manifest = (name: string, version = '1.2.0') =>
	Buffer.from(JSON.stringify({name, version}));

/** A release archive: the files at the root, or under `top/`. */
const release = (files: Record<string, Buffer>, top?: string): Buffer =>
	tarGz([
		...(top ? [{name: `${top}/`, type: '5'}] : []),
		...Object.entries(files).map(([name, body]) => ({
			name: top ? `${top}/${name}` : name,
			body,
		})),
	]);

const withManifest = release(
	{'manifest.json': manifest('my-set'), 'web.json': RECIPE, 'api.mjs': CODE},
	'my-set-1.2.0',
);

let server: ReleaseServer;
beforeAll(async () => {
	server = await startReleaseServer({
		'/releases/download/v1/set.tar.gz': {
			status: 302,
			location: '/blob/set.tar.gz',
		},
		'/blob/set.tar.gz': withManifest,
	});
});
afterAll(() => server.close());

const snapshot = realDataDirs();
let before: unknown[];
let tmp: string;
let env: NodeJS.ProcessEnv;
let base: string;
beforeEach(() => {
	before = snapshot();
	tmp = mkdtempSync(join(tmpdir(), 'serpcast-recipes-'));
	env = {XDG_DATA_HOME: join(tmp, 'data')};
	base = join(tmp, 'data', 'serpcast', 'recipes');
	server.hits.length = 0;
});
afterEach(() => {
	rmSync(tmp, {recursive: true, force: true});
	expect(snapshot()).toEqual(before); // the real data directory is untouched
});

/** Write `archive` into the temp dir and return its path. */
const file = (archive: Buffer, name = 'set.tar.gz') => {
	const path = join(tmp, name);
	writeFileSync(path, archive);
	return path;
};
const url = `/releases/download/v1/set.tar.gz`;

describe('recipesDir', () => {
	it('is recipes/ in the data directory', () => {
		expect(recipesDir(env)).toBe(base);
		expect(recipesDir({})).toMatch(/\.local\/share\/serpcast\/recipes$/);
	});
});

describe('installRecipes', () => {
	it('downloads a URL, verifies it and installs the set named by its manifest (with a top-level directory)', async () => {
		const log: string[] = [];
		const result = await installRecipes(server.origin + url, {
			sha256: sha256(withManifest),
			env,
			log: (line) => log.push(line),
		});
		const dir = join(base, 'my-set');
		expect(result).toEqual({
			name: 'my-set',
			dir,
			status: 'installed',
			files: {
				'api.mjs': sha256(CODE),
				'manifest.json': sha256(manifest('my-set')),
				'web.json': sha256(RECIPE),
			},
		});
		expect(server.hits).toEqual([url, '/blob/set.tar.gz']);
		expect(readdirSync(base)).toEqual(['my-set']); // no temporary left
		expect(readdirSync(dir).sort()).toEqual([
			'.source.json',
			'api.mjs',
			'manifest.json',
			'web.json',
		]);
		expect(readFileSync(join(dir, 'api.mjs'))).toEqual(CODE);
		expect(
			JSON.parse(readFileSync(join(dir, '.source.json'), 'utf8')),
		).toMatchObject({
			source: server.origin + url,
			url: `${server.origin}/blob/set.tar.gz`,
			sha256: sha256(withManifest),
			manifest: {name: 'my-set', version: '1.2.0'},
			files: result.files,
		});
		expect(log).toEqual([
			`downloading ${server.origin}${url}`,
			`verified sha256 ${sha256(withManifest)} (pinned with --sha256)`,
			`installed recipe set my-set in ${dir}:`,
			`  api.mjs  sha256 ${sha256(CODE)}`,
			`  manifest.json  sha256 ${sha256(manifest('my-set'))}`,
			`  web.json  sha256 ${sha256(RECIPE)}`,
		]);
	});

	it('installs a local file with files at the root and no manifest, named by --name', async () => {
		const archive = release({'web.json': RECIPE, 'lib.js': HELPER});
		const path = file(archive);
		const result = await installRecipes(path, {
			sha256: sha256(archive).toUpperCase(),
			name: 'mine',
			env,
		});
		expect(result.dir).toBe(join(base, 'mine'));
		expect(readdirSync(result.dir).sort()).toEqual([
			'.source.json',
			'lib.js',
			'web.json',
		]);
		const [set] = listRecipeSets(base);
		expect(set).toMatchObject({
			name: 'mine',
			files: ['lib.js', 'web.json'],
			source: {source: path, sha256: sha256(archive)},
		});
		expect(set!.source!.url).toBeUndefined();
		expect(set!.source!.manifest).toBeUndefined();
	});

	it('accepts ./-prefixed entries and a top-level directory without a directory entry; --name overrides the manifest', async () => {
		const archive = tarGz([
			{name: './', type: '5'},
			{name: './set/manifest.json', body: manifest('from-manifest')},
			{name: './set/web.json', body: RECIPE},
		]);
		const result = await installRecipes(file(archive), {
			sha256: sha256(archive),
			name: 'renamed',
			env,
		});
		expect(result.name).toBe('renamed');
		expect(listRecipeSets(base)[0]!.source!.manifest).toEqual({
			name: 'from-manifest',
			version: '1.2.0',
		});
	});

	it('refuses a missing or malformed --sha256 before reading anything', async () => {
		for (const pin of [undefined, '', 'abc', '0'.repeat(63)]) {
			await expect(
				installRecipes(server.origin + url, {sha256: pin as string, env}),
			).rejects.toThrow(/--sha256 <hex> is required.*Nothing was installed/);
		}
		expect(server.hits).toEqual([]);
		expect(readdirSync(tmp)).toEqual([]);
	});

	it('refuses a checksum mismatch, for a URL and a file, installing nothing', async () => {
		const error = await installRecipes(server.origin + url, {
			sha256: '0'.repeat(64),
			env,
		}).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(InstallError);
		expect((error as Error).message).toMatch(/checksum mismatch/);
		expect((error as Error).message).toContain(sha256(withManifest));
		const path = file(withManifest);
		await expect(
			installRecipes(path, {sha256: 'f'.repeat(64), env}),
		).rejects.toThrow(/checksum mismatch.*Nothing was installed/);
		expect(readdirSync(tmp)).toEqual(['set.tar.gz']); // no data directory
	});

	const bad: [string, TarEntry[], RegExp][] = [
		['a .. path', [{name: '../evil.mjs', body: CODE}], /leaves the archive/],
		[
			'a .. inside a path',
			[{name: 'set/../../evil.mjs', body: CODE}],
			/leaves the archive/,
		],
		['an absolute path', [{name: '/tmp/evil.mjs', body: CODE}], /absolute/],
		[
			'a symlink',
			[
				{name: 'web.json', body: RECIPE},
				{name: 'x.mjs', type: '2', link: '/etc/passwd'},
			],
			/is a link/,
		],
		[
			'a hard link',
			[
				{name: 'web.json', body: RECIPE},
				{name: 'x.mjs', type: '1', link: 'web.json'},
			],
			/is a link/,
		],
		[
			'a non-recipe file type',
			[
				{name: 'web.json', body: RECIPE},
				{name: 'run.sh', body: Buffer.from('#!/bin/sh')},
			],
			/"run.sh" is not a \*\.mjs, \*\.js or \*\.json file/,
		],
		[
			'a hidden file',
			[
				{name: 'web.json', body: RECIPE},
				{name: '._web.json', body: RECIPE},
			],
			/hidden file/,
		],
		[
			'a nested directory',
			[{name: 'set/sub/web.json', body: RECIPE}],
			/nested directory/,
		],
		['a device', [{name: 'dev.js', type: '3'}], /not a regular file/],
		[
			'two top-level directories',
			[
				{name: 'a/web.json', body: RECIPE},
				{name: 'b/api.mjs', body: CODE},
			],
			/must all be at its root or all under one top-level directory/,
		],
		[
			'root files beside a top-level directory',
			[
				{name: 'web.json', body: RECIPE},
				{name: 'b/api.mjs', body: CODE},
			],
			/must all be at its root or all under one/,
		],
		['no recipe files', [{name: 'set/', type: '5'}], /no recipe files/],
		[
			'a manifest that is not JSON',
			[{name: 'manifest.json', body: Buffer.from('{')}],
			/manifest.json is not JSON/,
		],
		[
			'a manifest name that is a path',
			[{name: 'manifest.json', body: manifest('../up')}],
			/manifest.json name "..\/up" is not a set name/,
		],
		[
			'no manifest name and no --name',
			[{name: 'web.json', body: RECIPE}],
			/no manifest.json name; give the set a name with --name/,
		],
	];
	for (const [what, entries, message] of bad) {
		it(`refuses ${what}, installing nothing`, async () => {
			const archive = tarGz(entries);
			const error = await installRecipes(file(archive), {
				sha256: sha256(archive),
				env,
			}).catch((e: unknown) => e);
			expect(error).toBeInstanceOf(InstallError);
			expect((error as Error).message).toMatch(message);
			expect((error as Error).message).toMatch(/Nothing was installed/);
			expect(readdirSync(tmp)).toEqual(['set.tar.gz']);
		});
	}

	it('refuses a --name that is not a set name, a non-http URL, and --proxy with a file', async () => {
		const path = file(withManifest);
		const pin = sha256(withManifest);
		await expect(
			installRecipes(path, {sha256: pin, env, name: '../x'}),
		).rejects.toThrow(/--name "..\/x" is not a set name/);
		await expect(
			installRecipes('ftp://example.com/x.tar.gz', {sha256: pin, env}),
		).rejects.toThrow(/neither an http\(s\) URL nor a file path/);
		await expect(
			installRecipes(path, {sha256: pin, env, proxy: 'http://127.0.0.1:1'}),
		).rejects.toThrow(/--proxy applies to a download only/);
		await expect(
			installRecipes(join(tmp, 'missing.tar.gz'), {sha256: pin, env}),
		).rejects.toThrow(/reading .* failed.*Nothing was installed/);
		expect(readdirSync(tmp)).toEqual(['set.tar.gz']);
	});

	it('leaves an identical set alone, refuses a differing one without --force, replaces it with --force', async () => {
		const pin = sha256(withManifest);
		const path = file(withManifest);
		const dir = join(base, 'my-set');
		await installRecipes(path, {sha256: pin, env});
		const recorded = readFileSync(join(dir, '.source.json'), 'utf8');
		expect(await installRecipes(path, {sha256: pin, env})).toMatchObject({
			status: 'unchanged',
		});
		expect(readFileSync(join(dir, '.source.json'), 'utf8')).toBe(recorded);

		const v2 = release({
			'manifest.json': manifest('my-set', '2.0.0'),
			'web.json': Buffer.from('{"name": "web2"}'),
		});
		const path2 = file(v2, 'v2.tar.gz');
		await expect(
			installRecipes(path2, {sha256: sha256(v2), env}),
		).rejects.toThrow(
			/already exists and differs.*--force.*Nothing was installed/,
		);
		expect(readdirSync(dir).sort()).toEqual([
			'.source.json',
			'api.mjs',
			'manifest.json',
			'web.json',
		]);
		expect(readFileSync(join(dir, 'web.json'))).toEqual(RECIPE);

		expect(
			await installRecipes(path2, {sha256: sha256(v2), env, force: true}),
		).toMatchObject({status: 'replaced'});
		expect(readdirSync(dir).sort()).toEqual([
			'.source.json',
			'manifest.json',
			'web.json',
		]); // the old set's api.mjs is gone: replaced, not merged
		expect(readdirSync(base)).toEqual(['my-set']); // nothing left aside
		expect(listRecipeSets(base)[0]!.source!.manifest!.version).toBe('2.0.0');
	});

	it('installs into --dir instead of the data directory', async () => {
		const other = join(tmp, 'elsewhere');
		const result = await installRecipes(file(withManifest), {
			sha256: sha256(withManifest),
			dir: other,
			env,
		});
		expect(result.dir).toBe(join(other, 'my-set'));
		expect(existsSync(join(tmp, 'data'))).toBe(false);
	});

	it('downloads through the proxy only, ignoring proxy environment variables', async () => {
		const proxy = await startConnectProxy();
		const keys = ['http_proxy', 'HTTP_PROXY', 'ALL_PROXY'];
		const saved = keys.map((k) => process.env[k]);
		try {
			await installRecipes(server.origin + url, {
				sha256: sha256(withManifest),
				proxy: `http://127.0.0.1:${proxy.port}`,
				env,
			});
			expect(proxy.requests).toHaveLength(2); // the URL and its redirect
			rmSync(base, {recursive: true});
			for (const k of keys) process.env[k] = `http://127.0.0.1:${proxy.port}`;
			await installRecipes(server.origin + url, {
				sha256: sha256(withManifest),
				env,
			});
			expect(proxy.requests).toHaveLength(2); // no more through the env proxy
		} finally {
			keys.forEach((k, i) =>
				saved[i] === undefined
					? delete process.env[k]
					: (process.env[k] = saved[i]),
			);
			await proxy.close();
		}
	});

	it('fails on an HTTP error, installing nothing', async () => {
		await expect(
			installRecipes(`${server.origin}/missing.tar.gz`, {
				sha256: sha256(withManifest),
				env,
			}),
		).rejects.toThrow(/HTTP 404.*Nothing was installed/);
		expect(readdirSync(tmp)).toEqual([]);
	});
});

describe('serpcast install-recipes and recipes list (bin)', () => {
	const cliEnv = () => ({
		...process.env,
		HOME: tmp,
		XDG_DATA_HOME: env.XDG_DATA_HOME,
	});

	it('installs a file, prints the set directory on stdout, and recipes list shows it', async () => {
		const path = file(withManifest);
		const {stdout, stderr} = await run(
			process.execPath,
			[cli, 'install-recipes', path, '--sha256', sha256(withManifest)],
			{env: cliEnv()},
		);
		expect(stdout).toBe(join(base, 'my-set') + '\n');
		expect(stderr).toContain(`serpcast:   api.mjs  sha256 ${sha256(CODE)}`);
		const list = await run(process.execPath, [cli, 'recipes', 'list'], {
			env: cliEnv(),
		});
		expect(list.stdout).toContain(`recipe sets in ${base}:`);
		expect(list.stdout).toMatch(/^my-set 1\.2\.0$/m);
		expect(list.stdout).toContain(`  source:    ${path}`);
		expect(list.stdout).toContain(`  sha256:    ${sha256(withManifest)}`);
		expect(list.stdout).toContain(`  web.json  sha256 ${sha256(RECIPE)}`);
	});

	it('recipes list says so when nothing is installed', async () => {
		const {stdout} = await run(process.execPath, [cli, 'recipes', 'list'], {
			env: cliEnv(),
		});
		expect(stdout).toBe(`no recipe sets installed in ${base}\n`);
		expect(existsSync(join(tmp, 'data'))).toBe(false);
	});

	it('fails a checksum mismatch with exit 1, installing nothing', async () => {
		const error = await run(
			process.execPath,
			[cli, 'install-recipes', file(withManifest), '--sha256', '0'.repeat(64)],
			{env: cliEnv()},
		).catch((e: {code: number; stdout: string; stderr: string}) => e);
		expect(error).toMatchObject({code: 1, stdout: ''});
		expect((error as {stderr: string}).stderr).toMatch(
			/^serpcast: checksum mismatch.*Nothing was installed/m,
		);
		expect(existsSync(join(tmp, 'data'))).toBe(false);
	});

	it('downloads a URL only through --proxy', async () => {
		// A proxy that refuses every CONNECT: shows where the command goes.
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
			const error = await run(
				process.execPath,
				[
					cli,
					'install-recipes',
					'https://github.com/o/r/releases/download/v1/set.tar.gz',
					'--sha256',
					'0'.repeat(64),
					'--proxy',
					`http://127.0.0.1:${port}`,
				],
				{env: cliEnv()},
			).catch((e: {code: number; stderr: string}) => e);
			expect(error).toMatchObject({code: 1});
			expect((error as {stderr: string}).stderr).toMatch(
				/refused.*403.*Nothing was installed/,
			);
			expect(asked).toEqual(['CONNECT github.com:443 HTTP/1.1']);
			expect(existsSync(join(tmp, 'data'))).toBe(false);
		} finally {
			await new Promise((resolve) => proxy.close(resolve));
		}
	});

	it('usage errors (exit 2): no --sha256, no source, extra arguments, a foreign option, a bad subcommand', async () => {
		const path = file(withManifest);
		for (const args of [
			['install-recipes', path],
			['install-recipes', '--sha256', sha256(withManifest)],
			['install-recipes', path, path, '--sha256', sha256(withManifest)],
			['install-recipes', path, '--sha256', 'x', '--recipe', 'y.json'],
			['recipes'],
			['recipes', 'remove'],
			['recipes', 'list', '--force'],
			['install-libcurl', '--sha256', 'x'],
		]) {
			const error = await run(process.execPath, [cli, ...args], {
				env: cliEnv(),
			}).catch((e: {code: number; stderr: string}) => e);
			expect(error, args.join(' ')).toMatchObject({code: 2});
		}
		const error = await run(process.execPath, [cli, 'install-recipes', path], {
			env: cliEnv(),
		}).catch((e: {stderr: string}) => e);
		expect((error as {stderr: string}).stderr).toMatch(
			/needs --sha256 <hex>.*trust decision/,
		);
		expect(existsSync(join(tmp, 'data'))).toBe(false);
	});
});

describe('recipesDir is a plain path', () => {
	it('lists nothing and creates nothing when the directory is missing', () => {
		expect(listRecipeSets(base)).toEqual([]);
		mkdirSync(base, {recursive: true});
		mkdirSync(join(base, '.half.123.tmp'));
		expect(listRecipeSets(base)).toEqual([]); // install's temporaries are skipped
	});
});
