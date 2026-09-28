---
title: serpcast-recipe, the shared recipe schema, types and validator extracted from searchcast
slug: recipe-schema-package
spec: serpcast
blockedBy: [scaffold-monorepo]
covers: [9, 11]
---

## What to build

`serpcast-recipe` becomes the single definition of the recipe format: the `Recipe`, `FieldSpec` and `Submit` types, `RecipeError`, and `parseRecipe(value, fallbackName?)` that validates an unknown JSON value into a `Recipe` or throws `RecipeError` with a precise path in the message. It is an extraction of searchcast's current recipe module, with the same meaning and the same error messages, so every recipe searchcast accepts today is accepted unchanged. Node-only helpers that read files (`loadRecipeFile`, `loadRecipes` over files and directories, name from the `name` field or else the file name) are exported from a separate subpath so the main entry stays usable without `node:fs`. Add a small helper that tells a runner whether a recipe needs a browser (it uses `form`), so the HTTP runner can reject it with a clear message.

## Acceptance criteria

- [ ] The package has zero runtime dependencies and stays MIT.
- [ ] searchcast's recipe test cases (`test/recipe.test.ts` on GitHub) are ported and pass unchanged in meaning: valid recipes parse, invalid ones fail with the same messages.
- [ ] `parseRecipe` enforces exactly one of `navigate`/`form`, required `ready` and required `title` and `url` fields the same way searchcast does, and its output shape is unchanged: like searchcast, it leaves `limit` and `timeoutMs` undefined when absent. The documented defaults (`limit` 10, `timeoutMs` 15000) are applied by runners; export them as named constants so both runners use the same values.
- [ ] The file-loading helpers live on a separate export subpath; the main entry imports nothing from `node:*`.
- [ ] `requiresBrowser(recipe)` (or an equivalently named helper) returns true for `form` recipes.
- [ ] README of the package documents the format (the recipe table from searchcast's README) and says it is shared by serpcast and searchcast.
- [ ] Tests cover the new behaviour.

## Blocked by

- scaffold-monorepo

## Prompt

Goal: one recipe format for two runners (ADR 0003). Start from searchcast's `src/recipe.ts` and its tests (get the searchcast sources: the `searchcast@0.1.1` npm tarball ships `src/` (`npm pack searchcast@0.1.1` into a scratch dir), and the tests and README are on GitHub at https://github.com/wighawag/searchcast), and move them here with the minimum change: same types, same validation, same messages. Do not add HTTP-only fields. searchcast will later switch to this package (a task in the searchcast repo), so any divergence you introduce breaks it; if you find something in searchcast's recipe code that must change, record it rather than silently changing behaviour.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
