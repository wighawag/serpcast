---
'serpcast': minor
---

`serpcast install-recipes <url|path> --sha256 <hex> [--name <set>] [--dir <path>] [--proxy <url>] [--force]` installs a set of recipes from a `.tar.gz` release archive, only when typed. `--sha256` is required for URLs and files alike (recipes are code: the pin is the trust decision) and is checked before anything is unpacked. URLs are downloaded with `install-libcurl`'s downloader (`--proxy` only, proxy environment ignored). The archive may hold only regular `*.mjs`, `*.js` and `*.json` files, at its root or under one top-level directory, with an optional `manifest.json` `{name, version}`; anything else fails the install, which then writes nothing. The set is installed atomically into `$XDG_DATA_HOME/serpcast/recipes/<set>/` with a `.source.json` recording its origin; a differing set is replaced only with `--force`. `serpcast recipes list` shows the installed sets, and the new export `recipesDir(env?)` returns their base directory.
