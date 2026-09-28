# serpcast

Keyless search engines over HTTP with a real browser's fingerprint, driven by recipes shared with [searchcast](https://github.com/wighawag/searchcast).

Getting keyless web search results today usually means running SearXNG. What SearXNG really contributes is small: engine adapters that turn a results page into title/url/snippet, an HTTP client that looks like a real browser at the TLS and HTTP/2 level (curl_cffi over libcurl-impersonate), and per-engine handling of challenges and failures. serpcast is that, as a Node library plus a small CLI:

- Engines are described by **recipes**. A declarative recipe is the same JSON file searchcast runs in a real browser; serpcast runs it over plain HTTP. A code recipe is a JS module for sites that need challenge handling or a non-HTML API.
- All engine traffic goes through **libcurl-impersonate**, pinned to one explicit Chrome version, with the exact header set that Chrome sends for each kind of request, so the TLS side and the header side describe the same browser ([ADR 0001](docs/adr/0001-browser-fingerprint-via-libcurl-impersonate.md)).
- Engines are tried as an ordered **engine chain**, first answer wins, with searchcast (a real browser) as the fallback when HTTP is blocked.
- serpcast is **not** an anonymity tool, and it is built so one can use it safely: the caller injects the proxy, the state store and the recipe set; serpcast makes no network call the caller did not cause and writes nothing to disk on its own ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)).

Status: in development. The packages below are published at `0.0.0` as name placeholders; the functionality lands task by task (see `work/tasks/`). Available so far: the transport and the declarative recipe runner, with `serpcast query` for recipe development.

## Packages

serpcast is a pnpm workspace monorepo with two packages:

- **[`serpcast-recipe`](packages/serpcast-recipe)** (MIT, zero dependencies): the recipe schema, its TypeScript types and its validator. Shared by serpcast and searchcast so one recipe file describes a site for both. MIT so projects under any license can share the format ([ADR 0003](docs/adr/0003-shared-recipe-schema-mit-package.md)).
- **[`serpcast`](packages/serpcast)** (AGPL-3.0-only): the library (transport, recipe runners, engine chain) and the `serpcast` CLI for recipe development. Depends on `serpcast-recipe` via `workspace:*`.

## Transport (libcurl-impersonate)

Every engine request goes through the transport: a small direct [koffi](https://koffi.dev/) binding to [libcurl-impersonate](https://github.com/lexiforest/curl-impersonate) (not `impers`, see `work/notes/findings/impers-fingerprint-vs-curl-cffi.md`), pinned to `chrome146` with the library's default headers off. Each request carries exactly the header table Chrome 146 on Linux sends for its request kind (`document`, `same-origin-navigation`, `fetch`, `script`), with cookies from the session placed where Chrome puts them.

```ts
import {createTransport} from 'serpcast';

const transport = createTransport({proxy: 'socks5h://127.0.0.1:9050'});
const session = transport.session(); // cookies; session.cookies() is plain JSON
const page = await session.request('https://example.com/', {kind: 'document'});
const api = await session.request('https://example.com/api?q=x', {kind: 'fetch', referer: page.url});
```

- **Proxy and DNS.** The proxy URL (`http://`, `socks5://`, `socks5h://`) is passed to libcurl as given, and its scheme decides where DNS is resolved: **`socks5h://` resolves host names at the proxy, `socks5://` resolves them locally**, on this host. Callers that want no local DNS must pass `socks5h://`. With no proxy, the connection is direct: libcurl's proxy environment variables (`http_proxy`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are ignored, so the caller's option is the only egress policy.
- **Finding the library.** In order: the `libcurlPath` option, `SERPCAST_LIBCURL_PATH`, `LIBCURL_PATH`, then `libcurl-impersonate.so` (`.dylib`, `.dll`) in serpcast's data directory (`$XDG_DATA_HOME/serpcast/`, default `~/.local/share/serpcast/`). Nothing else is searched and nothing is ever downloaded. The pinned release and its checksums are `LIBCURL_IMPERSONATE` (libcurl-impersonate 2.1.1). The library is loaded once per process, so its path is process-global: a second instance asking for a different path fails with an `impersonation` error.
- **Strict mode** (default on): the first request (or `transport.check()`, which makes no network call) verifies the loaded library exports `curl_easy_impersonate` and accepts `chrome146`; otherwise it fails with an `impersonation` error saying how to fix it, before any network call. `strict: false` lets a plain libcurl send requests (with a non-browser TLS fingerprint).
- **Errors.** Every failure is a `SerpcastError` with a `kind`: network failures are `transport`, the time limit (`timeoutMs`, default 15 s) is `timeout`, and a missing or wrong library is `impersonation`. Aborting with the `signal` rejects with the signal's reason. The transport follows no redirects and does not interpret status codes; that is the caller's job.
- **Platforms.** On Linux (and FreeBSD) the library is loaded with `RTLD_DEEPBIND`, so it uses its own nghttp2 and the HTTP/2 HEADERS frame carries Chrome's PRIORITY flag (asserted in the tests). macOS and Windows have no `RTLD_DEEPBIND`: TLS impersonation works there, but HTTP/2 fingerprint parity with Chrome is not claimed (unmeasured). Response bodies are decoded with Node's zlib, including zstd (Node 22.15 or later).

## Declarative recipes over HTTP

`runDeclarativeRecipe(recipe, query, {session, signal?})` runs one [declarative recipe](packages/serpcast-recipe) (the same JSON file searchcast runs in a real browser) over the transport, with searchcast's semantics except that no script from the page runs:

```ts
import {createTransport, runDeclarativeRecipe} from 'serpcast';
import {loadRecipeFile} from 'serpcast-recipe/node';

const transport = createTransport({proxy: 'socks5h://127.0.0.1:9050'});
const {recipe, results} = await runDeclarativeRecipe(
	loadRecipeFile('./web.json'),
	'some query',
	{session: transport.session()},
);
// results: [{title, url, snippet?, ...extra fields}]
```

It requests `navigate.url` (`{query}` replaced by the URL-encoded query) as a typed-URL document navigation, follows redirects itself (at most 20, each hop through the session so cookies apply), then decides on the final response, in this order:

1. HTTP 202, 403 or 429, a `blockedUrl` pattern matching the final URL, or a `blocked` selector matching the page: a `blocked` error.
2. Any other non-2xx status: 404 and 410 are `recipe` errors (the URL template is wrong), everything else is a `transport` error. The status is in the message.
3. The `ready` selector matches: the results. Each `results.item` is read with its `fields` (visible text by default, `href`/`src` resolved to absolute URLs against `<base href>` or the final URL, like the DOM properties), items missing `title` or `url` are skipped, and the list is cut to `limit` (default 10). If no item has both, it is a `recipe` error.
4. The `empty` selector matches: `[]`. This is the only way to get an empty list.
5. Nothing matched: a `recipe` error (the page does not match the recipe).

`ready` is checked before `empty`, as searchcast does. Each result is `{title, url, snippet?}` with every other field passed through as a string; `snippet` is the first present of the `content`, `snippet` and `description` fields. A recipe that needs a browser (`form`) is rejected with a `recipe` error, before any request, telling you to run it through searchcast. The whole call, redirects included, is bounded by the recipe's `timeoutMs` (default 15 s, then a `timeout` error), and aborting `signal` rejects with its reason.

**One deliberate difference from searchcast.** searchcast keeps polling a live page until its deadline, so a page on which nothing matches, or on which `ready` matches but no item has both a title and a url, ends in a `timeout` there. serpcast answers `recipe` at once in both cases, because a static HTML response will not change.

Other differences come from having no browser: no JavaScript runs, so a site that renders its results with script needs a code recipe or searchcast; visible text approximates `innerText` without layout (text in `script`, `style`, `template`, `noscript` and `hidden` elements is dropped, block elements separate words, but CSS that hides an element is not seen); and the page is decoded with the `content-type` charset (UTF-8 by default), not a `<meta charset>`.

HTML is parsed with [htmlparser2](https://github.com/fb55/htmlparser2) and queried with [css-select](https://github.com/fb55/css-select) (cheerio's core, without cheerio): about 2.4 MB installed for the whole dependency closure, about 320 KB of it JavaScript, and it supports the selectors recipes use (combinators, attribute operators, `:not`, `:is`, `:has`). An invalid selector is a `recipe` error.

## CLI: `serpcast query`

For recipe development, `serpcast query` runs one declarative recipe once through the impersonated transport:

```sh
serpcast query --recipe ./web.json [--proxy socks5h://127.0.0.1:9050] [--libcurl /path/to/libcurl-impersonate.so] "some query"
```

The words after the options are joined into one query. The library is found as described above (`--libcurl` is the `libcurlPath` option).

| Exit code | Meaning                                                                                                                                                  |
| --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
|       `0` | The recipe answered: `{"recipe": "<name>", "results": [{"title", "url", "snippet"?, ...}]}` as JSON on stdout. `results` is `[]` only on an `empty` match. |
|       `1` | The search failed: `serpcast: <kind>: <message>` on stderr, where `<kind>` is the `SerpcastError` kind. An unreadable or invalid recipe file is `recipe`.  |
|       `2` | A usage error (unknown command or option, missing `--recipe` or query): the message and the usage on stderr.                                                |

## Size discipline (per-module LOC)

Every module stays small with one responsibility. Per-module LOC is tracked here as a first-class quality signal. `target` is a rough ceiling (a ceiling, not a promise); `LOC` is the actual line count of the source file. Each task that adds or grows a module updates its row.

### `packages/serpcast-recipe` (shared recipe schema)

| module          | LOC | target |
| --------------- | --: | -----: |
| `src/recipe.ts` | 179 |    200 |
| `src/node.ts`   |  41 |     60 |
| `src/index.ts`  |  39 |     60 |

### `packages/serpcast` (library + CLI)

| module             | LOC | target |
| ------------------ | --: | -----: |
| `src/transport.ts`   | 280 |    300 |
| `src/libcurl.ts`     | 246 |    260 |
| `src/declarative.ts` | 199 |    220 |
| `src/cookies.ts`     | 155 |    170 |
| `src/html.ts`        | 126 |    150 |
| `src/chrome.ts`      | 122 |    150 |
| `src/response.ts`    |  98 |    120 |
| `src/cli.ts`         |  90 |    120 |
| `src/index.ts`       |  61 |     80 |
| `src/errors.ts`      |  26 |     40 |

**Total own source: 1403 LOC** (excluding deps).

## Develop

```sh
pnpm install
pnpm format:check
pnpm build
pnpm test
```

`pnpm format:check && pnpm build && pnpm test` is the verify gate (`dorfl.json`) and what CI runs on every push and pull request. Tests run against the built packages, so build before testing.

The transport tests that need the native library run only when `SERPCAST_LIBCURL_PATH` points at a libcurl-impersonate shared library (and the plain-libcurl strict-mode tests only when `SERPCAST_TEST_PLAIN_LIBCURL` points at a plain libcurl); otherwise they are skipped with a message. CI fetches the pinned release named by `LIBCURL_IMPERSONATE`, verifies its checksum (`.github/scripts/fetch-libcurl.mjs`) and sets both, so they always run there.

## License

`serpcast` is licensed under the GNU Affero General Public License v3.0 only (see [`LICENSE`](LICENSE)). `serpcast-recipe` is licensed under the MIT License (see [`packages/serpcast-recipe/LICENSE`](packages/serpcast-recipe/LICENSE)).
