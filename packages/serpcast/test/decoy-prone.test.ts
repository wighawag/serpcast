// Recipes that declare `decoyProne: true` are decoy-guarded without being
// named in `decoyGuard`: declarative, code (loaded from a file) and
// library-mode browser engines, over the fake transport and a fake searchcast
// module. No network, no browser.

import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseRecipe, type Recipe} from 'serpcast-recipe';
import {afterAll, describe, expect, it} from 'vitest';
import {
	createSerpcast,
	loadCodeRecipe,
	SerpcastError,
	type BrowserEngine,
	type Engine,
	type SearchcastModule,
	type SerpcastOptions,
} from '../src/index.js';
import {engine, fakeTransport, pages} from './engines.js';

const dir = mkdtempSync(join(tmpdir(), 'serpcast-decoy-prone-'));
afterAll(() => rmSync(dir, {recursive: true, force: true}));
let files = 0;
/** Write a module whose body is `source` and return its path. */
function module(source: string): string {
	const path = join(dir, `recipe-${files++}.mjs`);
	writeFileSync(path, source);
	return path;
}

const query = 'debian bookworm backports kernel install';
const decoyTitles = ['RuneScape', 'Kernel', 'Install', 'Wiki'];
const decoy = () => pages.results(...decoyTitles);
const next = engine('next');
const answers = {a: decoy, next: () => pages.results('Next')};
const prone = (name = 'a'): Recipe => ({...engine(name), decoyProne: true});

function setup(options: SerpcastOptions = {}) {
	return createSerpcast({
		transport: fakeTransport(answers).transport,
		...options,
	});
}
const failures = async (engines: Engine[], options?: SerpcastOptions) => {
	const response = await setup(options).search(query, {engines});
	return {
		engine: response.engine,
		failures: response.failures.map((f) => [f.engine, f.error.kind]),
	};
};

describe('decoyProne: declarative recipes', () => {
	it('guards a recipe that declares it, without decoyGuard', async () => {
		expect(await failures([prone(), next])).toEqual({
			engine: 'next',
			failures: [['a', 'decoy']],
		});
	});

	it('does not judge a recipe without it (absent or false) and not named', async () => {
		for (const recipe of [engine('a'), {...engine('a'), decoyProne: false}])
			expect(await failures([recipe, next])).toEqual({
				engine: 'a',
				failures: [],
			});
	});

	it('guards a parsed recipe file that declares it', async () => {
		const recipe = parseRecipe({...engine('a'), decoyProne: true});
		expect((await failures([recipe, next])).engine).toBe('next');
	});

	it('still guards a recipe named in decoyGuard (either one suffices)', async () => {
		const unflagged = {...engine('a'), decoyProne: false};
		expect(
			(await failures([unflagged, next], {decoyGuard: ['a']})).engine,
		).toBe('next');
	});

	it('is switched off by passing the recipe with decoyProne: false', async () => {
		const off = {...prone(), decoyProne: false};
		expect((await failures([off, next])).engine).toBe('a');
	});
});

describe('decoyProne: code recipes', () => {
	const source = (extra: string) => `
		export default {
			name: 'code',
			${extra}
			search: () => ${JSON.stringify(
				decoyTitles.map((title, i) => ({title, url: `https://x.test/${i}`})),
			)},
		};
	`;

	it('guards a loaded code recipe that declares it, without decoyGuard', async () => {
		const recipe = await loadCodeRecipe(module(source('decoyProne: true,')));
		expect(recipe.decoyProne).toBe(true);
		expect(await failures([recipe, next])).toEqual({
			engine: 'next',
			failures: [['code', 'decoy']],
		});
	});

	it('does not judge one without it', async () => {
		const recipe = await loadCodeRecipe(module(source('')));
		expect(recipe).not.toHaveProperty('decoyProne');
		expect((await failures([recipe, next])).engine).toBe('code');
		const off = await loadCodeRecipe(module(source('decoyProne: false,')));
		expect(off.decoyProne).toBe(false);
		expect((await failures([off, next])).engine).toBe('code');
	});

	it.each([
		['a string', "decoyProne: 'yes',"],
		['a number', 'decoyProne: 1,'],
		['null', 'decoyProne: null,'],
	])('rejects %s at load time as a recipe error', async (_, extra) => {
		const path = module(source(extra));
		const error = await loadCodeRecipe(path).then(
			() => expect.fail('expected a failure'),
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(SerpcastError);
		expect((error as SerpcastError).kind).toBe('recipe');
		expect((error as SerpcastError).message).toBe(
			`code recipe ${path}: "decoyProne" must be a boolean`,
		);
	});
});

describe('decoyProne: browser engines', () => {
	const fake: SearchcastModule = {
		Searchcast: class {
			async search() {
				return {
					results: decoyTitles.map((title, i) => ({
						title,
						url: `https://x.test/${i}`,
					})),
				};
			}
			async close() {}
		},
		findChrome: () => '/usr/bin/fake-chrome',
	};
	const browser = (recipe: Recipe): BrowserEngine => ({
		name: 'browser',
		searchcast: {recipe},
	});

	it('inherits it from its declarative recipe (library mode)', async () => {
		const s = setup({searchcast: {module: fake}});
		try {
			const guarded = await s.search(query, {
				engines: [browser(prone('web')), next],
			});
			expect(guarded.failures.map((f) => [f.engine, f.error.kind])).toEqual([
				['browser', 'decoy'],
			]);
			const plain = await s.search(query, {
				engines: [browser(engine('web')), next],
			});
			expect(plain.engine).toBe('browser');
		} finally {
			await s.close();
		}
	});
});
