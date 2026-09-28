import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import * as entry from '../src/index.js';
import {
	DEFAULT_LIMIT,
	DEFAULT_TIMEOUT_MS,
	RecipeError,
	packageName,
	parseRecipe,
	requiresBrowser,
} from '../src/index.js';
import {loadRecipeFile} from '../src/node.js';

const base = {
	name: 'web',
	navigate: {url: 'https://example.test/?q={query}'},
	ready: '.r',
	results: {
		item: '.r',
		fields: {title: {selector: 'h2'}, url: {selector: 'a', attr: 'href'}},
	},
};
const {navigate: _navigate, ...withoutInput} = base;
const formRecipe = {
	...withoutInput,
	form: {url: 'https://example.test/', input: 'input'},
};

describe('entry', () => {
	it('exports its package name', () => {
		expect(packageName).toBe('serpcast-recipe');
	});

	it('does not export the node-only loaders', () => {
		expect(Object.keys(entry)).not.toContain('loadRecipes');
		expect(Object.keys(entry)).not.toContain('loadRecipeFile');
	});

	it.each(['index.ts', 'recipe.ts'])(
		'%s imports nothing from node:*',
		(file) => {
			const source = readFileSync(
				new URL(`../src/${file}`, import.meta.url),
				'utf8',
			);
			expect(source).not.toMatch(/from\s+['"]node:/);
			expect(source).not.toMatch(/import\(\s*['"]node:/);
		},
	);
});

describe('parseRecipe output shape', () => {
	it('leaves limit and timeoutMs undefined when absent', () => {
		const recipe = parseRecipe(base);
		expect(recipe.limit).toBeUndefined();
		expect(recipe.timeoutMs).toBeUndefined();
	});

	it('keeps limit and timeoutMs when set', () => {
		const recipe = parseRecipe({...base, limit: 5, timeoutMs: 2000});
		expect(recipe.limit).toBe(5);
		expect(recipe.timeoutMs).toBe(2000);
	});

	it('uses the fallback name only when name is absent', () => {
		const {name: _name, ...unnamed} = base;
		expect(parseRecipe(unnamed, 'fallback').name).toBe('fallback');
		expect(parseRecipe(base, 'fallback').name).toBe('web');
		expect(() => parseRecipe(unnamed)).toThrow(
			'name must be a non-empty string',
		);
	});

	it.each([
		[
			'missing ready',
			{...base, ready: undefined},
			'recipe "web": ready must be a non-empty string',
		],
		[
			'missing url field',
			{...base, results: {item: '.r', fields: {title: {}}}},
			'recipe "web": results.fields.url is required',
		],
		['non-object input', [], 'recipe must be a JSON object'],
		[
			'empty form.submit.click',
			{...formRecipe, form: {...formRecipe.form, submit: {click: ''}}},
			'recipe "web": form.submit.click must be a non-empty string',
		],
		[
			'non-integer timeoutMs',
			{...base, timeoutMs: 1.5},
			'recipe "web": timeoutMs must be a positive integer',
		],
		[
			'non-array blocked',
			{...base, blocked: '#captcha'},
			'recipe "web": blocked must be an array of strings',
		],
	])('rejects %s with the searchcast message', (_label, value, message) => {
		expect(() => parseRecipe(value)).toThrow(RecipeError);
		expect(() => parseRecipe(value)).toThrow(message);
	});
});

describe('defaults', () => {
	it('match the documented values', () => {
		expect(DEFAULT_LIMIT).toBe(10);
		expect(DEFAULT_TIMEOUT_MS).toBe(15000);
	});
});

describe('requiresBrowser', () => {
	it('is true for a form recipe', () => {
		expect(requiresBrowser(parseRecipe(formRecipe))).toBe(true);
	});

	it('is false for a navigate recipe', () => {
		expect(requiresBrowser(parseRecipe(base))).toBe(false);
	});
});

describe('loadRecipeFile', () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, {recursive: true, force: true});
	});
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), 'serpcast-recipe-'));
		dirs.push(dir);
		return dir;
	};

	it('names an unnamed recipe after its file', () => {
		const dir = tempDir();
		const {name: _name, ...unnamed} = base;
		writeFileSync(join(dir, 'gamma.json'), JSON.stringify(unnamed));
		expect(loadRecipeFile(join(dir, 'gamma.json')).name).toBe('gamma');
	});

	it('reports invalid JSON as a RecipeError prefixed by the path', () => {
		const dir = tempDir();
		const file = join(dir, 'broken.json');
		writeFileSync(file, '{');
		expect(() => loadRecipeFile(file)).toThrow(RecipeError);
		expect(() => loadRecipeFile(file)).toThrow(`${file}: `);
	});
});
