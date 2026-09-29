---
title: `serpcast install-recipes`: install a set of recipes from a release archive (URL or file), checksum-pinned
slug: install-recipes-command
spec: serpcast
blockedBy: [post-requests]
covers: []
---

## What to build

Owner request (2026-09-29): installing recipes should be one explicit command pointing at a release file (for example a recipe repository's GitHub release asset), even for a whole set. Like `install-libcurl`, it runs only when the user types it (ADR 0002: no hidden network), and because code recipes are code with full Node access, what gets installed must be exactly what the user decided to trust.

- `serpcast install-recipes <url|path> --sha256 <hex> [--name <set>] [--dir <path>] [--proxy <url>] [--force]`: download (through `--proxy` only, reusing `install-libcurl`'s downloader: proxy env ignored, https-to-http redirects refused, size caps) or read the local file; verify its sha256 BEFORE unpacking (`--sha256` is required, for URLs and files alike: a pin is the trust decision; say so in the help and README); unpack in-process (reuse the tar reader; `.tar.gz`) only regular files named `*.mjs`, `*.js` or `*.json`, at the archive root or under one top-level directory, refusing absolute paths, `..`, links and anything else loudly; install atomically (a temp dir renamed into place) into `$XDG_DATA_HOME/serpcast/recipes/<set>/` (default `<set>` from an optional `manifest.json` `{name, version}` in the archive, else `--name`, else refuse); a differing existing set is refused without `--force`; print what was installed (each file and its own sha256) and where.
- `serpcast recipes list`: installed sets, their files, manifest name/version, and the source URL and sha256 recorded at install (a small `.source.json` written by install).
- Export `recipesDir(env?)` (the base directory) so callers such as webveil can find installed sets.
- Document the archive format in the README (what a recipe repository's release must contain), and that a private GitHub release asset needs auth: download it with `gh release download` and install the file.

## Acceptance criteria

- [ ] Checksum mismatch, missing `--sha256`, a path-traversal or link entry, a non-recipe file type, and an existing differing set without `--force` each fail loudly and leave nothing installed (tested; local release server for the URL path, as `install-libcurl`'s tests do).
- [ ] A valid archive (with and without a top-level directory, with and without `manifest.json`) installs atomically; `recipes list` shows it; tests isolate `XDG_DATA_HOME` in a temp dir and assert the real one is untouched.
- [ ] The only network code path is the explicit command (extend the existing "only download path" test).
- [ ] README (CLI section, archive format), changeset (minor).

## Blocked by

- post-requests (serialized: both edit the CLI and README)

## Prompt

Read `packages/serpcast/src/install.ts` and `download.ts` and reuse them. FIRST, check this task against current reality. RECORD non-obvious decisions.
