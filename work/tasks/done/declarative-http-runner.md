---
title: Run a declarative recipe over the impersonated transport, plus `serpcast query --recipe` for recipe development
slug: declarative-http-runner
spec: serpcast
blockedBy: [recipe-schema-package, impersonated-transport]
covers: [10, 11, 12, 13, 22]
---

## What to build

Running one declarative recipe over HTTP, end to end: build the URL from `navigate.url` (`{query}` URL-encoded), request it as a document navigation through the transport, follow redirects, then decide in this order: HTTP 202/403/429 or a `blockedUrl` match on the final URL or a `blocked` selector match means `blocked`; an `empty` selector match means an empty result list; the `ready` selector present means read results; none of these means a `recipe` error (the page does not match the recipe). If `ready` matched but no item yields both `title` and `url`, that is also a `recipe` error, never an empty list. Other non-2xx statuses: 404 and 410 are `recipe` errors (the URL template is wrong), everything else (5xx and remaining codes) is a `transport` error; the status code is in the message. Results are read with the recipe's `results.item` and `fields` (visible text by default, `href`/`src` resolved to absolute URLs against the final URL), items missing `title` or `url` are skipped, extra fields pass through, and the list is cut to `limit`. Normalized output is `{title, url, snippet?}` (snippet from a `content` field, then `snippet`, then `description`) plus the recipe name. A recipe that needs a browser (`form`) is rejected up front with a `recipe` error that says to run it through searchcast. The whole call respects `timeoutMs` and the caller's abort signal. No JavaScript from the page is executed.

The CLI gains `serpcast query --recipe <file> [--proxy <url>] [--libcurl <path>] "<query>"`: prints the results as JSON, or the typed error on stderr with a non-zero exit code.

## Acceptance criteria

- [ ] Against a local test server serving HTML fixtures: results parsed; relative URLs resolved; items missing title/url skipped; `limit` honoured; `empty` returns `[]`; `blocked` selector, `blockedUrl` after a redirect, and 202/403/429 each return a `blocked` error; a page matching nothing returns a `recipe` error; `ready` matched with no usable item returns a `recipe` error; 404 returns `recipe` and 503 returns `transport`; a slow page returns `timeout`.
- [ ] A `form` recipe is rejected before any request.
- [ ] The runner is tested with an injected fake transport (so the parsing tests do not need the native library), plus at least one test through the real transport, skipped locally when the library is absent.
- [ ] HTML parsing uses a small parser and CSS selector engine (choose the smallest that supports the selectors real recipes use; record the choice and its size).
- [ ] `serpcast query` works as described; its exit codes and output shape are documented in the README.
- [ ] Tests cover the new behaviour.

## Blocked by

- recipe-schema-package
- impersonated-transport

## Prompt

Goal: the "light end" of the spec: the same recipe searchcast runs in a browser, run over plain HTTP with a browser fingerprint. Match searchcast's semantics (its `src/searchcast.ts`; get the searchcast sources: the `searchcast@0.1.1` npm tarball ships `src/` (`npm pack searchcast@0.1.1` into a scratch dir), and the tests and README are on GitHub at https://github.com/wighawag/searchcast: ready/empty/blocked handling, field reading, URL resolution) so a recipe behaves the same in both runners, except that no script runs here. Never report a failure as an empty list: an empty list only comes from the `empty` selector. One deliberate difference from searchcast: where searchcast keeps polling a live page and ends in `timeout` (nothing matched, or `ready` matched with no usable item), this runner answers `recipe` at once, because a static HTML response will not change. Say so in the README.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
