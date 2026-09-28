// Ported from searchcast's test/recipe.test.ts: the cases and expected
// messages are unchanged; only the imports moved (the loaders live on the
// node subpath).
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {RecipeError, parseRecipe} from '../src/index.js';
import {loadRecipes} from '../src/node.js';

const base = {
	name: 'web',
	navigate: {url: 'https://example.test/?q={query}'},
	ready: '.r',
	results: {
		item: '.r',
		fields: {title: {selector: 'h2'}, url: {selector: 'a', attr: 'href'}},
	},
};

describe('parseRecipe', () => {
	it('accepts a minimal navigate recipe', () => {
		const recipe = parseRecipe(base);
		expect(recipe.name).toBe('web');
		expect(recipe.navigate?.url).toContain('{query}');
		expect(recipe.results.fields.url).toEqual({selector: 'a', attr: 'href'});
	});

	it('accepts a form recipe; submit defaults to enter', () => {
		const {navigate, ...rest} = base;
		expect(
			parseRecipe({
				...rest,
				form: {url: 'https://example.test/', input: 'input'},
			}).form?.submit,
		).toBe('enter');
		expect(
			parseRecipe({
				...rest,
				form: {
					url: 'https://example.test/',
					input: 'input',
					submit: {click: 'button'},
				},
			}).form?.submit,
		).toEqual({click: 'button'});
	});

	it.each([
		[
			'neither navigate nor form',
			{...base, navigate: undefined},
			/exactly one of/,
		],
		[
			'both navigate and form',
			{...base, form: {url: 'x', input: 'i'}},
			/exactly one of/,
		],
		[
			'navigate url without {query}',
			{...base, navigate: {url: 'https://example.test/'}},
			/\{query\}/,
		],
		[
			'missing title field',
			{...base, results: {item: '.r', fields: {url: {attr: 'href'}}}},
			/title is required/,
		],
		['missing ready', {...base, ready: undefined}, /ready must be/],
		['bad limit', {...base, limit: 0}, /limit must be a positive integer/],
		[
			'bad blockedUrl regex',
			{...base, blockedUrl: ['(']},
			/not a valid regular expression/,
		],
		[
			'bad submit',
			{
				...base,
				navigate: undefined,
				form: {url: 'x', input: 'i', submit: 'tab'},
			},
			/form.submit/,
		],
	])('rejects %s', (_label, value, message) => {
		expect(() => parseRecipe(value)).toThrow(RecipeError);
		expect(() => parseRecipe(value)).toThrow(message);
	});
});

describe('loadRecipes', () => {
	const dirs: string[] = [];
	const tempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), 'searchcast-recipes-'));
		dirs.push(dir);
		return dir;
	};
	afterAll(() => {
		for (const dir of dirs) rmSync(dir, {recursive: true, force: true});
	});

	it('loads a directory, naming recipes after their file when unnamed', () => {
		const dir = tempDir();
		const {name, ...unnamed} = base;
		writeFileSync(join(dir, 'alpha.json'), JSON.stringify(unnamed));
		writeFileSync(
			join(dir, 'beta.json'),
			JSON.stringify({...base, name: 'beta'}),
		);
		writeFileSync(join(dir, 'notes.txt'), 'ignored');
		expect([...loadRecipes([dir]).keys()]).toEqual(['alpha', 'beta']);
	});

	it('rejects duplicate names', () => {
		const dir = tempDir();
		writeFileSync(join(dir, 'a.json'), JSON.stringify(base));
		writeFileSync(join(dir, 'b.json'), JSON.stringify(base));
		expect(() => loadRecipes([dir])).toThrow(/duplicate recipe name "web"/);
	});
});
