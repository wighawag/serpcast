---
title: POST requests for page-initiated fetch/XHR, with Chrome's exact POST headers (measured first)
slug: post-requests
spec: serpcast
blockedBy: [decoy-prone-recipes]
covers: []
---

## What to build

The transport is GET only because POST header placement was never measured ("Not measured: POST requests (`origin`, `content-type`, `cache-control` placement)"). Some engines gate on a flow that ends in a POST from the page (for example a proof-of-work answer posted as JSON to the site's API), so code recipes need it. Owner decision (2026-09-29).

1. **Measure first**, as for `sec-fetch-site-by-initiator` (read its finding for the method): a nixpkgs Chromium net-log against LOCAL servers only, `fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body})` and a form-encoded POST (`application/x-www-form-urlencoded`), each same-origin, same-site and cross-site (with the CORS preflight where Chromium sends one: record the OPTIONS request too), plus `credentials: 'include'`. Record names, values, order (`content-type`, `content-length`, `origin`, `sec-fetch-*`, `priority`, `referer`).
2. **Implement** `method: 'POST'` with a `body` (string or bytes) and a `contentType` for the `fetch` kind only (navigation POSTs are out of scope unless the capture makes them trivial), exactly as captured; if a real browser would send a preflight first, send it too (as captured) or refuse such requests with a clear error, recorded. Code recipes get `ctx.http.post(url, {kind: 'fetch', referer, body, contentType})` plus `postJson(url, value, options)` returning parsed JSON with the same status mapping as `json`. The body size is capped.
3. Keep GET behaviour byte-identical (all existing tests unchanged).

## Acceptance criteria

- [ ] A finding in `work/notes/findings/` with the capture (versions, method, header lists per case), local servers only.
- [ ] Exact-table tests for POST JSON and POST form, same-origin/same-site/cross-site, on the local test server (including any preflight); existing tests unchanged.
- [ ] `ctx.http.post`/`postJson` tested through a code recipe; README, CONTEXT, changeset (minor).

## Blocked by

- decoy-prone-recipes (serialized)

## Prompt

Keep the public repo engine-neutral. FIRST, check this task against current reality. RECORD non-obvious decisions.
