import {execFile} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterAll, describe, expect, it} from 'vitest';
import {packageName as recipePackageName} from 'serpcast-recipe';
import {packageName, usage} from '../src/index.js';

const run = promisify(execFile);
// The built bin; the verify gate builds before it tests.
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe('serpcast placeholder', () => {
	it('exports its package name', () => {
		expect(packageName).toBe('serpcast');
	});

	it('usage names the bin', () => {
		expect(usage()).toMatch(/^Usage: serpcast /);
	});

	it('resolves serpcast-recipe through the workspace', () => {
		expect(recipePackageName).toBe('serpcast-recipe');
	});
});

describe('serpcast bin', () => {
	it('prints usage with --help and exits 0', async () => {
		const {stdout} = await run(process.execPath, [cli, '--help']);
		expect(stdout.trim()).toBe(usage());
	});

	it('rejects an unknown command as a usage error (exit 2)', async () => {
		await expect(run(process.execPath, [cli, 'nope'])).rejects.toMatchObject({
			code: 2,
			stderr: expect.stringContaining('unknown command: nope'),
		});
	});
});

describe('serpcast query (no native library needed)', () => {
	const dir = mkdtempSync(join(tmpdir(), 'serpcast-cli-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));
	const file = (name: string, recipe: object) => {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify(recipe));
		return path;
	};
	const results = {item: '.r', fields: {title: {}, url: {attr: 'href'}}};
	// No library anywhere: empty env overrides and a temp data dir.
	const env = {
		...process.env,
		SERPCAST_LIBCURL_PATH: '',
		LIBCURL_PATH: '',
		HOME: dir,
		XDG_DATA_HOME: dir,
	};
	const query = (...args: string[]) =>
		run(process.execPath, [cli, 'query', ...args], {env});

	it('needs --recipe and a query (exit 2)', async () => {
		await expect(query('hello')).rejects.toMatchObject({
			code: 2,
			stderr: expect.stringContaining('query needs --recipe <file>'),
		});
		const nav = file('nav.json', {
			navigate: {url: 'http://127.0.0.1:9/?q={query}'},
			ready: '#x',
			results,
		});
		await expect(query('--recipe', nav)).rejects.toMatchObject({
			code: 2,
			stderr: expect.stringContaining('query needs a query'),
		});
	});

	it('reports an invalid recipe file as a recipe failure (exit 1)', async () => {
		const bad = file('bad.json', {navigate: {url: 'no-placeholder'}});
		await expect(query('--recipe', bad, 'q')).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringMatching(/^serpcast: recipe: .*navigate\.url/),
		});
	});

	it('rejects a form recipe before loading anything (exit 1)', async () => {
		const form = file('form.json', {
			form: {url: 'http://127.0.0.1:9/', input: 'input'},
			ready: '#x',
			results,
		});
		await expect(query('--recipe', form, 'q')).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringMatching(/^serpcast: recipe: form: .*searchcast/),
		});
	});

	it('fails with impersonation when no library is found (exit 1)', async () => {
		const nav = file('nav2.json', {
			navigate: {url: 'http://127.0.0.1:9/?q={query}'},
			ready: '#x',
			results,
		});
		await expect(query('--recipe', nav, 'q')).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringMatching(/^serpcast: impersonation: /),
		});
	});
});
