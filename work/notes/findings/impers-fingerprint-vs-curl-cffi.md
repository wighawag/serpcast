---
title: impers vs curl_cffi, Chrome 146 fingerprint with our own headers and no runtime download
slug: impers-fingerprint-vs-curl-cffi
source: 'captured live 2026-09-28 (UTC ~18:00-18:45) against the echo service tls.browserleaks.com (/json for TLS, /http2 for HTTP/2 frames and header order); tls.peet.ws timed out from this host. Clients: impers 0.1.2 from npm (koffi 3.3.2) on Node 24.19.0 (nixpkgs nodejs-slim, cross-checked on the official nodejs.org v24.19.0 linux-x64 binary) vs curl_cffi 0.16.0 on Python 3.14.7 (nixpkgs). Both loaded the SAME libcurl-impersonate 2.1.1 file, /nix/store/0djkdm67a5jj9vl7hs8cj5cib64mxxqc-curl-impersonate-2.1.1 (the store path in the running SearXNG closure, next to /nix/store/qgfj9khvnrh9m9a6znj5cq9ps1jvqzps-python3.14-curl-cffi-0.16.0). Target chrome146. impers source read at github.com/lexiforest/impers HEAD b7bbb24 (2026-09-01) and in the npm 0.1.2 dist; curl-impersonate source read at tag v2.1.1. Header tables checked against a net-log capture of real Chromium 152.0.7977.82 (Linux, headless) on the same date. Single host, single day, one echo service: re-measure when any of these versions move.'
---

# impers vs curl_cffi: Chrome 146 fingerprint with our own headers and no runtime download

## Verdict

- **Q1 (identical fingerprint): NO with stock impers 0.1.2, YES with one load-time change.** JA4, normalized JA3, the Akamai HTTP/2 string and the header order and values are identical to curl_cffi's. But the HTTP/2 HEADERS frame differs: curl_cffi (and real Chrome) set the PRIORITY flag (exclusive, weight 256) on it, and stock impers does not. The cause is not impers's logic. When libcurl-impersonate is loaded into a Node process, its calls to nghttp2 are resolved to Node's own nghttp2 1.69.0 (symbol interposition) instead of the nghttp2 1.63.0 compiled into libcurl-impersonate, and nghttp2 at or after 1.65 ignores RFC 7540 priority specs. Loading the library with `RTLD_DEEPBIND` (koffi's `koffi.load(path, { deep: true })`) makes impers byte-identical to curl_cffi on every field measured, including the HEADERS frame length (HPACK output). impers 0.1.2 does not expose that option (`dist/ffi/libcurl.js`: `koffi.load(await resolveLibcurlPath())`).
- **Q2 (only our headers, in our order): YES.** `impersonate: "chrome146"` plus `defaultHeaders: false` plus `headers` as an ordered array of `[name, value]` pairs sends exactly that set in that order, for every request kind tested. Caveats below (Accept-Encoding auto-add, cookie placement, zstd decoding, shared session).
- **Q3 (no runtime download, fail loud): YES for the download, PARTLY for failing loud.** Setting `LIBCURL_IMPERSONATE_PATH` (or `LIBCURL_PATH`) in `process.env` before impers is first imported fully skips the download code path; `IMPER_DOWNLOAD_LIBCURL=0` disables the download as a second switch. A missing library fails loud (the import rejects). A plain libcurl or a too-old libcurl-impersonate loads silently; it only fails loud when a request asks for `impersonate`, so serpcast must check it itself (strict mode).

**Recommendation for `impersonated-transport`:** do not use stock impers 0.1.2 as is, because it cannot produce SearXNG's (or Chrome's) HTTP/2 HEADERS frame on Linux. Either (a) take the ADR 0001 fallback, a direct koffi binding to libcurl-impersonate loaded with `{ deep: true }`, or (b) keep impers but load it with `{ deep: true }` through a patched dependency (a one-line change, verified below) and upstream an option for it. Both are the same fix; the fallback binding alone does NOT fix it unless it also uses `deep: true`, because the interposition is a property of loading the library into Node, not of impers. The choice between (a) and (b) is the transport task's to make (see "Choosing between (a) and (b)"). Whichever is chosen, the transport's verification test should assert the HEADERS PRIORITY flag, since JA3/JA4/Akamai all pass without it.

## Q1: fingerprints side by side

Same library file, target `chrome146`, same header table (the `document` table below). Values from tls.browserleaks.com.

| field | impers 0.1.2 (stock) | impers 0.1.2 + `deep: true` | curl_cffi 0.16.0 | match |
| --- | --- | --- | --- | --- |
| JA4 | `t13d1516h2_8daaf6152771_d8a2da3f94cd` | same | `t13d1516h2_8daaf6152771_d8a2da3f94cd` | yes |
| JA4_r | `t13d1516h2_002f,0035,009c,009d,1301,1302,1303,c013,c014,c02b,c02c,c02f,c030,cca8,cca9_0005,000a,000b,000d,0012,0017,001b,0023,002b,002d,0033,44cd,fe0d,ff01_0403,0804,0401,0503,0805,0501,0806,0601` | same | identical | yes |
| JA3n hash (extensions sorted) | `8e19337e7524d2573be54efb2b0784c9` | same | `8e19337e7524d2573be54efb2b0784c9` | yes |
| JA3 hash (raw) | differs on every connection | differs on every connection | differs on every connection | n/a, see below |
| Akamai HTTP/2 string | `1:65536;2:0;4:6291456;6:262144\|15663105\|0\|m,a,s,p` | same | same | yes |
| Akamai hash | `52d84b11737d980aef856699f885ca86` | same | `52d84b11737d980aef856699f885ca86` | yes |
| HEADERS frame flags | `5` (END_STREAM, END_HEADERS) | `37` (+ PRIORITY, exclusive=1, weight 256, dep 0) | `37` (+ PRIORITY, exclusive=1, weight 256, dep 0) | **no for stock** |
| HEADERS frame length, `document` / `fetch` table | 451 / 339 bytes | 456 / 344 | 456 / 344 | **no for stock** (5 bytes = the priority fields) |
| header order and values, all 4 kinds | our table, exactly | same | our table, exactly | yes |

Raw JA3 is not comparable by design: Chrome (and curl-impersonate's chrome targets) permute the TLS extension order on every connection, so the raw JA3 hash changed for all 4 connections of each client (curl_cffi: `5da35304…`, `40e7ebba…`, `5d7910f0…`, `9234c567…`; impers: `b0b29353…`, `5e6a9619…`, `417b1c7e…`, `fa911e7e…`). The cipher list, curves (`4588-29-23-24`) and the extension SET are identical (hence JA4 and JA3n). Sample raw `ja3_text` (impers): `771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,35-65037-11-23-43-17613-0-16-13-10-51-65281-5-18-45-27,4588-29-23-24,0`.

Real Chromium 152 (headless, same service, same day) for context: HEADERS flags `37` with exclusive=1 weight 256, the same Akamai string, JA4 `t13d1517h2_8daaf6152771_cb7bf5808d99` (one extension more than the chrome146 target; a version difference, not a finding against the target).

### Why stock impers loses the HEADERS priority (and why `deep: true` fixes it)

- libcurl-impersonate 2.1.1 statically links nghttp2 **1.63.0** (`CMakeLists.txt`: `NGHTTP2_VERSION "1.63.0"`, no nghttp2 patch in `patches/`) and zlib, and exports those symbols (`nm -D` shows 415 `nghttp2_*` symbols).
- nixpkgs `node` links `libnghttp2.so.14` (1.69.0) and `libz.so.1` (1.3.2) dynamically; the official nodejs.org binary bundles nghttp2 1.69.0 and exports 398 `nghttp2_*` symbols. Either way those symbols are in the process's global scope before koffi `dlopen`s libcurl-impersonate, so the library's own nghttp2 calls bind to Node's copy.
- Evidence: `Curl.version()` inside Node reports `nghttp2/1.69.0` and `zlib/1.3.2` for the same file that reports `nghttp2/1.63.0 zlib/1.3.1` inside Python. With `LD_PRELOAD` of the library, or with `koffi.load(path, { deep: true })`, Node reports `nghttp2/1.63.0` and the HEADERS frame gets the PRIORITY flag (flags 37, length 456, same as curl_cffi). Tested on both the nixpkgs and the official Node 24.19.0.
- nghttp2's docs for `nghttp2_submit_request` in current releases say "The pri_spec is ignored"; RFC 7540 priorities were deprecated in v1.60 with removal announced for after 2024. That matches the missing flag.
- `deep: true` maps to `RTLD_DEEPBIND` and exists on Linux and FreeBSD only (koffi `doc/load.md`). macOS (two-level namespaces) and Windows (no global symbol interposition for DLLs) were NOT measured; the transport should measure the frame there before claiming parity.
- libcurl-impersonate 2.2.2 (the version impers downloads by default) shows the same interposition (flags 5, length 451 in Node). The same TLS side and Akamai string as 2.1.1 for chrome146.

## Q2: sending only our header set, in our order

Mechanism (impers 0.1.2): `new Session({ impersonate: "chrome146", defaultHeaders: false })`, then `session.get(url, { headers: [[name, value], ...] })`. `defaultHeaders: false` is passed through to `curl_easy_impersonate(handle, "chrome146", 0)`, the same call curl_cffi makes for `default_headers=False`. impers keeps a `Headers` map keyed by lower-cased name in insertion order, so the array order is the wire order. Measured on all four request kinds: the HTTP/2 HEADERS frame carried the four pseudo-headers (`:method, :authority, :scheme, :path`, the chrome146 `m,a,s,p` order) followed by exactly our table, same as curl_cffi.

Things the transport must handle, all measured:

1. **Accept-Encoding is auto-added if missing.** impers's `buildHeaders` appends `Accept-Encoding: gzip, deflate, br` at the END when the caller's set has none (curl_cffi puts its own FIRST, via `CURLOPT_ACCEPT_ENCODING`). Always include `accept-encoding` in every table (Chrome sends it on every kind), or pass `acceptEncoding: ""` to suppress. With it present, both clients match exactly. libcurl adds nothing else: no `accept: */*` or `user-agent` of its own appeared when our table omitted them.
2. **zstd is not decoded by impers 0.1.2.** Chrome 146 advertises `gzip, deflate, br, zstd`, and browserleaks answered with `content-encoding: zstd` for every kind. impers decodes gzip, deflate and br in JS (`Session.decodeContent`) and returns zstd bodies RAW, so `response.json()` throws. The transport must decode zstd itself (`node:zlib` `zstdDecompressSync`, available in Node 24) or it will misread pages. Dropping `zstd` from the header would break the header/TLS coherence.
3. **Cookie placement.** Cookies from impers's cookie jar are sent through `CURLOPT_COOKIE`, and libcurl puts the `cookie` header FIRST, before `sec-ch-ua`. curl_cffi does the same, so SearXNG sends cookie first too. Real Chromium 152 sends `cookie` after `accept-language` and before `priority` (net-log, both navigation and fetch). A `cookie` pair placed in our own table at that position is sent there by impers (measured). So the transport can be Chrome-exact (own the cookie jar and put `cookie` in the table, keeping impers's jar empty) or SearXNG-exact (let the jar add it first). Those are different targets for cookie-bearing requests; the transport task should choose and record it.
4. **The top-level helpers share one hidden session.** `impers.get()`/`request()` use one module-level `Session` (`public.js` `getSharedSession`) whose jar keeps every `Set-Cookie` across calls. That is state serpcast did not ask for (ADR 0002). Use an explicit `Session` per engine and never the top-level helpers.
5. Do not use the `referer` or `userAgent` options: they add headers outside our table (Referer is set after the table). Put them in the table.
6. Target names impers does not know natively are looked up in `~/.config/impersonate/fingerprints.json` (`FingerprintManager`, a disk read). `chrome146` is native, so this does not happen for the pinned target, but a typo in the target would read that file before failing.

### Header tables used (Chrome 146, Linux)

Sources: the ORDER and the per-kind structure are from a net-log capture (`--log-net-log`, `HTTP2_SESSION_SEND_HEADERS`) of real Chromium 152.0.7977.82 on Linux, 2026-09-28, loading a top-level document, a same-origin `fetch()`, a dynamically inserted `<script src>`, and a same-origin link click with user activation. The `sec-ch-ua` value for 146 is from Chromium's brand GREASE algorithm (`components/embedder_support/user_agent_utils.cc`, `GenerateBrandVersionList`, seed = major version: permutation `146 % 6 = 2`, brand characters `146 % 11` and `147 % 11`, version `146 % 3`), and is byte-identical to the `sec-ch-ua` embedded in libcurl-impersonate 2.1.1's own chrome146 target (read with `strings`). Chromium 152 is unbranded headless, so its captured `sec-ch-ua` has only two brands and its user-agent says `HeadlessChrome`; the tables use branded Chrome values. `referer` is whatever page the request comes from.

- `document` (top-level navigation, typed URL): `sec-ch-ua: "Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"`, `sec-ch-ua-mobile: ?0`, `sec-ch-ua-platform: "Linux"`, `upgrade-insecure-requests: 1`, `user-agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36`, `accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7`, `sec-fetch-site: none`, `sec-fetch-mode: navigate`, `sec-fetch-user: ?1`, `sec-fetch-dest: document`, `accept-encoding: gzip, deflate, br, zstd`, `accept-language: en-US,en;q=0.9`, `priority: u=0, i`.
- `same-origin-navigation` (link click): as `document`, but `sec-fetch-site: same-origin` and `referer: <page>` between `sec-fetch-dest` and `accept-encoding`.
- `fetch` (same-origin fetch/XHR GET): `sec-ch-ua-platform`, `user-agent`, `sec-ch-ua`, `sec-ch-ua-mobile`, `accept: */*`, `sec-fetch-site: same-origin`, `sec-fetch-mode: cors`, `sec-fetch-dest: empty`, `referer`, `accept-encoding`, `accept-language`, `priority: u=1, i`. (Note the different order of the client hints on subresources.)
- `script` (dynamically inserted, async): as `fetch` but `sec-fetch-mode: no-cors`, `sec-fetch-dest: script`, and NO `priority` header (Chromium omits it at the default urgency). A parser-blocking `<script>` in `<head>` gets a higher priority and therefore a `priority` header; that case was not captured.
- With a cookie: `cookie` goes between `accept-language` and `priority` (or last, for `script`).

Not measured: cross-site `sec-fetch-site` values, POST requests (`origin`, `content-type`, `cache-control` placement), `accept-language` for non-English locales.

## Q3: library loading and the runtime download

impers resolves and `dlopen`s the library ONCE, at module evaluation (`dist/ffi/libcurl.js` top-level `await resolveLibcurlPath()`). A static `import "impers"` is hoisted above any code, so serpcast must set the env var and then load impers with a dynamic `await import("impers")`. Resolution order (`dist/ffi/loader.js` `resolveLibrary`):

1. `LIBCURL_IMPERSONATE_PATH`: used as is, reported `isImpersonate: true`.
2. `LIBCURL_PATH`: used as is; `isImpersonate` is a guess from the file name containing "impersonate".
3. Fixed system paths (`/usr/local/lib/libcurl-impersonate.so`, `/usr/lib/…`, …).
4. Download, unless `IMPER_DOWNLOAD_LIBCURL=0`: GitHub release `lexiforest/curl-impersonate` **v2.2.2** (`LIBCURL_IMPERSONATE_VERSION`; the README still says v2.0.0), into `IMPER_CACHE_DIR` or `$XDG_CACHE_HOME/impers/libcurl-impersonate` (default `~/.cache/…`), no checksum. Measured: about 90 MB written to the cache dir on first import. Release URL override is `IMPER_LIBCURL_RELEASE_URL` in the code (the README says `IMPERS_LIBCURL_RELEASE_URL`, which the code does not read).
5. System plain libcurl (`libcurl.so.4`, …, `LD_LIBRARY_PATH` searched first).

Measured outcomes (Node 24.19.0, impers 0.1.2, `IMPER_CACHE_DIR` pointed at a fresh temp dir):

| setup | result | download? |
| --- | --- | --- |
| `LIBCURL_PATH` or `LIBCURL_IMPERSONATE_PATH` = libcurl-impersonate 2.1.1 | loads; chrome146 works | no (cache dir never created) |
| path = missing file | `import("impers")` rejects: `Failed to load shared library` | no |
| path = plain libcurl 8.21.0 | loads SILENTLY (`isImpersonate: false`, `Curl.hasImpersonateSupport() === false`); a request with `impersonate` throws `ImpersonateError: Impersonating chrome146 is not supported`; a request WITHOUT `impersonate` succeeds with plain curl's fingerprint (JA4 `t13d3012h2_…`) | no |
| path = plain libcurl behind a file named `libcurl-impersonate.so` | same, but `resolveLibrary().isImpersonate` says `true` (a lie); `hasImpersonateSupport()` is still `false` | no |
| path = libcurl-impersonate 1.5.6 | loads; chrome146 works (same JA4/Akamai); `chrome150` throws `ImpersonateError … A libcurl function was given a bad argument` | no |
| no path, `IMPER_DOWNLOAD_LIBCURL=0`, no system lib (this NixOS host) | import rejects, loud | no |
| no path, `IMPER_DOWNLOAD_LIBCURL=0`, plain libcurl on `LD_LIBRARY_PATH` | loads plain libcurl SILENTLY, as the plain-libcurl row | no |
| no path, defaults | downloads v2.2.2 from GitHub on first import, then loads it | **yes** |

So for strict mode the transport should: set `LIBCURL_IMPERSONATE_PATH` (highest priority, no file-name guess) AND `IMPER_DOWNLOAD_LIBCURL=0` before the dynamic import; refuse unless `Curl.hasImpersonateSupport()` is true (a symbol check, unlike `isImpersonate`); pass the pinned target on EVERY request (a request without it silently uses plain libcurl's fingerprint); and treat `ImpersonateError` as the `impersonation` error. `Curl.version()` prints `libcurl/8.21.0-IMPERSONATE …` for both 2.1.1 and 2.2.2, so it proves an impersonate build but NOT which release; pinning 2.1.1 needs a checksum of the file (the `libcurl-install-and-doctor` task's job).

## Pinning curl_cffi's library

No throwaway venv was needed: this host's nixpkgs `python3.14-curl-cffi-0.16.0` (`/nix/store/qgfj9khv…`) is dynamically linked to the exact same `curl-impersonate-2.1.1` store path given to impers, and both are in the running SearXNG closure (`nix-store -qR` of the `anon-search` start script). So the comparison is same file, same version, no difference to record. (A PyPI `curl_cffi` wheel bundles its own libcurl-impersonate and would not be pinned this way.)

## How it was measured (spike code, deleted after recording)

Scratch dir outside the repo (`/tmp/fpspike`), nothing added to the packages. The essential calls:

```js
// Node: env set BEFORE the dynamic import; the library is loaded at module evaluation.
process.env.LIBCURL_PATH = "/nix/store/0djkdm67a5jj9vl7hs8cj5cib64mxxqc-curl-impersonate-2.1.1/lib/libcurl-impersonate.so";
process.env.IMPER_DOWNLOAD_LIBCURL = "0";
const impers = await import("impers");
const s = new impers.Session({ impersonate: "chrome146", defaultHeaders: false });
const r = await s.get("https://tls.browserleaks.com/http2", { headers: TABLE_AS_PAIRS, timeout: 20 });
// body is zstd: JSON.parse(zstdDecompressSync(r.content)); the HEADERS entry of .http2 gives flags, length, header order
// deep-bind variant: in node_modules/impers/dist/ffi/libcurl.js,
//   koffi.load(await resolveLibcurlPath())  ->  koffi.load(await resolveLibcurlPath(), { deep: true })
```

```python
# curl_cffi 0.16.0 (nixpkgs python3.14 env containing it)
from curl_cffi import requests
s = requests.Session(impersonate="chrome146", default_headers=False)
d = s.get("https://tls.browserleaks.com/http2", headers=[tuple(p) for p in TABLE_AS_PAIRS], timeout=20).json()
```

Chromium header capture: `chromium --headless=new --remote-debugging-port=… --log-net-log=net.json --net-log-capture-mode=IncludeSensitive`, driven over raw CDP (`Runtime.evaluate` with `userGesture: true`), then reading `HTTP2_SESSION_SEND_HEADERS` events. Also tried `tools.scrapfly.io/api/fp/anything` as a second echo service: it answered plain curl but returned an empty body to both impersonated clients, so it was not used.

## Choosing between (a) and (b)

Deciding this is the transport task's job. The facts it needs:

- (a) direct koffi binding: full control of load flags, header list and cookie handling, with no dependency that shares a cookie jar or decodes bodies partially. But serpcast would have to write the curl easy/multi binding itself (for scale, impers's `src/core` plus `src/ffi/libcurl.ts` are about 1700 lines of TypeScript, MIT, before the constants table and the loader).
- (b) impers with a patched load: very small change (one line, verified). But it is a patch on an alpha dependency (the README warns APIs may change without a major bump), and serpcast would still need to work around the Accept-Encoding auto-add, the missing zstd decoding, the shared session and the jar placing `cookie` first.
