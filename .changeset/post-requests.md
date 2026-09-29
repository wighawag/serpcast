---
'serpcast': minor
---

POST requests for page-initiated `fetch`, with Chrome's exact POST headers (measured on Chromium 152 against local servers): `session.request(url, {kind: 'fetch', method: 'POST', referer, body, contentType})`, and for code recipes `ctx.http.post(url, {kind: 'fetch', referer, body, contentType})` and `ctx.http.postJson(url, value, options)` (parsed JSON, statuses mapped as for `json`). When Chrome would send a CORS preflight first (another origin with a non-safelisted `content-type` such as `application/json`), serpcast sends it too, without cookies and on a connection of its own, caches it for its `access-control-max-age`, and does not send the POST if the preflight refuses it. Bodies are capped at `MAX_REQUEST_BODY_BYTES` (1 MiB). New exports: `preflightTable`, `isSafelistedContentType`, `MAX_REQUEST_BODY_BYTES` and the types `PostOptions`, `HttpPostOptions`, `RequestMethod`. GET requests are unchanged.
