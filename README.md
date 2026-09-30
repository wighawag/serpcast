# serpcast

Keyless search engines over HTTP with a real browser's fingerprint, driven by recipes shared with [searchcast](https://github.com/wighawag/searchcast).

Getting keyless web search results today usually means running SearXNG. What SearXNG really contributes is small: engine adapters that turn a results page into title/url/snippet, an HTTP client that looks like a real browser at the TLS and HTTP/2 level (curl_cffi over libcurl-impersonate), and per-engine handling of challenges and failures. serpcast is that, as a Node library plus a small CLI:

- Engines are described by **recipes**. A declarative recipe is the same JSON file searchcast runs in a real browser; serpcast runs it over plain HTTP. A code recipe is a JS module for sites that need challenge handling or a non-HTML API.
- All engine traffic goes through **libcurl-impersonate**, pinned to one explicit Chrome version, with the exact header set that Chrome sends for each kind of request, so the TLS side and the header side describe the same browser ([ADR 0001](docs/adr/0001-browser-fingerprint-via-libcurl-impersonate.md)).
- Engines are tried as an ordered **engine chain**, first answer wins, with searchcast (a real browser) as the fallback when HTTP is blocked.
- serpcast is **not** an anonymity tool, and it is built so one can use it safely: the caller injects the proxy, the state store and the recipe set; serpcast makes no network call the caller did not cause and writes nothing to disk on its own ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)).

Status: in development (0.x; the API may still change between minor versions). The functionality lands task by task (see `work/tasks/`). Available so far: the engine chain with its state store, the transport, the declarative recipe runner, code recipes and browser engines (searchcast), with `serpcast query` for recipe development, `serpcast install-libcurl` to install the native library, `serpcast doctor` to check it, and `serpcast install-recipes` to install a checksum-pinned set of recipes.

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
session.documentCookies.set(page.url, 'token=abc; Path=/'); // as the page's script would (document.cookie)
session.close(); // closes the session's connections (cookies are kept)
```

`createTransport(options)` takes:

| option                | default                                                     | meaning                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libcurlPath`         | `SERPCAST_LIBCURL_PATH`, `LIBCURL_PATH`, the data directory | The libcurl-impersonate shared library (see Finding the library, below).                                                                                                                                |
| `proxy`               | none (direct)                                               | The proxy for all traffic (`http://`, `socks5://`, `socks5h://`, see Proxy and DNS, below).                                                                                                             |
| `strict`              | `true`                                                      | Refuse to send unless libcurl-impersonate accepts the pinned target (see Strict mode, below). A security guarantee: `false` sends with a non-browser fingerprint.                                        |
| `timeoutMs`           | 15000 (15 s)                                                | Per-request time limit.                                                                                                                                                                                 |
| `caPath`              | the library's default                                       | A PEM CA bundle to verify servers against.                                                                                                                                                              |
| `maxBodyBytes`        | 16 MiB                                                      | Largest response body, before and after decoding; larger is a `transport` error.                                                                                                                        |
| `reuseConnections`    | `true`                                                      | Keep a session's connections open between its requests, as Chrome does (see Connections, below). `false`: one connection per request, closed after it (serpcast 0.1's behaviour), so a session's requests are not linked at the connection level (its cookies still link them). |
| `idlePollMs`          | 5                                                           | How long an in-flight request waits between two looks at sockets that had nothing to do, in ms. Lower costs more CPU per waiting request, higher adds up to that much latency to each network event.   |
| `maxRequestBodyBytes` | 1 MiB (`MAX_REQUEST_BODY_BYTES`)                            | Largest POST body; larger is a `recipe` error and nothing is sent.                                                                                                                                      |
| `preflightCache`      | `true`                                                      | Remember an allowed CORS preflight for its `access-control-max-age`, as Chrome does. `false`: preflight every such POST.                                                                                 |
| `maxPreflightAgeS`    | 7200 (Chromium's cap)                                       | The longest a preflight is remembered, in seconds.                                                                                                                                                      |

Every numeric option must be a positive finite number (a whole number for times in ms passed to libcurl, byte sizes and counts); anything else, or a boolean option that is not a boolean, throws a `RangeError` naming the option when the transport (or `createSerpcast`) is created. The defaults are the behaviour of earlier versions, so nothing changes unless you set an option.

- **Header tables and `sec-fetch-site`.** `document` is a typed-URL navigation (`sec-fetch-site: none`) and `same-origin-navigation` a link click on the same origin. For `fetch` and `script`, `sec-fetch-site` is derived from the request URL relative to the `referer` (the page it comes from), as Chrome does: same scheme, host and port is `same-origin`; same scheme and registrable domain (any port) is `same-site` (`https://cdn.example.com` from `https://www.example.com`); anything else, `http` to `https` included, is `cross-site`. A request that is not same-origin sends only the page's origin as `referer` (Chrome's default referrer policy), a `fetch` adds `origin`, and a cross-site one adds `sec-fetch-storage-access: active`, as measured in `work/notes/findings/sec-fetch-site-by-initiator.md`. The registrable domain comes from a small built-in rule, not the public suffix list: the last two labels, or three under a two-letter TLD with a common second level (`example.co.uk`, `example.com.au`). It does not know private suffixes such as `github.io`, so pass `fetchSite: 'cross-site'` (or `'same-site'`, `'same-origin'`) when you know better: `session.request(url, {kind: 'script', referer, fetchSite: 'cross-site'})`.
- **POST (`fetch` only).** `session.request(url, {kind: 'fetch', method: 'POST', referer, body, contentType})` sends a page's `fetch()` POST with Chrome's exact headers (`content-length` first, `content-type` after `sec-ch-ua`, `origin` always, same-origin included), as measured in `work/notes/findings/post-requests.md`. `body` is a string (UTF-8) or a `Uint8Array`, at most `maxRequestBodyBytes` (default `MAX_REQUEST_BODY_BYTES`, 1 MiB); `contentType` defaults as `fetch()` does (`text/plain;charset=UTF-8` for a string, none for bytes). When Chrome would send a CORS preflight first (another origin, same-site included, with a `content-type` that is not CORS-safelisted, such as `application/json`), the session sends it too: an `OPTIONS` without cookies, on a connection of its own (as Chrome keeps credential-less requests apart), remembered for its `access-control-max-age` (default 5 s, at most `maxPreflightAgeS`; `preflightCache: false` remembers none). If the preflight does not allow the POST, the POST is not sent: a 202/403/429 answer is `blocked`, 404/410 `recipe`, another non-2xx `transport`, and CORS headers that do not allow it (`access-control-allow-origin` not the page's origin, no `access-control-allow-credentials: true`, `content-type` not allowed) are `recipe`. Navigation (form) POSTs are not offered.
- **Connections.** A session keeps its connections open between its requests and reuses them, as Chrome does: one HTTP/2 connection per origin (concurrent requests to an origin wait for it rather than opening a second one), through the same proxy tunnel when there is a proxy. Connections are never shared between sessions: sessions (two engines, two callers) must stay unlinkable, and a shared connection would link them at the TLS and IP layer. `session.close()` closes them (at once when idle, else when the requests in flight settle); a later request opens a new one. An idle session keeps nothing running, so it never keeps the process alive. With `reuseConnections: false`, each request (a preflight included) opens its own connection and closes it when it settles.

- **Proxy and DNS.** The proxy URL (`http://`, `socks5://`, `socks5h://`) is passed to libcurl as given, and its scheme decides where DNS is resolved: **`socks5h://` resolves host names at the proxy, `socks5://` resolves them locally**, on this host. Callers that want no local DNS must pass `socks5h://`. With no proxy, the connection is direct: libcurl's proxy environment variables (`http_proxy`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`) are ignored, so the caller's option is the only egress policy.
- **Finding the library.** In order: the `libcurlPath` option, `SERPCAST_LIBCURL_PATH`, `LIBCURL_PATH`, then `libcurl-impersonate.so` (`.dylib`, `.dll`) in serpcast's data directory (`$XDG_DATA_HOME/serpcast/`, default `~/.local/share/serpcast/`), where [`serpcast install-libcurl`](#installing-libcurl-impersonate) puts it. Nothing else is searched, and the library is never downloaded as a side effect: only that command, typed by you, downloads it. The pinned release and its checksums are `LIBCURL_IMPERSONATE` (libcurl-impersonate 2.1.1). The library is loaded once per process, so its path is process-global: a second instance asking for a different path fails with an `impersonation` error.
- **Strict mode** (default on): the first request (or `transport.check()`, which makes no network call) verifies the loaded library exports `curl_easy_impersonate` and accepts `chrome146`; otherwise it fails with an `impersonation` error saying how to fix it, before any network call. `strict: false` lets a plain libcurl send requests (with a non-browser TLS fingerprint).
- **Errors.** Every failure is a `SerpcastError` with a `kind`: network failures are `transport`, the time limit (`timeoutMs`, default 15 s) is `timeout`, and a missing or wrong library is `impersonation`. Aborting with the `signal` rejects with the signal's reason. The transport follows no redirects and does not interpret status codes; that is the caller's job.
- **Platforms.** On Linux (and FreeBSD) the library is loaded with `RTLD_DEEPBIND`, so it uses its own nghttp2 and the HTTP/2 HEADERS frame carries Chrome's PRIORITY flag (asserted in the tests). macOS and Windows have no `RTLD_DEEPBIND`: TLS impersonation works there, but HTTP/2 fingerprint parity with Chrome is not claimed (unmeasured). Response bodies are decoded with Node's zlib, including zstd (Node 22.15 or later).

## Engine chain (`createSerpcast`)

The library's main entry. A search tries an ordered list of engines and stops at the **first answer** (results, or an `empty` match), so a query costs as few requests as possible: engines gate on request volume per exit IP, and querying every engine per search (SearXNG's fan-out) spends that budget. There is no merging or ranking across engines.

```ts
import {createSerpcast, SerpcastError} from 'serpcast';
import {loadRecipeFile} from 'serpcast-recipe/node';

const serpcast = createSerpcast({proxy: 'socks5h://127.0.0.1:9050'});
const engines = [loadRecipeFile('./first.json'), loadRecipeFile('./second.json')];
try {
	const {results, engine, failures} = await serpcast.search('some query', {engines, maxResults: 10});
	// results: [{title, url, snippet?, ...}], engine: the name of the recipe that answered,
	// failures: [{engine, error}] for each engine tried before it
} catch (error) {
	if (error instanceof SerpcastError && error.kind === 'exhausted') console.log(error.failures);
	else throw error;
}
await serpcast.clearSessions(); // or clearSessions('first'), by engine name
await serpcast.close(); // closes engine connections, stops a library-mode browser if one was started
```

`createSerpcast(options)` takes the [transport options](#transport-libcurl-impersonate) (`libcurlPath`, `proxy`, `strict`, `timeoutMs`, `caPath`, `maxBodyBytes`, `reuseConnections`, `idlePollMs`, `maxRequestBodyBytes`, `preflightCache`, `maxPreflightAgeS`; checked even when a `transport` is injected, though they then do not apply) plus the options below, checked the same way (a `RangeError` at creation):

| option          | default                            | meaning                                                                                               |
| --------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `store`         | in memory                          | The state store for sessions and cooldowns (below).                                                   |
| `cooldownMs`    | 5 minutes                          | How long an engine that answered `blocked` is skipped (`DEFAULT_COOLDOWN_MS`). `0`: no cooldown.      |
| `sessionIdleMs` | 10 minutes                         | An engine's session is dropped after this long without a search using it (`DEFAULT_SESSION_IDLE_MS`). |
| `now`           | `Date.now`                         | The clock for cooldowns and sessions (and the default store).                                         |
| `transport`     | created from the transport options | A transport to use instead (tests, or sharing one between instances).                                 |
| `searchcast`    | none                               | How library-mode [browser engines](#browser-engines-searchcast) start searchcast.                     |
| `decoyGuard`    | none                               | The engines (by name) whose answers are checked for [decoys](#decoy-guard), e.g. `['bing']`, on top of those whose recipe declares `decoyProne: true`. Or `{include?: string[], exclude?: string[]}`: `include` is the array form, `exclude` names engines never checked, even when their recipe declares `decoyProne` (exclude wins). |
| `decoyRule`     | `{top: 5, maxRelevant: 1, prefix: 5}` (`DEFAULT_DECOY_RULE`) | The [decoy rule](#decoy-guard)'s thresholds, each a positive whole number; set any of them. The defaults are the measured values: changing them is at your own risk. |
| `keepSessions`  | `true`                             | Keep each HTTP engine's transport session (its open connections) in memory between searches (see Sessions, below). `false`: every search opens new connections and closes them after; cookies and state still go through the store. |
| `maxRedirects`  | 20 (Chrome's limit)                | How many redirects a declarative recipe follows; one more is a `transport` error. `0` follows none.   |

`search(query, {engines, maxResults?, signal?})`: an engine is a declarative recipe, a [code recipe](#code-recipes) or a [browser engine](#browser-engines-searchcast), identified by its `name`. `maxResults` cuts the answer (each recipe's `limit` still applies). How each outcome is handled:

- **Results or an `empty` match**: returned as `{results, engine, failures}`. Later engines are not called.
- **`blocked`, `recipe`, `timeout`, `transport`**: recorded in `failures` and the next engine is tried. `blocked` also starts the engine's **cooldown**: until it ends, the engine is skipped and listed in `failures` with a `blocked` error saying it is cooling down (so an all-skipped chain still says why).
- **`decoy`** (only for a guarded engine: named in `decoyGuard`, or its recipe declares `decoyProne: true`): its answer was a page unrelated to the query. Recorded in `failures` and the next engine is tried, with **no cooldown** (see [Decoy guard](#decoy-guard)).
- **Every engine failed**: the search throws a `SerpcastError` of kind `exhausted`, whose `failures` lists every `{engine, error}` in order. It never answers `[]` for that. An empty `engines` list is `exhausted` too.
- **`impersonation`** is not an engine failure: it means every HTTP engine would search with the wrong fingerprint, so the search is aborted at once with that error (no later engine is tried, including a browser engine). Check `error.kind === 'impersonation'`.
- **Aborting `signal`** rejects with the signal's reason; it is not an engine failure.

### Decoy guard

Some engines, Bing above all, answer some queries with a well-formed page of results unrelated to the query: a **decoy** (dictionary entries for "why" in answer to a question about Git, a gaming guide for a Debian kernel query). Nothing in the page says so, so without a guard it is returned as the answer. Measured in September 2026, through serpcast and two plain Node clients side by side, Bing decoyed about half of realistic queries (natural-language questions, 4 to 6 term technical queries) from a residential IP and most of them over Tor. It decoyed the SAME queries for every client, and over Tor a given query decoyed on every repeat; an immediate retry rescued none of 16 decoys. A decoy is a property of the engine, the query and the moment, not of the client, so no transport fixes it.

`decoyGuard: ['bing']` checks the answers of the engines it names (any kind: declarative, code or browser; off by default). An engine whose recipe declares `decoyProne: true` is checked without being named: the recipe's author knows whether the site serves decoys, and engine names are chosen by the caller, so naming them is fragile. A declarative recipe declares it in its JSON, a code recipe on its default export, and a library-mode browser engine inherits it from its recipe (an endpoint-mode browser engine has no recipe object here, so name it in `decoyGuard`). An engine is guarded when either holds, unless it is named in `decoyGuard: {exclude: [...]}`, which switches the guard off for it (exclude wins over both; passing the engine as `{...recipe, decoyProne: false}` also works). A decoy answer becomes a `decoy` failure and the chain moves on to the next engine. It starts **no cooldown**: decoys are per query, and cooling the engine would drop its good answers to other queries. The rule, `isDecoy(query, results)`, is exported so code recipes and callers can apply it themselves:

- The query's **terms** are its distinct words of 3 or more characters, minus a fixed list of function words and generic modifiers (`why`, `does`, `best`, `using`, ...).
- A result is **relevant** when its title, snippet and URL together carry at least two distinct terms (or the only one), a term matching any word with the same first 5 characters ("replication" matches "replicate").
- A page is a **decoy** when at most one of its top 5 results is relevant. A query with fewer than 2 terms, or a page with fewer than 3 results, is never judged. The whole answer is judged, before the `maxResults` cut.

The rule is a port of a guard measured on a live deployment: it flagged every decoy seen and none of about 55 genuine pages. Those measured values (the top 5 results, at most 1 relevant, 5-character prefixes) are the defaults of `decoyRule`, and `isDecoy(query, results, rule?)` takes the same override. **Other values were not measured**: change them at your own risk. The stopword list, the 3-character term minimum and the never-judged floor (fewer than 2 terms or 3 results) are not options.

### State store

Cooldowns and sessions live in a **state store** the caller injects, because where state lives and how it is partitioned (per identity, per process, on disk or not) is a privacy decision ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)). The default, `createMemoryStore()`, keeps them in a Map in this instance and writes nothing to disk; serpcast ships no file store. A store is a small async key/value interface with per-key expiry, holding plain JSON:

```ts
import type {JsonValue, StateStore} from 'serpcast';

interface StateStore {
	get(key: string): Promise<JsonValue | undefined>; // undefined when absent or expired
	set(key: string, value: JsonValue, options?: {ttlMs?: number}): Promise<void>;
	delete(key: string): Promise<void>;
}
```

serpcast namespaces its keys per engine name: `engine/<name>/session` (the engine's cookies and last use) and `engine/<name>/cooldown` (when it ends), with `<name>` URL-encoded, plus `serpcast/sessions`, the list of engines with a session (so `clearSessions()` finds them in any store). Every value carries the time serpcast relies on and is checked with serpcast's clock, and every `set` passes a `ttlMs` so the store can drop it; a store that expires late is still correct. Give each identity its own store (or key prefix) to keep their sessions apart.

**Sessions.** Each engine gets a transport session whose cookies (and, for a code recipe, its `ctx.session` state) are loaded from the store before the engine runs and saved after, whatever the outcome (a challenge page may set the cookie that lets the next attempt through). A session unused for `sessionIdleMs` is dropped, and `clearSessions(engine?)` drops one engine's session or all of them. Two concurrent searches on the same engine each save their own cookies; the last save wins. The instance also keeps each engine's transport session between searches, so the next search reuses its open connections (never another engine's); they are closed when the engine's session is dropped (idle for `sessionIdleMs`, `clearSessions()`, or `close()`), or when the store holds other cookies for it (another instance saved them). An engine's connections never keep the process alive. With `keepSessions: false` the instance keeps none: each search makes a new transport session from the store's cookies and closes it when the engine is done.

## Declarative recipes over HTTP

`runDeclarativeRecipe(recipe, query, {session, signal?, maxRedirects?})` runs one [declarative recipe](packages/serpcast-recipe) (the same JSON file searchcast runs in a real browser) over the transport, with searchcast's semantics except that no script from the page runs:

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

It requests `navigate.url` (`{query}` replaced by the URL-encoded query) as a typed-URL document navigation, follows redirects itself (at most `maxRedirects`, default 20, each hop through the session so cookies apply), then decides on the final response, in this order:

1. HTTP 202, 403 or 429, a `blockedUrl` pattern matching the final URL, or a `blocked` selector matching the page: a `blocked` error.
2. Any other non-2xx status: 404 and 410 are `recipe` errors (the URL template is wrong), everything else is a `transport` error. The status is in the message.
3. The `ready` selector matches: the results. Each `results.item` is read with its `fields` (visible text by default, `href`/`src` resolved to absolute URLs against `<base href>` or the final URL, like the DOM properties), items missing `title` or `url` are skipped, and the list is cut to `limit` (default 10). If no item has both, it is a `recipe` error.
4. The `empty` selector matches: `[]`. This is the only way to get an empty list.
5. Nothing matched: a `recipe` error (the page does not match the recipe).

A recipe may declare `"decoyProne": true` when its site sometimes answers with results unrelated to the query; the [engine chain](#decoy-guard) then checks its answers (the runner itself ignores the field).

`ready` is checked before `empty`, as searchcast does. Each result is `{title, url, snippet?}` with every other field passed through as a string; `snippet` is the first present of the `content`, `snippet` and `description` fields. A recipe that needs a browser (`form`) is rejected with a `recipe` error, before any request, telling you to run it through searchcast. The whole call, redirects included, is bounded by the recipe's `timeoutMs` (default 15 s, then a `timeout` error), and aborting `signal` rejects with its reason.

**One deliberate difference from searchcast.** searchcast keeps polling a live page until its deadline, so a page on which nothing matches, or on which `ready` matches but no item has both a title and a url, ends in a `timeout` there. serpcast answers `recipe` at once in both cases, because a static HTML response will not change.

Other differences come from having no browser: no JavaScript runs, so a site that renders its results with script needs a code recipe or searchcast; visible text approximates `innerText` without layout (text in `script`, `style`, `template`, `noscript` and `hidden` elements is dropped, block elements separate words, but CSS that hides an element is not seen); and the page is decoded with the `content-type` charset (UTF-8 by default), not a `<meta charset>`.

HTML is parsed with [htmlparser2](https://github.com/fb55/htmlparser2) and queried with [css-select](https://github.com/fb55/css-select) (cheerio's core, without cheerio): about 2.4 MB installed for the whole dependency closure, about 320 KB of it JavaScript, and it supports the selectors recipes use (combinators, attribute operators, `:not`, `:is`, `:has`). An invalid selector is a `recipe` error.

## Code recipes

A code recipe is a JS module for a site that needs challenge handling or a non-HTML API. **A code recipe is code with full Node access**: loading one runs it, and nothing stops it from importing `fs` or opening its own sockets. serpcast hands it only the context below, but which modules to load is your trust decision ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)). **Only load recipes you trust.** Recipes live anywhere on disk (private ones never need to be in this repo) and are loaded only from the path you give; serpcast never looks for them.

```js
// ./my-api.mjs: an example for a keyless JSON API. The endpoint is a placeholder:
// point it at an API whose terms allow automated access.
export default {
	name: 'my-api',
	timeoutMs: 10_000, // the whole search; optional, default 15 s
	// decoyProne: true, // optional: the chain checks answers for decoys (see Decoy guard)
	async search(query, ctx) {
		const data = await ctx.http.json(`https://api.example.com/search?q=${encodeURIComponent(query)}`, {kind: 'document'});
		if (data.captcha) ctx.blocked('the API asks for a captcha');
		if (!Array.isArray(data.items)) ctx.recipeError('no "items" in the response');
		return data.items.slice(0, ctx.maxResults).map((item) => ({title: item.title, url: item.link, snippet: item.summary}));
	},
};
```

```ts
import {createSerpcast, loadCodeRecipe} from 'serpcast';
import {loadRecipeFile} from 'serpcast-recipe/node';

const serpcast = createSerpcast({proxy: 'socks5h://127.0.0.1:9050'});
const myApi = await loadCodeRecipe('./my-api.mjs'); // imports (runs) the module
const {results} = await serpcast.search('some query', {engines: [myApi, loadRecipeFile('./fallback.json')]});
```

`loadCodeRecipe(path)` imports the ESM module at `path` (relative to the working directory) and returns its default export, which must be `{name, search(query, ctx), timeoutMs?, decoyProne?}` (`decoyProne` a boolean, see [Decoy guard](#decoy-guard)); a module that cannot be imported or has another shape is a `recipe` error. A code recipe goes in the engine chain like a declarative one (same failures, cooldowns and sessions), and `runCodeRecipe(recipe, query, {session, state?, signal?, maxResults?})` runs one outside a chain (`session` needs `request`, and `documentCookies` for `ctx.cookies`). `search` returns (or resolves to) the results; `ctx` is:

| member                          | what it is                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.get(url, {kind, referer?, fetchSite?, timeoutMs?})` | A GET through the engine's transport session: the caller's proxy, the pinned Chrome fingerprint and the header table of `kind` (`document`, `same-origin-navigation`, `fetch`, `script`; all but `document` need a `referer`; for `fetch` and `script`, `sec-fetch-site` is derived from `url` and `referer` unless `fetchSite` overrides it, see [Transport](#transport-libcurl-impersonate)), with the engine's cookies sent and kept. Resolves to the raw response (`status`, `headers`, `body`, `text()`), whatever its status; redirects are not followed. |
| `http.text(url, options)`       | The body as text. Statuses map as for declarative recipes: 202, 403, 429 are `blocked`; 404, 410 are `recipe`; any other non-2xx (3xx included) is `transport`.                                                                                                                                                                                                                                                 |
| `http.json(url, options)`       | The body parsed as JSON, statuses as for `text`. A body that is not JSON (often a challenge page) is a `recipe` error.                                                                                                                                                                                                                                                                                           |
| `http.post(url, {kind: 'fetch', referer, body?, contentType?, fetchSite?, timeoutMs?})` | A page's `fetch()` POST through the engine's transport session (see POST under [Transport](#transport-libcurl-impersonate)): `body` a string or a `Uint8Array` (at most 1 MiB), `contentType` defaulting as `fetch()` does; the CORS preflight Chrome would send first is sent too. `kind` must be `fetch`. Resolves to the raw response, whatever its status. |
| `http.postJson(url, value, {kind: 'fetch', referer, contentType?, fetchSite?, timeoutMs?})` | POSTs `JSON.stringify(value)` as `application/json` (unless `contentType` says otherwise) and parses the answer as `json` does, with the same status mapping. A value JSON cannot represent is a `recipe` error. |
| `cookies.set(url, cookie)`, `cookies.get(url)`, `cookies.delete(url, name)` | The engine's transport-session cookies as a page's script sees them (`document.cookie`), for a cookie a site sets from JavaScript (a challenge token) rather than with `Set-Cookie`. `set` applies `cookie` (`name=value; Path=/; Secure; Max-Age=60; Domain=...`) as `document.cookie = cookie` would on the page at `url`: the `Set-Cookie` rules of the store (host-only unless a valid `Domain` is given, `Path` defaulting to the URL's directory, `Secure` only from https, `__Secure-`/`__Host-` prefixes), `HttpOnly` ignored, and never replacing an `HttpOnly` cookie. It returns `false` when the cookie is rejected (a browser drops it silently), else `true`. The cookie is then sent, where Chrome puts it, by every `http` request it matches, and kept and dropped with the session like any cookie. `get(url)` is what `document.cookie` reads there (`name=value; ...` of the non-`HttpOnly` cookies sent to `url`, `''` when none); `delete(url, name)` removes the cookies named `name` that `get(url)` shows. Names and values are kept byte for byte (`#` included). A `url` that is not http(s) is a `recipe` error. |
| `session.get(key)`, `session.set(key, value)`, `session.delete(key)` | The engine's own JSON state (a token, a challenge answer), kept in the state store with its cookies: saved after every run whatever the outcome, dropped after `sessionIdleMs` unused or by `clearSessions()`. Values are copied; a value that is not plain JSON is a `recipe` error.                                                                                                                            |
| `signal`                        | Aborts on the caller's abort or the recipe's `timeoutMs`. Every `http` request already carries it.                                                                                                                                                                                                                                                                                                              |
| `maxResults`                    | The caller's `maxResults`, when given (the answer is cut to it anyway).                                                                                                                                                                                                                                                                                                                                         |
| `blocked(message)`              | Throws a `blocked` error: the engine's cooldown starts.                                                                                                                                                                                                                                                                                                                                                         |
| `recipeError(message)`          | Throws a `recipe` error (the site no longer fits the recipe).                                                                                                                                                                                                                                                                                                                                                   |

The results are validated: an array of `{title, url, snippet?, ...}` with a non-empty `title` and `url` and every field a string (fields set to `undefined` are dropped). Anything else is a `recipe` error, and so is any throw that is not a `SerpcastError` (with the original as `cause`). `[]` is a valid answer: the module says the site has no results, and the chain stops there, so throw `recipeError` when the response is not one you understand. The whole search is bounded by `timeoutMs` (a `timeout` error); aborting the caller's `signal` rejects with its reason.

serpcast ships no code recipe for a real site as part of the package: write your own, for engines whose terms allow automated access. The repo has one example to start from. To install a set of recipes someone publishes, see [Installing recipes](#installing-recipes-serpcast-install-recipes).

### Example: Marginalia Search

[`examples/recipes/marginalia.mjs`](examples/recipes/marginalia.mjs) is a code recipe for [Marginalia Search](https://marginalia-search.com), an independent web search engine that offers an API meant for programs. It is an example, not an engine bundled with serpcast: it lives in the repo, outside the published packages, so get it from the repo (a clone, or the file itself).

The terms, from [Marginalia's API page](https://about.marginalia-search.com/article/api/) (read 2026-09-29): the key `public` is for experimentation and its rate limit is shared by everyone who uses it (the API answers HTTP 503 when it is hit); for regular use, ask Marginalia for a free personal (non-commercial) key, or buy one on that page. Results are provided under [CC-BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/), so what you do with them has to respect that licence.

```ts
import {createSerpcast, loadCodeRecipe} from 'serpcast';

const serpcast = createSerpcast();
// Reads MARGINALIA_API_KEY at each search, else uses the shared `public` key.
const marginalia = await loadCodeRecipe('./examples/recipes/marginalia.mjs');
const {results} = await serpcast.search('linear b', {engines: [marginalia], maxResults: 10});
```

Or copy the file next to your private recipes and load it from there. It calls the URL-keyed API (`https://api.marginalia.nu/<key>/search/<query>?count=<n>`), which Marginalia lists as deprecated but working as long as the project does, because the current API takes the key in an `API-Key` header and serpcast's transport sends only Chrome's headers. It maps each result's `title`, `url` and `description` (as `snippet`), sends `maxResults` as `count` (clamped to 1..100), treats HTTP 503 and 429 (the rate limit) as `blocked` so the engine cools down, and a response without a `results` array as a `recipe` error. The key is part of the URL, so it appears in the URL that error messages name.

## Browser engines (searchcast)

A browser engine runs a recipe in [searchcast](https://github.com/wighawag/searchcast), a real browser, so it has a real browser's fingerprint and runs the page's JavaScript. It is the heaviest engine, so it usually goes **last** in the chain, after the HTTP engines: it answers when they are blocked. It joins the chain like any engine (same failures and cooldowns); it has no serpcast session, since the browser keeps its own cookies in its profile. There are two modes.

**Library mode**: serpcast runs searchcast in-process. `searchcast` is an optional peer dependency, imported only when a library-mode engine first runs (nothing else in serpcast imports it), so users of HTTP engines never install it or Chromium. Without it, the engine fails with a `transport` error saying `npm install searchcast`.

```ts
import {createSerpcast} from 'serpcast';
import {loadRecipeFile} from 'serpcast-recipe/node';

const serpcast = createSerpcast({
	proxy: 'socks5h://127.0.0.1:9050', // the browser uses it too
	searchcast: {xvfb: '/usr/bin/Xvfb'}, // or {headless: true}
});
const web = loadRecipeFile('./web.json');
const {results, engine} = await serpcast.search('some query', {
	engines: [web, {name: 'web-browser', searchcast: {recipe: web}}],
});
await serpcast.close(); // stops the browser
```

The browser is started lazily, on the first search that reaches a library-mode engine, and one browser serves every library-mode engine of the instance; `close()` stops it. The `searchcast` option (names follow searchcast's CLI flags):

| option       | default                                                   | meaning                                                                          |
| ------------ | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `chrome`     | searchcast's search (`$SEARCHCAST_CHROME`, then `PATH`)   | The Chromium or Chrome executable.                                               |
| `xvfb`       | none                                                      | Run the browser headful on a private Xvfb display started from this executable. |
| `headless`   | `false`                                                   | Run headless (easier for sites to tell apart from a person).                     |
| `profile`    | a temporary directory                                     | The browser profile directory (cookies and history accumulate there).           |
| `concurrency`| searchcast's (2 tabs)                                     | Maximum simultaneous tabs.                                                       |
| `chromeArgs` | none                                                      | Extra Chromium arguments.                                                        |

- **Proxy.** serpcast's `proxy` is the browser's proxy. Chromium does not accept `socks5h://` and resolves host names at any SOCKS5 proxy, so `socks5h://` is passed as `socks5://`, which keeps DNS at the proxy (checked with Chromium 151: the host name reaches the proxy, and `socks5h://` is not accepted at all). Note that a plain `socks5://` also resolves at the proxy in the browser, unlike the HTTP transport, where it resolves locally. With no proxy, the browser connects directly.
- **Profile.** searchcast needs a profile directory. Without `profile`, serpcast creates a private temporary one (`serpcast-profile-*` in the OS temp directory, mode 0700) when the browser first starts, and deletes it on `close()` and, synchronously, when the process exits. This is the one disk write serpcast makes itself ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)). A process killed by a signal it does not handle runs no exit handler, so call `close()` on shutdown (for example on `SIGTERM`).
- The search is bounded by the recipe's own `timeoutMs` inside searchcast; aborting `signal` rejects at once with its reason (the tab finishes in the background).

**Endpoint mode**: serpcast calls a running `searchcast serve` over HTTP or its Unix socket (`GET /search?recipe=<recipe>&q=<query>`):

```ts
const engines = [
	web,
	{name: 'web-browser', searchcast: {endpoint: '/run/searchcast/searchcast.sock', recipe: 'web'}},
	// or {endpoint: 'http://127.0.0.1:8931'}
];
```

`endpoint` is an `http://` (or `https://`) URL or an absolute Unix socket path; `recipe` is the recipe's name on that server (default: the engine's `name`); `timeoutMs` bounds the whole request (default 30 s, twice a recipe's default, to leave room for a cold browser start); `maxBodyBytes` is the largest answer accepted (default 16 MiB; larger is a `transport` error). Both are per engine, and a value that is not a positive whole number makes the engine fail with a `recipe` error (a misconfigured engine). **In endpoint mode serpcast cannot control the browser's egress**: the searchcast service uses its own `--proxy`, and serpcast's `proxy` does not apply to it (nor to the request to the endpoint, which goes straight to it). The caller must configure the service's egress to match.

**Errors.** searchcast answers both `blocked` and `recipe` with HTTP 502, so serpcast maps the answer's `error` field, not the status (in library mode, the thrown error's `code`):

| searchcast `error`                                         | serpcast kind |
| ---------------------------------------------------------- | ------------- |
| `blocked`, `recipe`, `timeout`                             | the same      |
| `input`, `unknown-recipe` (the engine is misconfigured)    | `recipe`      |
| `browser`, `internal`, `method`, `not-found`, anything else, a body that is not JSON | `transport` |

A well-formed answer's results are normalized as for declarative recipes (`snippet` from `content`, `snippet` or `description`; other string fields pass through); an answer without a results array, or with a result lacking `title` or `url`, is a `transport` error. An endpoint that cannot be reached is `transport`, one that does not answer in time is `timeout`.

## Installing libcurl-impersonate

serpcast needs the libcurl-impersonate shared library and never fetches it on its own ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)). Two ways to provide it:

**`serpcast install-libcurl`** downloads the pinned release, **libcurl-impersonate 2.1.1** ([lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate/releases/tag/v2.1.1)), for this platform, verifies its sha256 against the checksum pinned in serpcast's source (`LIBCURL_IMPERSONATE`), and installs the library as `libcurl-impersonate.so` (`.dylib`, `.dll`) in the data directory, where serpcast finds it with no further configuration:

```sh
serpcast install-libcurl [--proxy socks5h://127.0.0.1:9050] [--force]
```

- Pinned platforms: Linux x64 and arm64 (glibc), macOS x64 and arm64, Windows x64. Anywhere else (musl, FreeBSD), use your own build (below).
- It prints what it downloads from, the verified checksum and where it put the library on stderr, and the installed path alone on stdout.
- `--proxy` sends the download through your egress (`http://`, `socks5://`, `socks5h://`, as for the transport; `socks5h://` resolves host names at the proxy). Without it the connection is direct; proxy environment variables are ignored.
- A checksum mismatch, a failed download or an archive without the library aborts with exit 1 and installs nothing (the data directory is not even created). The library is written to a temporary file and renamed into place, so an interrupted install never leaves a partial library.
- If a library is already installed: an identical one is left alone (exit 0), a different one is kept and the command fails, unless `--force` replaces it.

**Your own build** (Nix, a distro package, the one your SearXNG uses): point serpcast at it with `SERPCAST_LIBCURL_PATH=/path/to/libcurl-impersonate.so` (or `--libcurl`, or the `libcurlPath` option); nothing is downloaded. For example with Nix (nixpkgs' `curl-impersonate` is 2.1.1 at the time of writing): `SERPCAST_LIBCURL_PATH=$(nix build --no-link --print-out-paths nixpkgs#curl-impersonate.out)/lib/libcurl-impersonate.so`. It must be libcurl-impersonate 2.1.1 or later (it has to accept the `chrome146` target); strict mode refuses anything else.

**`serpcast doctor`** reports which library serpcast would load, which setting named it, its version, and whether impersonation is active (exit 0) or not, and why (exit 1). It makes **no network request** unless you add `--remote`, which requests the fingerprint echo service `https://tls.browserleaks.com/json` once through the transport (and `--proxy`, if given) and prints the JA3, JA3N, JA4 and HTTP/2 (Akamai) values it saw. `--remote` is skipped when impersonation is not active.

```sh
$ serpcast doctor --remote
library:       /home/me/.local/share/serpcast/libcurl-impersonate.so
from:          the data directory (serpcast install-libcurl)
version:       libcurl/8.21.0-IMPERSONATE BoringSSL zlib/1.3.1 brotli/1.2.0 zstd/1.5.7 ...
pinned:        libcurl-impersonate 2.1.1
impersonation: active (chrome146)
echo:          https://tls.browserleaks.com/json
ja3:           3b488a06a6c1b27f8195b594c8f1e98a
ja3n:          8e19337e7524d2573be54efb2b0784c9
ja4:           t13d1516h2_8daaf6152771_d8a2da3f94cd
http2:         1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p
http2 hash:    52d84b11737d980aef856699f885ca86
```

Raw JA3 changes on every connection by design (Chrome permutes its TLS extensions); JA3N, JA4 and the HTTP/2 string are the stable values to compare.

## Installing recipes (`serpcast install-recipes`)

A recipe repository can publish its recipes as one release archive, and `serpcast install-recipes` installs the whole set in one explicit command. Like `install-libcurl`, it runs only when you type it ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)): serpcast never looks for recipes, updates them or loads them on its own.

```sh
serpcast install-recipes <url|path> --sha256 <hex> [--name <set>] [--dir <path>] [--proxy <url>] [--force]
serpcast recipes list [--dir <path>]
```

**`--sha256` is required, for a URL and a local file alike.** Code recipes are code with full Node access (see [Code recipes](#code-recipes)), so the pinned checksum is your trust decision: it says "exactly these bytes, which I have reviewed or whose publisher I trust". Get it from the publisher through a channel you trust, or compute it yourself (`sha256sum set.tar.gz`) after reviewing the archive. There is no way to install without one.

- The source is an `http://` or `https://` URL (downloaded with the same downloader as `install-libcurl`: through `--proxy` if given, with proxy environment variables ignored, no redirect from https to http, at most 16 MiB) or a path to a local file (`--proxy` is refused with a file, since it would not be used).
- The archive's sha256 is checked **before** anything is unpacked. It is unpacked in-process (no `tar` binary) and validated as a whole before anything is written (see the format below): one bad entry fails the install.
- The set goes into `<set>/` under the recipes directory, which is `recipes/` in the data directory (`$XDG_DATA_HOME/serpcast/recipes`, by default `~/.local/share/serpcast/recipes`), or `--dir`. The set's name is `--name` if given, else the `name` in the archive's `manifest.json`, else the command fails. Names are letters, digits, `.`, `_` and `-`, starting with a letter or digit.
- The set is written to a temporary directory beside its destination and renamed into place, so an interrupted install leaves the previous set or nothing, never a partial one. Beside the recipes it writes `.source.json`: the source given, the URL after redirects, the archive's sha256, the manifest's name and version, each file's sha256 and the install time.
- If a set with that name exists: an identical one (same files, same bytes) is left alone (exit 0); a different one is kept and the command fails, unless `--force` replaces it (the whole set: files the new archive lacks are removed).
- It prints what it downloads or reads, the verified checksum, and each installed file with its own sha256 on stderr, and the set's directory alone on stdout. A failure is `serpcast: <message>` on stderr, exit 1, and installs nothing; a missing `--sha256` is a usage error (exit 2).

`serpcast recipes list` shows each installed set: its directory, the manifest's name and version, the source and sha256 recorded at install, and its files with their sha256. It makes no network request.

To use an installed set, load its files yourself: `recipesDir(env?)` (exported from `serpcast`) returns the recipes directory, so `join(recipesDir(), 'my-set', 'web.json')` goes to `loadRecipeFile` and `join(recipesDir(), 'my-set', 'api.mjs')` to `loadCodeRecipe`. Which files are engines is up to you (a set may hold helper modules, and it holds its `manifest.json`).

### Release archive format

What a recipe repository's release asset must be:

- A gzipped tar (`.tar.gz`) of at most 16 MiB (64 MiB unpacked).
- Only regular files named `*.mjs`, `*.js` or `*.json`: declarative recipes, code recipes and modules they import. Prefer `.mjs` for code, since the installed set has no `package.json` to say `.js` is ESM.
- All files at the archive's root, or all under one top-level directory (such as `my-set-1.2.0/`), with no deeper directories. Directory entries for the root and that one directory are fine.
- Optionally a `manifest.json` `{"name": "my-set", "version": "1.2.0"}`: `name` is the default set name, and both are shown by `recipes list`. It is installed with the set.
- Nothing else. Absolute paths, `..`, symlinks and hard links, device files, hidden files (a leading `.`, which includes macOS `._*` files and the reserved `.source.json`), nested directories, other file types or the same file twice each fail the whole install, naming the entry.

For example, from a directory holding the recipes: `tar czf my-set-1.2.0.tar.gz my-set/` (GNU tar; on macOS set `COPYFILE_DISABLE=1`), or `git archive --format=tar.gz --prefix=my-set/ -o my-set-1.2.0.tar.gz HEAD:recipes` for a `recipes/` folder of a git repository. GitHub's automatic "Source code" archives hold the whole repository (README, license, ...) and are refused: publish a dedicated asset, and its sha256 with it.

**A private GitHub release asset needs authentication**, which `install-recipes` does not do (it sends no credentials). Download it with the GitHub CLI and install the file:

```sh
gh release download v1.2.0 --repo owner/recipes --pattern 'my-set-1.2.0.tar.gz'
serpcast install-recipes ./my-set-1.2.0.tar.gz --sha256 <hex>
```

## Install API for embedders (`serpcast/install`)

An application that embeds serpcast (webveil, for example) can offer serpcast's install steps itself, so its users install one thing. The installers and reports behind the CLI are exported from a **separate entry**, `serpcast/install`, never from `serpcast`: importing `serpcast` reaches no download code (a test walks its imports), and nothing is downloaded unless your code calls an installer ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)).

```ts
import {doctor, healthy, installLibcurl, installRecipes, listRecipeSets, recipesDir} from 'serpcast/install';

if (!healthy(await doctor())) await installLibcurl({proxy: 'socks5h://127.0.0.1:9050'});
await installRecipes('https://example.com/my-set-1.2.0.tar.gz', {sha256: '<hex>', proxy: 'socks5h://127.0.0.1:9050'});
console.log(listRecipeSets(recipesDir()));
```

| export | what it is |
| ------ | ---------- |
| `installLibcurl(options?)` | `serpcast install-libcurl`: resolves to `{path, url, status}` (`installed`, `replaced` or `unchanged`); options `proxy`, `force`, `env`, `log`, `maxArchiveBytes`, `maxUnpackedBytes`. |
| `installRecipes(source, options)` | `serpcast install-recipes`: resolves to `{name, dir, files, status}`; options `sha256` (required), `name`, `dir`, `proxy`, `force`, `env`, `log`, `maxArchiveBytes`, `maxUnpackedBytes`. |
| `listRecipeSets(base)`, `formatRecipeSets(base, sets)`, `recipesDir(env?)` | `serpcast recipes list`: the installed sets with their `.source.json` record, and the text the CLI prints. |
| `doctor(options?)`, `healthy(report)`, `formatReport(report, proxy?)` | `serpcast doctor`: the report (`{pinned, target, library?, impersonating, problem?, remote?}`), whether it is all good, and the text the CLI prints; options `libcurlPath`, `proxy`, `remote`, `env`. |
| `InstallError` | What a failed install rejects with; nothing was installed. |
| `LIBCURL_IMPERSONATE`, `dataDir(env?)`, `ECHO_URL` | The pinned release, serpcast's data directory, the echo service `remote` asks. |
| `MAX_LIBCURL_ARCHIVE_BYTES`, `MAX_LIBCURL_UNPACKED_BYTES`, `MAX_RECIPES_ARCHIVE_BYTES`, `MAX_RECIPES_UNPACKED_BYTES` | The installers' size caps (below). |

Everything the CLI guarantees holds here too, with no switch to turn it off: the pinned checksums (the libcurl release's, and the `sha256` you pass for recipes), the archive validation, and the caller's proxy as the only egress. The size caps are safety ceilings:

| option (both installers) | default and ceiling | meaning |
| ------------------------ | ------------------- | ------- |
| `maxArchiveBytes`        | 128 MiB (libcurl), 16 MiB (recipes) | Largest archive downloaded or read. |
| `maxUnpackedBytes`       | 512 MiB (libcurl), 64 MiB (recipes) | Largest archive once unpacked. |

A cap can be lowered, never raised: a value above the ceiling, or one that is not a positive whole number, rejects with a `RangeError` before anything is requested. An archive over a cap fails the install (`InstallError`) and installs nothing.

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

`install-libcurl`, `install-recipes`, `recipes list` and `doctor` use the same exit codes: `0` success, `1` a failed install (`serpcast: <message>` on stderr) or an unhealthy `doctor` report, `2` a usage error.

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
| `src/code.ts`        | 407 |    320 |
| `src/download.ts`    | 290 |    300 |
| `src/transport.ts`   | 680 |    300 |
| `src/libcurl.ts`     | 272 |    280 |
| `src/serpcast.ts`    | 454 |    260 |
| `src/browser.ts`     | 235 |    250 |
| `src/declarative.ts` | 197 |    220 |
| `src/install.ts`     | 174 |    180 |
| `src/install-recipes.ts` | 261 |    250 |
| `src/recipe-archive.ts` | 124 |    130 |
| `src/recipes.ts`     |  96 |    100 |
| `src/tar.ts`         |  53 |     60 |
| `src/cookies.ts`     | 245 |    170 |
| `src/post.ts`        | 148 |    160 |
| `src/searchcast-endpoint.ts` | 178 |    170 |
| `src/doctor.ts`      | 153 |    170 |
| `src/cli.ts`         | 179 |    180 |
| `src/html.ts`        | 126 |    150 |
| `src/chrome.ts`      | 361 |    150 |
| `src/index.ts`       | 141 |    120 |
| `src/response.ts`    |  98 |    120 |
| `src/store.ts`       |  63 |     80 |
| `src/errors.ts`      |  36 |     40 |
| `src/decoy.ts`       | 110 |    120 |
| `src/options.ts`     |  67 |     80 |
| `src/install-api.ts` |  41 |     60 |

**Total own source: 5237 LOC** (`packages/serpcast/src`) (excluding deps).

## Develop

```sh
pnpm install
pnpm format:check
pnpm build
pnpm test
```

`pnpm format:check && pnpm build && pnpm test` is the verify gate (`dorfl.json`) and what CI runs on every push and pull request. Tests run against the built packages, so build before testing.

The transport tests that need the native library run only when `SERPCAST_LIBCURL_PATH` points at a libcurl-impersonate shared library (and the plain-libcurl strict-mode tests only when `SERPCAST_TEST_PLAIN_LIBCURL` points at a plain libcurl); otherwise they are skipped with a message. CI installs the pinned release with `serpcast install-libcurl` itself (into a temporary data directory, checksum verified) and sets both, so they always run there.

## Release

Both packages are released with [changesets](https://github.com/changesets/changesets), each with its own version. A PR that should ship adds a changeset (`pnpm changeset`, pick the packages and the bump). On main, the `release` workflow (`.github/workflows/release.yml`) opens or updates a "Version Packages" PR from the pending changesets; merging it publishes the bumped packages to npm through npm Trusted Publishing (OIDC, no token), with provenance. The published `serpcast` package carries this README and the AGPL `LICENSE`, copied in at pack time by `scripts/copy-publish-assets.mjs`; `serpcast-recipe` ships its own README and MIT `LICENSE`.

## License

`serpcast` is licensed under the GNU Affero General Public License v3.0 only (see [`LICENSE`](LICENSE)). `serpcast-recipe` is licensed under the MIT License (see [`packages/serpcast-recipe/LICENSE`](packages/serpcast-recipe/LICENSE)).
