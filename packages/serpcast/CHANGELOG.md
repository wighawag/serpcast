# serpcast

## 0.4.0

### Minor Changes

- 5b896a3: The decoy guard now also applies to every engine whose recipe declares `decoyProne: true`, without naming it in `decoyGuard`: a declarative recipe in its JSON, a code recipe on its default export (`CodeRecipe.decoyProne`, validated by `loadCodeRecipe`), and a library-mode browser engine through its recipe. `decoyGuard: string[]` works as before; to switch the guard off for a decoy-prone recipe, pass it as `{...recipe, decoyProne: false}`.
- 2261bad: POST requests for page-initiated `fetch`, with Chrome's exact POST headers (measured on Chromium 152 against local servers): `session.request(url, {kind: 'fetch', method: 'POST', referer, body, contentType})`, and for code recipes `ctx.http.post(url, {kind: 'fetch', referer, body, contentType})` and `ctx.http.postJson(url, value, options)` (parsed JSON, statuses mapped as for `json`). When Chrome would send a CORS preflight first (another origin with a non-safelisted `content-type` such as `application/json`), serpcast sends it too, without cookies and on a connection of its own, caches it for its `access-control-max-age`, and does not send the POST if the preflight refuses it. Bodies are capped at `MAX_REQUEST_BODY_BYTES` (1 MiB). New exports: `preflightTable`, `isSafelistedContentType`, `MAX_REQUEST_BODY_BYTES` and the types `PostOptions`, `HttpPostOptions`, `RequestMethod`. GET requests are unchanged.

### Patch Changes

- Updated dependencies [5b896a3]
  - serpcast-recipe@0.2.0

## 0.3.0

### Minor Changes

- 07ef9aa: `fetch` and `script` requests now send `sec-fetch-site` the way Chrome does, derived from the request URL relative to the `referer`: `same-site` for a sibling subdomain or another port, `cross-site` for another site or scheme (they always sent `same-origin` before). A request that is not same-origin also sends only the page's origin as `referer`, a `fetch` adds `origin`, and a cross-site one adds `sec-fetch-storage-access: active`, as measured from Chromium. The site rule is built in (no public suffix list); the new request option `fetchSite` overrides it. `headerTable()` accepts `url` and `fetchSite`, and `fetchSite()`, `FETCH_SITES` and the `FetchSite` type are exported.

## 0.2.0

### Minor Changes

- 391a25d: Add an opt-in decoy guard to the engine chain: `createSerpcast({decoyGuard: ['bing']})` checks the named engines' answers with the new exported `isDecoy(query, results)` rule, and a page unrelated to the query becomes a failure of the new `SerpcastError` kind `decoy` (the chain tries the next engine, with no cooldown).
- ee4a77b: Transport sessions reuse their connections (keep-alive, one HTTP/2 connection per origin, as Chrome does), never sharing them with another session, and gain `session.close()`. The engine chain keeps each engine's session between searches and closes its connections when the session is dropped (idle expiry, `clearSessions()`, `close()`). Measured through Tor: median request latency on one session fell from about 520 ms to about 90 ms.

## 0.1.1

### Patch Changes

- 723cbe5: Fix: `process.exit()` no longer hangs while a request is in flight or right after an abort. The transport now drives libcurl through its multi interface on the main thread instead of running `curl_easy_perform` on a worker thread, whose JS callbacks deadlocked process exit.

## 0.1.0

### Minor Changes

- 03e9f7f: First release. `serpcast-recipe`: the shared recipe schema, its types and its validator. `serpcast`: the transport (libcurl-impersonate), the declarative and code recipe runners, browser engines (searchcast), the engine chain with its state store, and the CLI (`query`, `install-libcurl`, `doctor`).

### Patch Changes

- Updated dependencies [03e9f7f]
  - serpcast-recipe@0.1.0
