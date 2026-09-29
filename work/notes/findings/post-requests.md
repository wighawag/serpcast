---
title: Chromium's headers for a page's fetch() POST, and its CORS preflight
slug: post-requests
source: 'captured 2026-09-29 (UTC ~20:45-20:50) with a net-log of nixpkgs Chromium 152.0.7977.82 (/nix/store/33pxss8h71cl7vmfpy21bidsw0lj1g8q-chromium-152.0.7977.82, Linux x64, headless=new, fresh profile) against LOCAL servers only: one Node 24.19.0 HTTP/2 TLS server on 127.0.0.1 answering every host name, all mapped there with --host-resolver-rules="MAP * 127.0.0.1", a self-signed certificate plus --ignore-certificate-errors. No third-party site was contacted. Single host, single day, one Chromium version: re-measure when the pinned Chrome moves.'
---

# Chromium's headers for a page's fetch() POST, and its CORS preflight

The finding `impers-fingerprint-vs-curl-cffi` listed "Not measured: POST requests (`origin`, `content-type`, `cache-control` placement)", and `sec-fetch-site-by-initiator` measured only GET. This one measures `fetch(url, {method: 'POST', headers: {'content-type': …}, body})` from one page, with a JSON body and a form-encoded body, each same-origin, same-site (a sibling subdomain) and cross-site, with the default credentials mode and with `credentials: 'include'`, plus the CORS preflight wherever Chromium sent one.

## Verdict

1. **A POST differs from the GET `fetch` table in three places, and only there.** `content-length` comes FIRST (before the client hints); `content-type` sits between `sec-ch-ua` and `sec-ch-ua-mobile`; and `origin` is sent ALWAYS, same-origin included (a GET sends it only when not same-origin). `accept: */*`, the `sec-fetch-*` values (`cors`, `empty`), `priority: u=1, i`, the referer rule (full URL same-origin, page origin plus `/` otherwise) and `sec-fetch-storage-access: active` for a credentialed cross-site request are as for a GET. No `cache-control` or `pragma` is sent.
2. **Preflight: only a request to another origin (same-site included) with a `content-type` that is not CORS-safelisted** (`application/json` here). The form-encoded POST was never preflighted; a same-origin POST never. The preflight is `OPTIONS` to the same URL, sent before the POST, with its own header list (below): no client hints except `user-agent`, `sec-fetch-mode` BEFORE `sec-fetch-site`, `access-control-request-method: POST` and `access-control-request-headers: content-type`, no cookie and no `sec-fetch-storage-access` even for a `credentials: 'include'` request (a preflight is always credential-less), and the HEADERS frame ends the stream.
3. **The preflight goes on a connection of its own.** Chromium keeps credential-less requests (privacy mode) off the credentialed connection: with `credentials: 'include'`, the preflight to `cdn.example.com` went on one HTTP/2 connection and the POST on another (net-log session ids 125 and 211; for `www.example.net`, 154 and 345). With the default credentials mode, a cross-origin POST is itself credential-less, and it shared the preflight's connection.
4. **Preflights are cached per URL**: a second identical JSON POST within 5 s sent no preflight (the Fetch standard's default when the answer has no `access-control-max-age`); after 6 s it sent one again; with `access-control-max-age: 600` it did not.
5. **Bodies.** `content-length` is the body's byte length. A string body without a `content-type` gets `content-type: text/plain;charset=UTF-8`; a `Uint8Array` body gets none; a POST with no body sends `content-length: 0` and ends the stream on its HEADERS frame (fin=true), where a POST with a body does not.

Cookies behave as for GET (finding `sec-fetch-site-by-initiator`): the default credentials mode sends no cookie to another origin; `credentials: 'include'` sends them, a cross-site one only `SameSite=None` cookies.

## Method (spike code, deleted after recording)

Scratch dir outside the repo (`/tmp/postspike`). One self-signed certificate for `*.example.com` and `*.example.net`; one HTTP/2 server answered `/page` (HTML), `/setcookie` (`lax=1; Path=/` and `none=1; Path=/; SameSite=None; Secure`), `OPTIONS` on any `/api/…` path with 204, `access-control-allow-origin: <origin>`, `access-control-allow-credentials: true`, `access-control-allow-methods: POST`, `access-control-allow-headers: content-type` (plus `access-control-max-age: 600` on paths containing `maxage`), and `POST` on `/api/…` with JSON and the same allow-origin/credentials headers.

```sh
chromium --headless=new --remote-debugging-port=9338 --user-data-dir=/tmp/postspike/profile \
  --log-net-log=/tmp/postspike/net.json --net-log-capture-mode=IncludeSensitive \
  --host-resolver-rules='MAP * 127.0.0.1' --ignore-certificate-errors \
  --no-first-run --no-default-browser-check --disable-background-networking \
  --disable-component-update --disable-sync about:blank
```

Driven over raw CDP: `Page.navigate` to `https://www.example.com:P/page?q=x`, then `Runtime.evaluate` of `fetch(url, {method: 'POST', headers: {'content-type': CT}, body: B, credentials: C})` per case, with a distinct path per case (so no preflight came from the cache): CT/B `application/json` / `JSON.stringify({a:1,b:"x"})` (15 bytes) and `application/x-www-form-urlencoded` / `'a=1&b=x'` (7 bytes); targets `https://www.example.com:P` (same-origin), `https://cdn.example.com:P` (same-site), `https://www.example.net:P` (cross-site); C `same-origin` (the default), then `include` after setting cookies on every host by typed navigations. Then, same-origin, a `Uint8Array([1,2,3])` body with no content-type, a string body with no content-type, and no body. A second run (fresh profile) posted JSON twice to one same-site URL, twice to one answering `access-control-max-age: 600`, waited 6 s and posted to each again. Headers were read from the `HTTP2_SESSION_SEND_HEADERS` events of the net-log (with their `fin` flag and source id, the HTTP/2 session); the server's own log confirmed which requests arrived.

## Header lists per case

As for the earlier findings, Chromium 152 is unbranded headless (`sec-ch-ua: "Not?A_Brand";v="24", "Chromium";v="152"`, `user-agent: … HeadlessChrome/152.0.0.0 …`); the header SET and ORDER are taken as those of the pinned target (Chrome 146), with branded Chrome 146 values. The page is `https://www.example.com:37095/page?q=x`; pseudo-headers are `:method, :authority, :scheme, :path` for all.

### POST, same-origin (`https://www.example.com:37095/api`), JSON, `credentials: 'include'`

```
content-length: 15
sec-ch-ua-platform: "Linux"
user-agent: <UA>
sec-ch-ua: <sec-ch-ua>
content-type: application/json
sec-ch-ua-mobile: ?0
accept: */*
origin: https://www.example.com:37095
sec-fetch-site: same-origin
sec-fetch-mode: cors
sec-fetch-dest: empty
referer: https://www.example.com:37095/page?q=x
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
priority: u=1, i
```

Form-encoded: the same with `content-length: 7` and `content-type: application/x-www-form-urlencoded`. With the default credentials mode: identical (same-origin sends cookies either way). No preflight in either case.

### POST, same-site (`https://cdn.example.com:37095/api`), `credentials: 'include'`

```
content-length: 15
sec-ch-ua-platform: "Linux"
user-agent: <UA>
sec-ch-ua: <sec-ch-ua>
content-type: application/json
sec-ch-ua-mobile: ?0
accept: */*
origin: https://www.example.com:37095
sec-fetch-site: same-site
sec-fetch-mode: cors
sec-fetch-dest: empty
referer: https://www.example.com:37095/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
priority: u=1, i
```

Form-encoded: the same with `content-length: 7` and the form `content-type`, and no preflight. With the default credentials mode: without `cookie`.

### POST, cross-site (`https://www.example.net:37095/api`), `credentials: 'include'`

```
content-length: 15
sec-ch-ua-platform: "Linux"
user-agent: <UA>
sec-ch-ua: <sec-ch-ua>
content-type: application/json
sec-ch-ua-mobile: ?0
accept: */*
origin: https://www.example.com:37095
sec-fetch-site: cross-site
sec-fetch-mode: cors
sec-fetch-dest: empty
sec-fetch-storage-access: active
referer: https://www.example.com:37095/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: none=1
priority: u=1, i
```

Form-encoded: the same with `content-length: 7` and the form `content-type`, and no preflight. With the default credentials mode: without `cookie` and without `sec-fetch-storage-access`.

### Preflight (JSON POST, same-site and cross-site, either credentials mode)

Same-site shown; cross-site differs only in `sec-fetch-site: cross-site`. Identical with `credentials: 'include'` (no cookie, no `sec-fetch-storage-access`). HEADERS frame with END_STREAM.

```
:method: OPTIONS
accept: */*
access-control-request-method: POST
access-control-request-headers: content-type
origin: https://www.example.com:37095
user-agent: <UA>
sec-fetch-mode: cors
sec-fetch-site: same-site
sec-fetch-dest: empty
referer: https://www.example.com:37095/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
priority: u=1, i
```

### Bodies without a content-type (same-origin)

`Uint8Array([1,2,3])`: `content-length: 3`, no `content-type`, otherwise the same-origin list. String `'hello'`: `content-length: 5`, `content-type: text/plain;charset=UTF-8` in the usual place. No body: `content-length: 0`, no `content-type`, HEADERS frame with END_STREAM.

## Not measured

Navigation (HTML form) POSTs, `multipart/form-data` bodies, POSTs with other author headers (which would be listed in `access-control-request-headers`), a preflight that fails (Chromium's behaviour follows the Fetch standard: the POST is not sent), the cap on `access-control-max-age` (Chromium's source says 2 hours; only 600 s was tried), `http` (non-secure) targets, and HTTP/1.1.
