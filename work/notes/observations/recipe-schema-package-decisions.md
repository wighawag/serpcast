# recipe-schema-package: in-scope decisions and searchcast quirks kept as-is

2026-09-28, task `recipe-schema-package`. None of these meets the ADR bar; recorded here so the reviewer and the searchcast `use-serpcast-recipe` task can ratify or reverse them.

## Decisions

1. **Node subpath is `serpcast-recipe/node`** (`src/node.ts`, `exports["./node"]`). It exports only `loadRecipeFile` and `loadRecipes`; `RecipeError`, `parseRecipe` and the types come from the main entry. Alternatives: `/fs`, `/loader`, or re-exporting everything from the subpath too. Touches searchcast's `use-serpcast-recipe` shim, which must import the loaders from this path.
2. **Default constants are `DEFAULT_LIMIT = 10` and `DEFAULT_TIMEOUT_MS = 15_000`**, exported from the main entry. `DEFAULT_TIMEOUT_MS` is the name searchcast already uses internally (`src/searchcast.ts`); searchcast inlines `10` in `src/probe.ts`. Touches both runners (serpcast's `declarative-http-runner`, searchcast once it switches).
3. **Helper is `requiresBrowser(recipe)`**, true exactly when `recipe.form` is set (the only browser-only feature in the format today). Touches `declarative-http-runner`, which should use it to reject `form` recipes with a `recipe` error.
4. **The scaffold's `packageName` export is kept**, because `packages/serpcast/test/index.test.ts` imports it to prove workspace resolution. Removing it was out of scope.
5. **`@types/node` added as a devDependency** so `tsc` can type `src/node.ts`. Runtime dependencies stay zero.
6. **Schema code is byte-identical to searchcast@0.1.1's `src/recipe.ts`**, split into `src/recipe.ts` (schema, no `node:*`) and `src/node.ts` (loaders). The ported test file changes only its imports.

## searchcast quirks noticed and deliberately NOT changed

Changing any of these would make the two runners disagree, so they stay until decided on both sides:

- Unknown keys are silently ignored, so a typo in an optional field (for example `blockedURL` or `timeout`) is dropped without an error.
- `fallbackName` is ignored when it is the empty string (truthy check), and the fallback applies only when `name` is absent, not when it is empty.
- Each parsed `FieldSpec` carries explicit `selector: undefined` / `attr: undefined` keys when those are omitted (visible to `toStrictEqual` and `Object.keys`, invisible to `toEqual` and `JSON.stringify`).
- Only `navigate.url` must contain `{query}`; `form.url` has no such rule (correct for forms, noted for completeness).
