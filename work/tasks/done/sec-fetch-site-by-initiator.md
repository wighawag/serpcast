---
title: Send `sec-fetch-site` (and the referer) the way Chromium does for same-site and cross-site subresources
slug: sec-fetch-site-by-initiator
spec: serpcast
blockedBy: []
covers: []
---

## What to build

serpcast's header tables for page-initiated kinds (`same-origin-navigation`, `fetch`, `script`) always send `sec-fetch-site: same-origin` (the fingerprint finding measured only same-origin requests: "Not measured: cross-site `sec-fetch-site` values"). But a real page often loads a script or calls an API on a SIBLING host of the same site (a page on `www.example.com` loading `https://cdn.example.com/x.js`), for which Chromium sends `same-site`, and on another site, for which it sends `cross-site`. Sending `same-origin` there is exactly the kind of self-contradiction that gets a client flagged (the header-coherence lesson: one engine refused 12/12 requests from a client whose headers contradicted its TLS, and served the same requests from a coherent one). It was noticed in a private recipe that loads a sibling-subdomain script: that flow still passed, so this is coherence work, not a fix for an observed failure.

1. **Measure first**, the way the original tables were made: a net-log capture (`--log-net-log`, `--net-log-capture-mode=IncludeSensitive`) of a real nixpkgs Chromium on Linux, headless, against a LOCAL test setup only (two hostnames of one site and one of another site mapped to 127.0.0.1 with `--host-resolver-rules`, a self-signed certificate plus `--ignore-certificate-errors`), for: a dynamically inserted `<script src>` and a `fetch()` GET, each same-origin, same-site (sibling subdomain) and cross-site. Record for each: header names, values and ORDER, `sec-fetch-site`, `sec-fetch-mode`, `priority`, and what `referer` becomes under Chromium's default referrer policy (`strict-origin-when-cross-origin`: expected full URL for same-origin, origin only otherwise; verify). Record the Chromium version and note that the header set is taken as the one for the pinned target, as the original tables were.
2. **Implement:** the `sec-fetch-site` value (and any header that changes with it, the referer included) is derived from the request URL relative to the `referer` (the initiating page): same scheme+host+port = `same-origin`; same registrable domain = `same-site`; else `cross-site`. Decide how to get the registrable domain without a large dependency (serpcast has no public suffix list; a small built-in rule plus an explicit override option is acceptable, recorded) and allow an explicit override in the request options for callers that know better. `document` (typed navigation) stays `none`.
3. Keep the existing same-origin tables byte-identical (their tests must pass unchanged).

## Acceptance criteria

- [ ] The capture is recorded as a finding in `work/notes/findings/` (versions, method, the header lists per case), created with local servers only (no third-party site contacted).
- [ ] Requests to a local test server carry exactly the captured headers, in order, for same-site and cross-site `script` and `fetch` (tests like the existing exact-table tests), and the existing same-origin tests pass unchanged.
- [ ] The derivation (same-origin / same-site / cross-site) is tested, including the override, a different port, a different scheme, and a multi-label public suffix if the rule handles one (or its documented limit if not).
- [ ] README (header tables section) and CONTEXT updated; changeset (minor if the request options change).

## Blocked by

- None, can start immediately.

## Prompt

Read `packages/serpcast/src/chrome.ts` and the finding `work/notes/findings/impers-fingerprint-vs-curl-cffi.md` (how the current tables were captured). Keep the public repo engine-neutral: do not name or target any search engine. FIRST, check this task against current reality. RECORD non-obvious decisions.
