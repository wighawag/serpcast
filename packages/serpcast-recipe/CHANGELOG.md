# serpcast-recipe

## 0.2.0

### Minor Changes

- 5b896a3: Recipes may declare an optional `decoyProne` boolean: the site sometimes answers with results unrelated to the query. `parseRecipe` validates it (`recipe "<name>": decoyProne must be a boolean`) and keeps it in its output, and the `Recipe` type has it. serpcast's engine chain reads it; searchcast ignores it. Recipes without it parse exactly as before.

## 0.1.0

### Minor Changes

- 03e9f7f: First release. `serpcast-recipe`: the shared recipe schema, its types and its validator. `serpcast`: the transport (libcurl-impersonate), the declarative and code recipe runners, browser engines (searchcast), the engine chain with its state store, and the CLI (`query`, `install-libcurl`, `doctor`).
