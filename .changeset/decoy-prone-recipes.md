---
'serpcast': minor
---

The decoy guard now also applies to every engine whose recipe declares `decoyProne: true`, without naming it in `decoyGuard`: a declarative recipe in its JSON, a code recipe on its default export (`CodeRecipe.decoyProne`, validated by `loadCodeRecipe`), and a library-mode browser engine through its recipe. `decoyGuard: string[]` works as before; to switch the guard off for a decoy-prone recipe, pass it as `{...recipe, decoyProne: false}`.
