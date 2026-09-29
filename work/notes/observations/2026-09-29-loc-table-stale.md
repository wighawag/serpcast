# README LOC table is stale (2026-09-29)

Noticed while doing `post-requests`: the "Size discipline (per-module LOC)" table in `README.md` no longer matches the sources (before that task, `src/transport.ts` was listed at 280 LOC with a 300 target but had 496 lines; `src/chrome.ts` 122 vs 252; `src/serpcast.ts` 243 vs 393; `src/libcurl.ts` 272 vs 313), and several modules are over their `target`. `post-requests` updated only the rows it touched; the rest needs a pass (and a decision on whether the targets still hold).
