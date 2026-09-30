---
title: Expose hard-coded tuning values as options, add off switches, and an install API for embedders
slug: tunables-and-install-api
spec: serpcast
blockedBy: []
covers: []
---

## What to build

Owner decision (2026-09-30): no magic numbers a user might reasonably need to change, and an off switch for any behaviour that can be unwanted in some situation. Security guarantees are NOT switches: strict impersonation's check stays (it already has `strict`), the only-explicit-download rule, checksum pins and archive validation stay mandatory. Everything below keeps today's value as the default, so behaviour is unchanged unless set.

**Options (with today's defaults):**
- `createTransport`: `maxRedirects`-style limits do not live here (the transport follows none); add `reuseConnections` (default true; false = one connection per request, the pre-0.2 behaviour, for callers who do not want requests of one session linked at the connection level), `idlePollMs` (5), `maxRequestBodyBytes` (1 MiB), `preflightCache` (true; false = preflight every time) with `maxPreflightAgeS` (7200).
- `createSerpcast`: pass-throughs for the above, plus `maxRedirects` for the declarative runner (20), and `decoyGuard` gaining an object form `{include?: string[], exclude?: string[]}` so a caller can switch the guard OFF for a `decoyProne` recipe (exclude wins); the array form keeps working. Also `keepSessions` (default true; false = no in-memory transport session kept between searches, cookies still go through the store) and the decoy rule's thresholds as an optional `decoyRule: {top, maxRelevant, prefix}` (defaults 5, 1, 5, the measured values; say in the README they are measured and changing them is at the caller's risk).
- Browser endpoint: `maxBodyBytes` (16 MiB).
- Validation: every numeric option must be a positive finite number (zero allowed only where it means "off" and is documented), else a clear error at construction.

**Install API for embedders** (so webveil can be the only thing a user installs): export `installLibcurl`, `installRecipes`, `listRecipeSets` and the doctor report function from a NEW subpath `serpcast/install` (NOT the main entry, so importing `serpcast` still pulls in no download code; keep the existing "only download path" test meaningful by asserting the main entry does not reach `download.ts`). The CLI keeps working unchanged. Size caps of the installers stay internal constants (they are safety ceilings), but may be LOWERED by an option.

## Acceptance criteria

- [ ] Each option is documented in the README options tables with its default, and tested (default unchanged; a set value takes effect; an invalid value fails loud).
- [ ] `decoyGuard: {exclude: ['x']}` disables the guard for a `decoyProne` recipe named `x` (tested); array form unchanged.
- [ ] `reuseConnections: false` gives one connection per request (tested like the reuse test); `keepSessions: false` keeps no session between searches (tested).
- [ ] `serpcast/install` exports the install/list/doctor functions with types; the main entry does not import the download code (tested); CLI unchanged.
- [ ] Changeset (minor); all existing tests pass unchanged.

## Blocked by

- None, can start immediately.

## Prompt

FIRST, check this task against current reality. RECORD non-obvious decisions (especially anything you decided should NOT be configurable, and why).
