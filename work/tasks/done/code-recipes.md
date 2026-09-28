---
title: Code recipes, JS modules loaded by explicit path, given only the impersonated client, a session and helpers
slug: code-recipes
spec: serpcast
blockedBy: [engine-chain-and-state]
covers: [14, 15, 19]
---

## What to build

A second engine kind for sites that need challenge handling or a non-HTML API. `loadCodeRecipe(path)` imports an ESM module whose default export is `{name, search(query, ctx)}`; it is loaded only from the path the caller gives, never discovered. `ctx` carries: `http` (the impersonated transport bound to this engine's session, with the request-kind option and helpers for text and JSON responses), `session` (get/set of JSON state for this engine in the injected store, with the same idle expiry as cookies), `signal`, `maxResults`, and `blocked(message)` / `recipeError(message)` helpers that throw the typed errors. The module returns results in the normalized shape (validated; malformed entries are a `recipe` error). Code recipes go in the engine chain like declarative ones, including cooldowns.

> FORWARD-NOTE (conductor, 2026-09-28): this repo is public and must not carry private or terms-sensitive engine specifics. Make the README example recipe target a clearly placeholder endpoint (for example `https://api.example.com/search?q=...`, with a comment saying to point it at an API whose terms allow automated access) rather than naming a real search engine or site, and ship no real-site recipe in the package or tests (tests use the injected fake transport or a local server only). The transport is GET-only for now (`impersonated-transport` decision 5), so `ctx.http` exposes GET only; do not add POST here. The known unhandled-rejection defect in `declarative.ts`'s `abortable()` (observation `declarative-abortable-unhandled-rejection.md`) is out of scope for this task, but do not copy that pattern into the code-recipe path.

## Acceptance criteria

- [ ] A code recipe from a temp directory is loaded by path and runs in the chain.
- [ ] Its requests go through the transport (asserted with the injected fake transport: same proxy, same session cookies, header kind honoured).
- [ ] `ctx.session` state persists across searches and expires with the session.
- [ ] Malformed output (not an array, missing title/url) is a `recipe` error; a thrown `blocked` triggers the cooldown.
- [ ] README documents the contract, with a small example recipe for a keyless JSON API that allows it, and states plainly that a code recipe is code with full Node access, so only load recipes you trust.
- [ ] Tests cover the new behaviour.

## Blocked by

- engine-chain-and-state

## Prompt

Goal: let users (including private, out-of-repo recipes) plug in engines that need code, without touching transport or identity (ADR 0002). The context is the only capability serpcast hands the module; the trust decision of which modules to load is the caller's. Do not ship recipes for engines whose terms forbid automated access.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
