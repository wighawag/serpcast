// The declarative runner and `serpcast query` through the real transport
// (libcurl-impersonate). Skipped without SERPCAST_LIBCURL_PATH, like the other
// native tests (see test/native-notice.ts).

import {execFile} from 'node:child_process';
import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
	createTransport,
	runDeclarativeRecipe,
	SerpcastError,
} from '../src/index.js';
import {item, recipe, resultsPage, startPageServer} from './pages.js';
import type {PageServer} from './pages.js';

const LIB = process.env.SERPCAST_LIBCURL_PATH;
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

describe.skipIf(!LIB)('declarative runner (native libcurl-impersonate)', () => {
	let server: PageServer;
	let dir: string;
	const transport = createTransport({libcurlPath: LIB});

	beforeAll(async () => {
		server = await startPageServer({
			'/search': {status: 302, headers: {location: '/final'}},
			'/final': {body: resultsPage(item('One', 'one', 'snip'))},
			'/s403': {status: 403, body: ''},
			'/slow': {hang: true},
		});
		dir = mkdtempSync(join(tmpdir(), 'serpcast-native-'));
	});
	afterAll(async () => {
		await server.close();
		rmSync(dir, {recursive: true, force: true});
	});

	it('runs a recipe through the transport, following redirects', async () => {
		const response = await runDeclarativeRecipe(
			recipe(server.origin),
			'hello world',
			{session: transport.session()},
		);
		expect(response).toEqual({
			recipe: 'test',
			results: [
				{
					title: 'One',
					url: `${server.origin}/one`,
					content: 'snip',
					snippet: 'snip',
				},
			],
		});
		expect(server.hits.slice(-2)).toEqual([
			'/search?q=hello%20world',
			'/final',
		]);
	});

	it('maps a 403 to blocked', async () => {
		const error = await runDeclarativeRecipe(
			recipe(server.origin, {
				navigate: {url: `${server.origin}/s403?q={query}`},
			}),
			'q',
			{session: transport.session()},
		).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(SerpcastError);
		expect((error as SerpcastError).kind).toBe('blocked');
	});

	it('a slow page is a timeout', async () => {
		const error = await runDeclarativeRecipe(
			recipe(server.origin, {
				navigate: {url: `${server.origin}/slow?q={query}`},
				timeoutMs: 300,
			}),
			'q',
			{session: transport.session()},
		).catch((e: unknown) => e);
		expect((error as SerpcastError).kind).toBe('timeout');
	});

	it('serpcast query prints the results as JSON', async () => {
		const file = join(dir, 'r.json');
		writeFileSync(file, JSON.stringify(recipe(server.origin)));
		const {stdout} = await promisify(execFile)(process.execPath, [
			cli,
			'query',
			'--recipe',
			file,
			'--libcurl',
			LIB!,
			'hello',
		]);
		expect(JSON.parse(stdout)).toEqual({
			recipe: 'test',
			results: [
				{
					title: 'One',
					url: `${server.origin}/one`,
					content: 'snip',
					snippet: 'snip',
				},
			],
		});
	});
});
