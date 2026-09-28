---
title: Engine chain with first-answer-wins, collected failures, blocked cooldowns, injected state store and expiring sessions
slug: engine-chain-and-state
spec: serpcast
blockedBy: [declarative-http-runner]
covers: [1, 16, 17, 20, 21, 22]
---

## What to build

The library's main entry: `createSerpcast(options)` returning `{search(query, {engines, maxResults?, signal?}), clearSessions(engine?), close()}`. `engines` is an ordered list of engines (at this point only declarative recipes; later tasks add code recipes and searchcast). `search` tries them in order and returns the first answer (results, or an `empty` match) as `{results, engine, failures}`, where `failures` lists `{engine, error}` for each engine tried before it; if all fail it throws a `SerpcastError` of kind `exhausted` whose `failures` field lists every `{engine, error}`. An `impersonation` error is not an engine failure: it means every HTTP engine would search with the wrong fingerprint, so it aborts the whole search at once with that error (it does not fall through to later engines, including the browser), and callers can detect it by its kind. An engine that answered `blocked` is skipped until its cooldown (default a few minutes, configurable) expires. Cooldowns and sessions live in an injected state store: a small async key/value interface with per-key expiry (`get`, `set`, `delete`), which serpcast namespaces per engine. The default store is in-memory. Each engine gets a transport session whose cookies are persisted in the store, dropped after `sessionIdleMs` without use, and clearable with `clearSessions`. Options include the transport settings (library path, strict, proxy) from the transport task.

## Acceptance criteria

- [ ] First success wins; later engines are not called; earlier failures are reported.
- [ ] All engines failing throws a `SerpcastError` of kind `exhausted` with a `failures` field; it never returns an empty list for that.
- [ ] An `impersonation` failure aborts the search immediately with kind `impersonation`; no later engine is called.
- [ ] A `blocked` engine is skipped during its cooldown and tried again after it (tested with an injectable clock).
- [ ] Session cookies survive across `search` calls through the store and are gone after the idle time or `clearSessions`.
- [ ] A custom store supplied by the caller receives all reads and writes; with the default store nothing is written to disk.
- [ ] The public API and store interface are exported with types and documented in the README.
- [ ] Tests cover the new behaviour with fake engines.

## Blocked by

- declarative-http-runner

## Prompt

Goal: make a query cost as few requests as possible. Engines gate on request volume per exit IP, so querying every engine per search (SearXNG's fan-out) burns that budget; the chain is sequential and stops at the first answer. The store is injected because where state lives and how it is partitioned is a privacy decision that belongs to the caller (ADR 0002); webveil will provide a per-identity file store.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
