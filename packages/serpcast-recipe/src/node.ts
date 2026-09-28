// Node-only recipe loaders, published on the `serpcast-recipe/node` subpath so
// the main entry stays usable without `node:fs`. Extracted unchanged from
// searchcast's `src/recipe.ts` (searchcast@0.1.1).

import {readFileSync, readdirSync, statSync} from 'node:fs';
import {basename, extname, join} from 'node:path';
import {RecipeError, parseRecipe, type Recipe} from './recipe.js';

/** Read one recipe file. The name defaults to the file name without `.json`. */
export function loadRecipeFile(path: string): Recipe {
	let json: unknown;
	try {
		json = JSON.parse(readFileSync(path, 'utf8'));
	} catch (e) {
		throw new RecipeError(`${path}: ${(e as Error).message}`);
	}
	return parseRecipe(json, basename(path, extname(path)));
}

/** Load recipes from files and directories (every `*.json` inside). */
export function loadRecipes(paths: string[]): Map<string, Recipe> {
	const files: string[] = [];
	for (const p of paths) {
		if (statSync(p).isDirectory()) {
			for (const entry of readdirSync(p).sort()) {
				if (entry.endsWith('.json')) files.push(join(p, entry));
			}
		} else {
			files.push(p);
		}
	}
	const recipes = new Map<string, Recipe>();
	for (const file of files) {
		const recipe = loadRecipeFile(file);
		if (recipes.has(recipe.name)) {
			throw new RecipeError(`${file}: duplicate recipe name "${recipe.name}"`);
		}
		recipes.set(recipe.name, recipe);
	}
	return recipes;
}
