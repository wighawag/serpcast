# serpcast

## 0.1.1

### Patch Changes

- 723cbe5: Fix: `process.exit()` no longer hangs while a request is in flight or right after an abort. The transport now drives libcurl through its multi interface on the main thread instead of running `curl_easy_perform` on a worker thread, whose JS callbacks deadlocked process exit.

## 0.1.0

### Minor Changes

- 03e9f7f: First release. `serpcast-recipe`: the shared recipe schema, its types and its validator. `serpcast`: the transport (libcurl-impersonate), the declarative and code recipe runners, browser engines (searchcast), the engine chain with its state store, and the CLI (`query`, `install-libcurl`, `doctor`).

### Patch Changes

- Updated dependencies [03e9f7f]
  - serpcast-recipe@0.1.0
