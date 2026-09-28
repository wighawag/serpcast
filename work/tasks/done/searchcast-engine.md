---
title: Browser engine kind, delegate a recipe to searchcast (library or socket) as the chain's fallback
slug: searchcast-engine
spec: serpcast
blockedBy: [code-recipes]
covers: [18, 19]
---

## What to build

A third engine kind that runs a recipe through searchcast (a real browser). Two modes: **library**, where serpcast imports `searchcast` (an optional peer dependency, loaded only when this mode is used), starts it lazily with the caller's options (chrome path, xvfb, headless, and an optional profile directory) and passes serpcast's proxy as searchcast's proxy; and **endpoint**, where serpcast calls a running `searchcast serve` over HTTP or a Unix socket (`/search?recipe=&q=`). Errors are mapped from the response body's `error` field, not the status (searchcast answers both `blocked` and `recipe` with 502): `blocked`, `recipe` and `timeout` map to the same kinds; `browser`, `internal`, `method`, `not-found` and a non-JSON body become `transport`; `input` and `unknown-recipe` become `recipe` (the engine is misconfigured). In library mode the thrown searchcast error's `code` is mapped the same way. For the proxy, Chromium resolves DNS at a SOCKS5 proxy by default, and may not accept the `socks5h` scheme: verify this, and translate `socks5h://` to the scheme Chromium accepts while keeping remote DNS; record the result. The engine joins the chain like the others, so the usual configuration is HTTP engines first and the browser last. `close()` stops a library-mode browser. searchcast's library requires a profile directory (`userDataDir`); when the caller gives none, serpcast creates a temporary one with `mkdtemp` (mode 0700) and deletes it on `close()` and, synchronously, on process exit. This is the one disk write serpcast makes itself (ADR 0002).

## Acceptance criteria

- [ ] Endpoint mode is tested against a fake searchcast HTTP server and a fake Unix-socket server: results mapped, and each `error` code in the table above mapped (including `blocked` vs `recipe`, which share a status).
- [ ] A `socks5h://` proxy reaches Chromium in a form that keeps DNS at the proxy (tested on the translated argument).
- [ ] Library mode is tested with an injected fake searchcast module: proxy passed through, lazy start, stopped on `close()`.
- [ ] With no profile directory given, a temporary 0700 directory is created and is gone after `close()` (and after process exit, tested in a child process).
- [ ] Without searchcast installed, library mode fails with a clear error naming the package to install; nothing else in serpcast imports it.
- [ ] README documents both modes and notes that in endpoint mode serpcast cannot control the browser's egress (the caller must).
- [ ] Tests cover the new behaviour.

## Blocked by

- code-recipes (serialized: both extend the engine kinds)

## Prompt

Goal: the heavy fallback, a real browser has the real fingerprint. Read searchcast's README (HTTP API, error table, library usage), `src/server.ts` and `src/searchcast.ts` (get the searchcast sources: the `searchcast@0.1.1` npm tarball ships `src/` (`npm pack searchcast@0.1.1` into a scratch dir), and the tests and README are on GitHub at https://github.com/wighawag/searchcast). Keep searchcast optional: most users of HTTP engines never install Chromium.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
