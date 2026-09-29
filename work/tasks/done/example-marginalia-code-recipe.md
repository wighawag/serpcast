---
title: A working example code recipe for Marginalia Search's public API, so a new user has a first real engine
slug: example-marginalia-code-recipe
spec: serpcast
blockedBy: []
covers: []
---

## What to build

serpcast and webveil ship no recipe for a real engine, so the quick starts end with a placeholder and a new user must write a recipe before the first real search (webveil observation `no-public-serpcast-recipe-for-the-quick-start`). The owner decided (2026-09-29) to publish ONE example for an engine whose terms allow automated access. Marginalia Search (an independent web search engine) offers an API meant for programs (https://about.marginalia-search.com/article/api/, read 2026-09-29): the key `public` "is available for experimentation" with a shared rate limit (HTTP 503 when hit), results are provided under CC-BY-NC-SA 4.0, and personal keys are free on request. The current API (`api2.marginalia-search.com/search?query=`) needs an `API-Key` header, which serpcast's transport cannot send (only the Chrome header table), so use the documented, still-supported URL-keyed API: `https://api.marginalia.nu/<key>/search/<url-encoded query>?count=<n>` returning JSON `{query, license, results: [{url, title, description, ...}]}`.

Add `examples/recipes/marginalia.mjs` at the repo root (NOT inside a published package): a code recipe (`{name: 'marginalia', search(query, ctx)}`) that reads the key from `process.env.MARGINALIA_API_KEY`, defaulting to `public`, calls the API with `ctx.http.json(url, {kind: 'document'})`, maps `title`, `url` and `description` (as `snippet`), honours `ctx.maxResults` via `count` (1 to 100), maps HTTP 503 and 429 to a `blocked` error (the shared rate limit), and a response without a `results` array to `ctx.recipeError(...)`. Document it in the serpcast README (code recipes section): what it is, the terms (the `public` key is for experimentation and shared; get a free personal key for regular use; results are CC-BY-NC-SA 4.0), how to use it (`loadCodeRecipe('./examples/recipes/marginalia.mjs')`, or copy it next to your private recipes), and that it is an example, not a bundled engine.

## Acceptance criteria

- [ ] The recipe runs in the chain against a local fake of the API (injected fake transport or a local server): results mapped, `count` from `maxResults` clamped to 1..100, 503/429 become `blocked` (cooldown), a missing `results` array is a `recipe` error, the key comes from `MARGINALIA_API_KEY` else `public`, and the query is URL-encoded into the path.
- [ ] No test contacts the real API (verify stays offline). One manual live check through the real transport is allowed and its outcome (date, result count, any status) recorded in the done record.
- [ ] The example lives outside `packages/`, so it is not published; the README states the terms and licence as above, with the source URL.
- [ ] No other engine is named or targeted.

## Blocked by

- None, can start immediately.

## Prompt

Goal: a first real, terms-compliant engine for new users (and for webveil's quick start). Read `packages/serpcast/src/code.ts` for the recipe contract. Fetch the API page above once to confirm the URL-keyed API and the `public` key are still documented; if they are not, stop and route to needs-attention. FIRST, check this task against current reality. RECORD non-obvious decisions.
