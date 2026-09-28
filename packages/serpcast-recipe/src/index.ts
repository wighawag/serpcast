// serpcast-recipe: the single definition of the recipe format shared by
// serpcast (HTTP) and searchcast (real browser), ADR 0003. This entry imports
// nothing from `node:*`; the file loaders are on the `serpcast-recipe/node`
// subpath.

import type {Recipe} from './recipe.js';

export {
	RecipeError,
	parseRecipe,
	type FieldSpec,
	type Recipe,
	type Submit,
} from './recipe.js';

/** The published name of this package. */
export const packageName = 'serpcast-recipe';

/**
 * Results returned when a recipe sets no `limit`. `parseRecipe` leaves `limit`
 * undefined when absent; runners apply this default.
 */
export const DEFAULT_LIMIT = 10;

/**
 * Per-query budget in milliseconds when a recipe sets no `timeoutMs`.
 * `parseRecipe` leaves `timeoutMs` undefined when absent; runners apply this
 * default.
 */
export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Whether a recipe can only run in a real browser. A `form` recipe types the
 * query into a page, which an HTTP runner cannot do, so it rejects such a
 * recipe with a clear error and leaves it to searchcast.
 */
export function requiresBrowser(recipe: Recipe): boolean {
	return recipe.form !== undefined;
}
