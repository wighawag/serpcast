---
title: Recipes can declare `decoyProne`, which turns the decoy guard on for that engine
slug: decoy-prone-recipes
spec: serpcast
blockedBy: []
covers: []
---

## What to build

The decoy guard (`createSerpcast({decoyGuard: [names]})`) is keyed by engine name, but engine names are recipe names the caller chooses, so a caller-side default ("guard the engine called X") is fragile. The recipe author knows whether their engine serves decoy pages. Owner decision (2026-09-29): let a recipe declare it.

- **Code recipes:** an optional `decoyProne: true` on the default export (`CodeRecipe`), validated by `loadCodeRecipe` (boolean or absent).
- **Declarative recipes:** an optional `decoyProne` boolean in the shared schema (`serpcast-recipe`: type, `parseRecipe` validation with the same error style, README table). It is MIT and shared with searchcast, which ignores it (it has no chain); `parseRecipe` must keep it in its output. Browser engines built from a declarative recipe inherit it.
- **The chain:** an engine is guarded when its name is in `decoyGuard` OR its recipe declares `decoyProne: true`. Decide and record whether a caller can switch the guard OFF for a decoy-prone recipe (for example `decoyGuard: {include?: string[], exclude?: string[]}` or keep it simple and say "edit the recipe"); keep the existing `decoyGuard: string[]` form working either way.
- README (engine chain and recipe sections), CONTEXT, changesets (minor for both packages).

## Acceptance criteria

- [ ] A code recipe and a declarative recipe with `decoyProne: true` are guarded without being named in `decoyGuard`; without the flag and not named, they are not judged; invalid values are rejected at load/parse time with clear messages.
- [ ] `serpcast-recipe` round-trips the field; every existing recipe test passes unchanged.
- [ ] Existing decoy tests pass unchanged; changesets added.

## Blocked by

- None, can start immediately.

## Prompt

Keep the public repo engine-neutral (examples use placeholder engines). FIRST, check this task against current reality. RECORD non-obvious decisions.
