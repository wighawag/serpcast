---
title: Last release of serpcast and serpcast-recipe, saying they moved to searchcast and @searchcast/recipe
slug: moved-to-searchcast
blockedBy: []
covers: []
---

## What to build

serpcast was renamed and merged into `wighawag/searchcast` (its ADR 0005): `serpcast` is now `searchcast` (0.2.0 on npm), `serpcast-recipe` is now `@searchcast/recipe` (0.1.0 on npm). Both names are published, with provenance, from that repo. This repo makes ONE last minor release of each old package whose only change is that it says so, so that `npm view` and the npm page point people to the new names before the owner deprecates them.

- Root `README.md`: a short notice at the very top (before anything else): "serpcast has moved: it is now `searchcast` (https://github.com/wighawag/searchcast, `npm install searchcast`), and `serpcast-recipe` is now `@searchcast/recipe`. This repository is archived; its full history continues there. Upgrade notes: the searchcast README, 'Upgrading from serpcast'." Keep the rest of the README as is (it is history, and it is what the `serpcast` npm page shows).
- `packages/serpcast-recipe/README.md`: the same kind of notice at the top, pointing to `@searchcast/recipe` (same format, same API, same messages).
- Both `package.json` `description` fields start with "Moved to searchcast." / "Moved to @searchcast/recipe." respectively. No code change, no dependency change, no other file.
- Changesets: `serpcast` minor and `serpcast-recipe` minor (so 0.7.0 and 0.3.0), each saying the package moved and naming its successor. Do NOT edit any `version` field yourself.

## Acceptance criteria

- [ ] The two READMEs start with the moved notice; the two descriptions say moved; nothing else changes (no code, dependencies or versions).
- [ ] Two minor changesets, one per package.
- [ ] The gate is green.

## Blocked by

- None, can start immediately.

## Prompt

Goal: the old npm names tell people where to go. Keep it minimal. No em dashes. Bound shell commands with timeouts; never grep node_modules, dist or .git.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
