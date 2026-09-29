---
title: The transport must not deadlock process.exit() while a request is in flight
slug: transport-no-deadlock-on-process-exit
spec: serpcast
blockedBy: []
covers: []
---

## What to build

A severe bug found in live testing of webveil 0.5.0 (2026-09-29, NixOS, Node 24.19.0, serpcast 0.1.0, libcurl-impersonate 2.1.1 installed by `serpcast install-libcurl`). Calling `process.exit()` while a transport request is in flight hangs the process forever: the main thread sits in `futex_do_wait` and never returns. The transport runs `curl_easy_perform` through koffi's `.async` on a libuv worker thread and registers JS callbacks (`CURLOPT_WRITEFUNCTION`, `CURLOPT_HEADERFUNCTION`, `CURLOPT_XFERINFOFUNCTION`) that libcurl calls from that worker; koffi marshals each call to the main thread and blocks the worker until it runs, while process exit waits for the thread pool. Deadlock. Minimal reproduction (both hang until killed; a TCP server that accepts and never answers on 127.0.0.1:18999):

```js
import {createTransport} from 'serpcast';
const t = createTransport({timeoutMs: 20000});
t.session().request('http://127.0.0.1:18999/', {kind: 'document'}).catch(() => {});
setTimeout(() => process.exit(1), 1500); // never exits
```

The same happens after an abort: the request's promise has rejected, but the worker is still inside `curl_easy_perform` until its next progress callback, which itself needs the main thread. Real impact: webveil's CLI (incur calls `process.exit` on a failed command) hangs forever after any failed or timed-out serpcast search, and any library user that exits during a search does the same.

Fix it so that no JS callback is ever invoked from a non-main thread while `process.exit` can be waiting. The expected direction is to stop running `curl_easy_perform` on the thread pool: drive the request with libcurl's multi interface from the main thread (`curl_multi_add_handle`, then a non-blocking `curl_multi_perform` / `curl_multi_poll` with a zero timeout, re-armed with timers or `setImmediate` while the transfer is active), so the write/header/progress callbacks run synchronously on the main thread and nothing is left in native code between event-loop turns. Keep the per-request timeout, the abort signal, the body size cap and the error kinds exactly as today; keep the idle CPU cost reasonable (record the polling interval chosen and the measured CPU for an idle in-flight request). An equivalent design is fine if it removes the deadlock for good; record it. Keep `RTLD_DEEPBIND` loading and the `RTLD_NODELETE` pin as they are.

## Acceptance criteria

- [ ] A test spawns a child process that starts a request to a never-answering local server and calls `process.exit(1)` 1 s later; the child exits within 5 s (today it hangs). A second test does the same right after an abort. They are native tests (CI with the pinned library, skipped locally without it, like the other native tests).
- [ ] All existing transport tests pass unchanged: exact header tables, HTTP/2 PRIORITY flag, proxies (http, socks5h, socks5), cookies, timeout, abort, size cap, strict check.
- [ ] Several concurrent requests in one process still work (tested), and an idle in-flight request does not busy-loop (record the measurement).
- [ ] A changeset (patch) for `serpcast`.

## Blocked by

- None, can start immediately.

## Prompt

Goal: a serpcast request must never be able to hang its process. Read `packages/serpcast/src/transport.ts` and `libcurl.ts`, koffi's docs on callbacks and threads, and libcurl's multi interface docs. Reproduce first with the snippet above (the local library: `SERPCAST_LIBCURL_PATH` pointing at a libcurl-impersonate, for example one installed with `node packages/serpcast/dist/cli.js install-libcurl` into a temp `XDG_DATA_HOME`). FIRST, check this task against current reality. RECORD non-obvious decisions.
