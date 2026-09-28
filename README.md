# serpcast

Keyless search engines over HTTP with a real browser's fingerprint, driven by recipes shared with [searchcast](https://github.com/wighawag/searchcast).

Getting keyless web search results today usually means running SearXNG. What SearXNG really contributes is small: engine adapters that turn a results page into title/url/snippet, an HTTP client that looks like a real browser at the TLS and HTTP/2 level (curl_cffi over libcurl-impersonate), and per-engine handling of challenges and failures. serpcast is that, as a Node library plus a small CLI:

- Engines are described by **recipes**. A declarative recipe is the same JSON file searchcast runs in a real browser; serpcast runs it over plain HTTP. A code recipe is a JS module for sites that need challenge handling or a non-HTML API.
- All engine traffic goes through **libcurl-impersonate**, pinned to one explicit Chrome version, with the exact header set that Chrome sends for each kind of request, so the TLS side and the header side describe the same browser ([ADR 0001](docs/adr/0001-browser-fingerprint-via-libcurl-impersonate.md)).
- Engines are tried as an ordered **engine chain**, first answer wins, with searchcast (a real browser) as the fallback when HTTP is blocked.
- serpcast is **not** an anonymity tool, and it is built so one can use it safely: the caller injects the proxy, the state store and the recipe set; serpcast makes no network call the caller did not cause and writes nothing to disk on its own ([ADR 0002](docs/adr/0002-policy-free-caller-injects-egress-state-recipes.md)).

Status: scaffold. The packages below are published at `0.0.0` as name placeholders; the functionality lands task by task (see `work/tasks/`).

## Packages

serpcast is a pnpm workspace monorepo with two packages:

- **[`serpcast-recipe`](packages/serpcast-recipe)** (MIT, zero dependencies): the recipe schema, its TypeScript types and its validator. Shared by serpcast and searchcast so one recipe file describes a site for both. MIT so projects under any license can share the format ([ADR 0003](docs/adr/0003-shared-recipe-schema-mit-package.md)).
- **[`serpcast`](packages/serpcast)** (AGPL-3.0-only): the library (transport, recipe runners, engine chain) and the `serpcast` CLI for recipe development. Depends on `serpcast-recipe` via `workspace:*`.

## Size discipline (per-module LOC)

Every module stays small with one responsibility. Per-module LOC is tracked here as a first-class quality signal. `target` is a rough ceiling (a ceiling, not a promise); `LOC` is the actual line count of the source file. Each task that adds or grows a module updates its row.

### `packages/serpcast-recipe` (shared recipe schema)

| module | LOC | target |
| ------ | --: | -----: |

### `packages/serpcast` (library + CLI)

| module | LOC | target |
| ------ | --: | -----: |

**Total own source: 0 LOC** (placeholders excluded, excluding deps).

## Develop

```sh
pnpm install
pnpm format:check
pnpm build
pnpm test
```

`pnpm format:check && pnpm build && pnpm test` is the verify gate (`dorfl.json`) and what CI runs on every push and pull request. Tests run against the built packages, so build before testing.

## License

`serpcast` is licensed under the GNU Affero General Public License v3.0 only (see [`LICENSE`](LICENSE)). `serpcast-recipe` is licensed under the MIT License (see [`packages/serpcast-recipe/LICENSE`](packages/serpcast-recipe/LICENSE)).
