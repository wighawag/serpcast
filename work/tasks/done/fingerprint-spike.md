---
title: Spike, does impers reproduce curl_cffi's Chrome fingerprint with only our headers and no runtime download
slug: fingerprint-spike
spec: serpcast
blockedBy: [scaffold-monorepo]
covers: []
---

## What to build

A measured answer, recorded as a finding, to three questions the transport depends on:

1. With `impers` loading libcurl-impersonate **2.1.1** (the version SearXNG's closure uses, for example from nixpkgs `curl-impersonate`, or the lexiforest release) and the pinned target `chrome146`, are the TLS fingerprint (JA3 and JA4), the HTTP/2 fingerprint (Akamai string) and the header order seen by a fingerprint echo service (for example `https://tls.peet.ws/api/all`) identical to curl_cffi's with the same target and the same headers?
2. Can impers be made to send ONLY a caller-supplied header set (the equivalent of curl_cffi's `default_headers=False`), in the caller's order, for each request kind (document navigation, fetch/XHR, script)?
3. Can impers's first-launch download of libcurl-impersonate be fully prevented (explicit `LIBCURL_PATH` set before import, or another supported switch), and does it fail loud or silently fall back to plain libcurl when the library is missing or is not the impersonate build?

Keep any spike code under a scratch directory that is not part of the published packages (or delete it after recording). The deliverable is the finding (including any recommended change of approach for the transport).

> FORWARD-NOTE (conductor, 2026-09-28, build-host environment): from this build host `https://tls.peet.ws/api/all` timed out (20 s connect timeout, twice); `https://tls.browserleaks.com/json` answered and returns `ja4`, `ja4_r`, `ja3`/`ja3_hash` and `akamai`/`akamai_hash` fields. Prefer browserleaks (or try peet once with a short timeout, then fall back) and record which service was used in the finding. libcurl-impersonate 2.1.1 is already present locally at `/nix/store/0djkdm67a5jj9vl7hs8cj5cib64mxxqc-curl-impersonate-2.1.1/lib/libcurl-impersonate.so` (nixpkgs build), usable as the explicit library path for impers. Still no search engine may be contacted.

## Acceptance criteria

- [ ] `work/notes/findings/impers-fingerprint-vs-curl-cffi.md` exists with a `source:` stating what was measured, with which versions (impers, libcurl-impersonate, curl_cffi) and the date.
- [ ] It records the JA3, JA4, Akamai HTTP/2 string and observed header order for both clients, and states plainly whether they match.
- [ ] It answers questions 2 and 3 with the exact mechanism (option names, env vars) or states that impers cannot do it.
- [ ] If impers cannot meet any of the three, the finding says so and recommends the fallback (a direct koffi binding to libcurl-impersonate, see ADR 0001). Do not edit other task files; `impersonated-transport` reads this finding first.
- [ ] `verify` still passes (spike code does not break the gate).

## Blocked by

- scaffold-monorepo

## Prompt

Goal: prove or disprove that serpcast can have exactly SearXNG's fingerprint from Node before the transport is built on it (ADR 0001). Read `impers`' README and source (github.com/lexiforest/impers) for its header, target and library-loading behaviour. curl_cffi can be run from a throwaway Python venv (`pip install curl_cffi`); pin its libcurl-impersonate to the same version you give impers if possible, otherwise record the difference. Bound every exploratory command with a timeout and cap output. This task needs live network to reach the echo service; it does not touch any search engine.

For reference only (do not copy the code), a private deployment builds a coherent Chrome 146 on Linux identity with curl_cffi: impersonate `chrome146`, curl_cffi's default headers off, and per request kind the exact header set Chromium sends (`sec-ch-ua` with `"Chromium";v="146"`, `sec-ch-ua-platform: "Linux"`, `sec-fetch-*`, `priority`, `accept` values per kind). Build your header tables from Chromium's real behaviour and state the source.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD what you measured durably in the finding.
