---
title: Reuse connections within a transport session (keep-alive, like Chrome)
slug: session-connection-reuse
spec: serpcast
blockedBy: []
covers: []
needsAnswers: true
---

## What to build

Today every transport request is its own easy handle in its own multi handle (`impersonated-transport` decision 18, kept by `transport-no-deadlock-on-process-exit`), so every request opens a new TCP connection and a new TLS handshake. Measured 2026-09-29 (my-boxes finding `search-engine-gatekeeping-by-egress-class`, section "serpcast vs a naive Node client"): through Tor serpcast's median latency was 2.4 s against 1.0 s for Node's keep-alive fetch on the same DuckDuckGo flow, and 1.4 s vs 0.6 s on Bing; the difference is the per-request circuit TCP + TLS setup. Real Chrome reuses one HTTP/2 connection per origin, so reuse also makes the traffic more like the browser it impersonates.

Make a `TransportSession` reuse connections across its own requests: one long-lived multi handle (and libcurl connection cache) per session, with a fresh easy handle per request added to it, or a reused easy handle per session reset between requests, whichever keeps the fingerprint exact. Requirements:

- Connections are shared ONLY within one session, never across sessions (sessions are identities: an engine's cookies; two engines or two callers must not share a connection, which would link them at the TLS/IP layer). Record this as a decision.
- HTTP/2 multiplexing on a reused connection must keep the exact header tables and the HEADERS PRIORITY flag (the existing tests must pass unchanged, plus one that makes two requests on one session and asserts the second reused the connection: for example the local test server sees one TLS connection, or `CURLINFO_NUM_CONNECTS` is 0 on the second).
- Proxies keep working (http CONNECT, socks5h, socks5), with reuse through the same proxy connection where libcurl does it.
- The session gains a way to release its connections (`close()` or similar) and the engine chain closes each engine's session connections when the session is dropped (idle expiry, `clearSessions`, `close()`); an idle connection must not keep the process alive (no leaked handle keeps Node's event loop running after `Serpcast.close()`), and `process.exit()` must still not deadlock (the existing exit tests pass).
- Keep all libcurl calls on the main thread (the no-deadlock design).

> RETRY HANDOFF (conductor, 2026-09-29): the first build (kept branch `work/task-session-connection-reuse`) went red on its OWN new test only: `test/serpcast-connections.test.ts` > "gives a concurrent search on the same engine its own session, closed after" fails at line 173, `expect(sessions).toHaveLength(2)` got 3: after the concurrent search's extra session is closed, the next search on engine `a` created a NEW session instead of reusing the kept one. Decide which behaviour is right (reusing the engine's kept session is the expected one: sessions are per engine and should survive between searches until idle expiry), fix the code or the test accordingly, record why, and rerun the whole suite. Everything else was green (222 passed).

## Acceptance criteria

- [ ] Two requests on one session to the same origin reuse one connection (asserted); two sessions never share one (asserted).
- [ ] All existing transport, chain and exit tests pass unchanged (headers, PRIORITY flag, proxies, cookies, timeout, abort, size cap, strict, exit).
- [ ] Sessions release their connections when dropped; `Serpcast.close()` leaves nothing that keeps the process alive (tested with a child process that must exit on its own).
- [ ] A measurement recorded in the done record: sequential requests on one session to a local TLS server, and (optional, one manual run) through a local SOCKS proxy, before vs after.
- [ ] A changeset (patch or minor, recorded).

## Blocked by

- None, can start immediately.

## Prompt

Read `packages/serpcast/src/transport.ts` (the `drive` loop and why it runs on the main thread) and libcurl's connection-reuse docs for the multi interface. FIRST, check this task against current reality. RECORD non-obvious decisions.
