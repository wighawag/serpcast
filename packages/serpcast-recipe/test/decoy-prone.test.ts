// `decoyProne`: a serpcast addition to the searchcast-introduced schema (kept
// apart from recipe.test.ts, which is the unchanged searchcast port).
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, describe, expect, it} from 'vitest';
import {RecipeError, parseRecipe} from '../src/index.js';
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

describe('parseRecipe: decoyProne', () => {
	it('keeps true and false in its output', () => {
		expect(parseRecipe({...base, decoyProne: true}).decoyProne).toBe(true);
		expect(parseRecipe({...base, decoyProne: false}).decoyProne).toBe(false);
	});

	it('leaves it undefined when absent', () => {
		expect(parseRecipe(base).decoyProne).toBeUndefined();
	});

	it.each([
		['a string', 'yes'],
		['a number', 1],
		['null', null],
	])('rejects %s', (_label, decoyProne) => {
		const parse = () => parseRecipe({...base, decoyProne});
		expect(parse).toThrow(RecipeError);
		expect(parse).toThrow('recipe "web": decoyProne must be a boolean');
	});

	it('round-trips through JSON', () => {
		const recipe = parseRecipe({...base, decoyProne: true});
		expect(parseRecipe(JSON.parse(JSON.stringify(recipe)))).toEqual(recipe);
	});
});

describe('loadRecipeFile: decoyProne', () => {
	const dir = mkdtempSync(join(tmpdir(), 'serpcast-recipe-decoy-'));
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it('reads it from a recipe file', () => {
		const path = join(dir, 'web.json');
		writeFileSync(path, JSON.stringify({...base, decoyProne: true}));
		expect(loadRecipeFile(path).decoyProne).toBe(true);
	});
});
