# serpcast

serpcast runs keyless search engines, described by recipes, over HTTP with a real browser's fingerprint, and chains them with a real-browser fallback (searchcast). It supplies the mechanism; the caller supplies every policy (egress, state, which recipes), see `docs/adr/0002`.

## Language

### Recipes and engines

**Recipe**:
A description of how to get search results from one site. Either a declarative recipe or a code recipe.
_Avoid_: adapter, scraper, plugin

**Declarative recipe**:
A JSON recipe in the shared `serpcast-recipe` schema (URL template, ready/empty/blocked selectors, result fields). The same file runs over HTTP in serpcast and in a real browser in searchcast.
_Avoid_: JSON engine, config

**Code recipe**:
A JS module with a `{name, search(query, ctx)}` default export, loaded only from a path the caller gives, for sites that need challenge handling or a non-HTML API. It is code with full Node access, so loading one is a trust decision of the caller.
_Avoid_: custom engine, script recipe

**Engine**:
One entry in an engine chain: a declarative recipe, a code recipe or a browser engine, identified by its name.
_Avoid_: backend, provider

**Browser engine**:
A searchcast recipe run by searchcast in a real browser (in-process or over its socket). The fallback when HTTP is blocked.
_Avoid_: headless engine

**Engine chain**:
The ordered list of engines one search tries, stopping at the first answer (results, or an `empty` match); earlier failures are reported with it.
_Avoid_: fan-out, metasearch

### Transport and fingerprint

**Transport**:
The HTTP client every engine request goes through: libcurl-impersonate (through a direct koffi binding; `impers` was measured and not used, see the finding `impers-fingerprint-vs-curl-cffi`) sending the pinned impersonation target with our header table, through the caller's proxy.
_Avoid_: fetcher, HTTP backend

**Impersonation target**:
The one explicit Chrome version libcurl-impersonate reproduces at the TLS/HTTP2 level (for example `chrome146`), never the moving `chrome` alias. It and the header tables change together.
_Avoid_: profile, browser alias

**Header table**:
The exact request headers (names, values, order) that the pinned Chrome sends for one request kind. The only headers serpcast sends; the library's own defaults are off.
_Avoid_: default headers, user agent

**Request kind**:
What a request is, from the browser's point of view, which selects its header table: document navigation, same-origin navigation, fetch/XHR, or script.
_Avoid_: request type, mode

**Strict mode**:
The default check that refuses to send any request unless libcurl-impersonate is loaded and accepts the impersonation target.
_Avoid_: safe mode

### State

**State store**:
The caller-injected async key/value store with per-key expiry that holds sessions and cooldowns, namespaced per engine. The default is in-memory; serpcast ships no disk store.
_Avoid_: cache, database

**Session**:
One engine's cookies and arbitrary JSON state, kept in the state store and dropped after an idle time or when cleared explicitly.
_Avoid_: cookie jar, identity

**Transport session**:
The cookies that one engine's requests share, stored and sent by the transport itself (never libcurl's cookie engine) so the `cookie` header sits where Chrome puts it. It is the cookie half of a Session, exported as plain JSON so the state store can keep it.
_Avoid_: cookie jar, client

**Cooldown**:
The period during which an engine that answered `blocked` is skipped by the engine chain.
_Avoid_: backoff, ban

### Errors

Every failure is a `SerpcastError` with a `kind`. An empty result list is never an error and only comes from a recipe's `empty` selector.

**`blocked`**:
The site refused or challenged the request (HTTP 202/403/429, a `blocked` selector match, or a `blockedUrl` match after redirects). Starts a cooldown.

**`recipe`**:
The recipe does not fit the site or the runner (the page matches none of its selectors, no usable result item, a wrong URL template, a browser-only feature over HTTP, malformed code-recipe output).

**`timeout`**:
The request or search did not finish within its time limit.

**`transport`**:
The network or the server failed (connection error, unexpected status such as 5xx).

**`impersonation`**:
The browser fingerprint cannot be guaranteed (libcurl-impersonate missing, plain libcurl, unknown target). It aborts the whole search rather than falling through to later engines.

**`exhausted`**:
Every engine in the chain failed; carries the failure of each engine tried.
