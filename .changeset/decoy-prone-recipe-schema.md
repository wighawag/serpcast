---
'serpcast-recipe': minor
---

Recipes may declare an optional `decoyProne` boolean: the site sometimes answers with results unrelated to the query. `parseRecipe` validates it (`recipe "<name>": decoyProne must be a boolean`) and keeps it in its output, and the `Recipe` type has it. serpcast's engine chain reads it; searchcast ignores it. Recipes without it parse exactly as before.
