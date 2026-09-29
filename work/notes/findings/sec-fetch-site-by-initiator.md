---
title: Chromium's headers for same-site and cross-site subresources (script, fetch)
slug: sec-fetch-site-by-initiator
source: 'captured 2026-09-29 (UTC ~18:45-19:00) with a net-log of nixpkgs Chromium 152.0.7977.82 (/nix/store/33pxss8h71cl7vmfpy21bidsw0lj1g8q-chromium-152.0.7977.82, Linux x64, headless=new, fresh profile) against LOCAL servers only: two Node 24.19.0 HTTP/2 TLS servers and one plain HTTP server on 127.0.0.1, every host name mapped there with --host-resolver-rules="MAP * 127.0.0.1", a self-signed certificate plus --ignore-certificate-errors. No third-party site was contacted. Single host, single day, one Chromium version: re-measure when the pinned Chrome moves.'
---

# Chromium's headers for same-site and cross-site subresources (script, fetch)

The finding `impers-fingerprint-vs-curl-cffi` measured only same-origin subresources ("Not measured: cross-site `sec-fetch-site` values"). This one measures a dynamically inserted `<script src>` and a `fetch()` GET from one page, each same-origin, same-site (a sibling subdomain, and the same host on another port) and cross-site (another registrable domain, and the same host over another scheme), and records what changes besides `sec-fetch-site`.

## Verdict

Relative to the same-origin tables, a request that is not same-origin changes in four places, and only there. Everything else (names, values, order, `accept`, `priority`, the client hints) is unchanged.

1. `sec-fetch-site` is `same-site` or `cross-site`. **Sites are schemeful and ignore the port**: `https://www.example.com:A` to `https://www.example.com:B` is `same-site`; `http://www.example.com` to `https://www.example.com` is `cross-site`.
2. `referer` is the initiating page's ORIGIN plus `/` (`https://www.example.com:39383/`), not the full URL: the default policy `strict-origin-when-cross-origin`, verified. Same-origin requests keep the full URL (`…/page?q=x`).
3. `fetch` (mode `cors`) gains `origin: <page origin>` (no trailing slash), between `accept` and `sec-fetch-site`, for same-site AND cross-site. `script` (mode `no-cors`) never carries `origin`.
4. Cross-site requests that carry credentials (every `<script>`, and `fetch(…, {credentials: 'include'})`) gain `sec-fetch-storage-access: active` between `sec-fetch-dest` and `referer`. A default `fetch()` (credentials `same-origin`) does not, since it sends no credentials cross-origin. The header was present whether or not the session had any cookie for that site.

Cookies also change (not a header table question, but noted for the transport): a default `fetch()` sends NO cookie to another origin, even same-site; `credentials: 'include'` sends them; a cross-site request drops cookies without `SameSite=None` (only `none=1` went, `lax=1` did not).

The registrable domain follows the public suffix list, including private entries: `a.example.co.uk` to `b.example.co.uk` is `same-site`, `alice.co.uk` to `bob.co.uk` is `cross-site`, and `alice.github.io` to `bob.github.io` is `cross-site` (`github.io` is a private suffix).

## Method (spike code, deleted after recording)

Scratch dir outside the repo (`/tmp/sfspike`). One self-signed certificate for every test host name; servers answered `/page` (HTML), `/x.js` (JS), `/api` (JSON with `access-control-allow-origin: <origin>` and, for the credentialed run, `access-control-allow-credentials: true`), `/setcookie` (`lax=1; Path=/` and `none=1; Path=/; SameSite=None; Secure`).

```sh
chromium --headless=new --remote-debugging-port=9337 --user-data-dir=/tmp/sfspike/profile \
  --log-net-log=/tmp/sfspike/net.json --net-log-capture-mode=IncludeSensitive \
  --host-resolver-rules='MAP * 127.0.0.1' --ignore-certificate-errors \
  --no-first-run --no-default-browser-check --disable-background-networking \
  --disable-component-update --disable-sync about:blank
```

Driven over raw CDP: `Page.navigate` to `https://www.example.com:A/page?q=x` (a typed navigation, so the page itself is `sec-fetch-site: none`), then `Runtime.evaluate` of `fetch(url)` and of `document.head.appendChild(<script src=url>)` per case; then the same from `https://a.example.co.uk/page`, `https://alice.co.uk/page`, `https://alice.github.io/page` and `http://www.example.com:C/page`. Headers read from the `HTTP2_SESSION_SEND_HEADERS` events of the net-log. Three runs: default `fetch()` with no cookies, default `fetch()` with cookies set on every host first (by typed navigations), and `fetch(url, {credentials: 'include'})` with cookies.

## Header lists per case

Chromium 152 is unbranded headless: its captured `sec-ch-ua` is `"Not?A_Brand";v="24", "Chromium";v="152"` and its `user-agent` says `HeadlessChrome/152.0.0.0`. As for the original tables, the header SET and ORDER are taken as those of the pinned target (Chrome 146), with branded Chrome 146 values; the storage-access header shipped in Chrome 133, before 146. Below, `UA-HINTS` stands for the four leading headers every subresource has, in this order: `sec-ch-ua-platform: "Linux"`, `user-agent`, `sec-ch-ua`, `sec-ch-ua-mobile: ?0`. The page is `https://www.example.com:39383/page?q=x`; pseudo-headers are `:method, :authority, :scheme, :path` for all.

### `script` (dynamically inserted `<script src>`, async)

Same-origin (`https://www.example.com:39383/x.js`), unchanged from the existing table:

```
UA-HINTS
accept: */*
sec-fetch-site: same-origin
sec-fetch-mode: no-cors
sec-fetch-dest: script
referer: https://www.example.com:39383/page?q=x
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
```

Same-site (`https://cdn.example.com:39383/x.js`; identical for `https://www.example.com:39871/x.js`, another port):

```
UA-HINTS
accept: */*
sec-fetch-site: same-site
sec-fetch-mode: no-cors
sec-fetch-dest: script
referer: https://www.example.com:39383/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
```

Cross-site (`https://www.example.net:39383/x.js`; the same shape for `https://www.example.com:39383/x.js` from the `http://www.example.com:45703/page` page, with `referer: http://www.example.com:45703/`):

```
UA-HINTS
accept: */*
sec-fetch-site: cross-site
sec-fetch-mode: no-cors
sec-fetch-dest: script
sec-fetch-storage-access: active
referer: https://www.example.com:39383/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: none=1
```

No `priority` header in any case (default urgency), as in the existing table.

### `fetch` (GET, `credentials: 'include'`)

Same-origin (`https://www.example.com:39383/api`), unchanged from the existing table:

```
UA-HINTS
accept: */*
sec-fetch-site: same-origin
sec-fetch-mode: cors
sec-fetch-dest: empty
referer: https://www.example.com:39383/page?q=x
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
priority: u=1, i
```

Same-site (`https://cdn.example.com:39383/api`; identical for `https://www.example.com:39871/api`, another port; `b.example.co.uk` from `a.example.co.uk` had the same shape, measured in the run without cookies):

```
UA-HINTS
accept: */*
origin: https://www.example.com:39383
sec-fetch-site: same-site
sec-fetch-mode: cors
sec-fetch-dest: empty
referer: https://www.example.com:39383/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: lax=1; none=1
priority: u=1, i
```

Cross-site (`https://www.example.net:39383/api`):

```
UA-HINTS
accept: */*
origin: https://www.example.com:39383
sec-fetch-site: cross-site
sec-fetch-mode: cors
sec-fetch-dest: empty
sec-fetch-storage-access: active
referer: https://www.example.com:39383/
accept-encoding: gzip, deflate, br, zstd
accept-language: en-US,en;q=0.9
cookie: none=1
priority: u=1, i
```

With a default `fetch()` (credentials `same-origin`), same-site and cross-site are the lists above WITHOUT `cookie` and, for cross-site, WITHOUT `sec-fetch-storage-access`. The cross-site cases `alice.co.uk` to `bob.co.uk`, `alice.github.io` to `bob.github.io` and `http://www.example.com` to `https://www.example.com` (default `fetch()`) had the same shape, with `origin` and `referer` from their own page.

## Not measured

Page-initiated NAVIGATIONS to another origin (a link to a sibling or another site), POST, a `referer` downgrade (an `https` page loading an `http` URL, where the policy sends no referer), `http` subresources in general (not a secure context: the one HTTP/1.1 request seen, the page's favicon, carried no `sec-fetch-*` and no client hints), a profile with third-party cookies blocked (where `sec-fetch-storage-access` should read differently), and a parser-blocking `<script>`.
