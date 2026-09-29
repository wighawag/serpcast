---
title: Opt-in relevance guard that reports decoy result pages (Bing) instead of returning them
slug: decoy-guard
spec: serpcast
blockedBy: [session-connection-reuse]
covers: []
---

## What to build

The former idea note `decoy-results-relevance-guard` (removed when this task was written; its content is folded in here), now with measurements. Some engines, Bing above all, answer with a well-formed page of results unrelated to the query. Measured 2026-09-29 with serpcast and two Node clients (my-boxes finding `search-engine-gatekeeping-by-egress-class`): Bing decoyed about half of realistic queries direct and most over Tor, the SAME queries for every client, and over Tor a given query decoyed on every repeat. Earlier (2026-09-26, same finding) an immediate retry rescued 0 of 16 decoys, so a decoy is a property of (engine, query, moment), not of the client.

Add an opt-in guard to the engine chain:

- **The rule** (port of the measured guard, my-boxes `packages/search-challenges/relevance.py`, which flagged every decoy seen and none of ~55 genuine pages): query terms are the distinct words of 3+ characters minus a fixed stopword list (use that file's list), matched by 5-character prefix on the words of a result's title + snippet + URL; a result is relevant when it matches at least `min(2, terms)` terms; a page is a decoy when at most one of its top 5 results is relevant. Queries with fewer than 2 terms, or pages with fewer than 3 results, are never judged. Export the check as a pure function (for example `isDecoy(query, results)`) so code recipes and callers can use it.
- **Where:** an option on `createSerpcast`, naming the engines it applies to (for example `decoyGuard: ['bing']`), off by default. Applies to every engine kind (declarative, code, browser).
- **What happens:** a guarded engine whose answer is a decoy fails with a new `SerpcastError` kind `decoy` (message names the query terms and the top result titles), recorded in `failures`, and the chain moves on to the next engine. NO cooldown (decoys are per query; cooling the engine would drop its good answers for other queries). If every engine fails, `exhausted` lists it like any failure. Record the kind choice (versus `blocked` with a flag).
- Update README (engine chain section: the option, the rule, the measurements it is based on without naming private deployment details) and CONTEXT.md (the `decoy` kind).

## Acceptance criteria

- [ ] `isDecoy` is exported and tested on the rule's edges (one-term query, short page, exactly one relevant, two relevant, prefix matching, stopwords), with cases taken from the real decoys in the finding (a dictionary page for "why", a gaming guide for a Debian query).
- [ ] With `decoyGuard: ['x']`, a decoy answer from engine `x` becomes a `decoy` failure and the chain tries the next engine; a relevant answer passes; unguarded engines are never judged; no cooldown is started (tested with the injectable clock).
- [ ] `SerpcastErrorKind` includes `decoy`; README and CONTEXT updated; a changeset (minor: new option and error kind).

## Blocked by

- session-connection-reuse (serialized: both edit the chain)

## Prompt

FIRST, check this task against current reality. RECORD non-obvious decisions.
