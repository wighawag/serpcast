---
title: `serpcast install-libcurl` (pinned, checksummed, explicit) and `serpcast doctor` (fingerprint report)
slug: libcurl-install-and-doctor
spec: serpcast
blockedBy: [searchcast-engine]
covers: [7, 8]
---

## What to build

Two explicit, user-invoked CLI commands. `serpcast install-libcurl` downloads the pinned libcurl-impersonate release for the current platform (Linux x64/arm64 and macOS at minimum), verifies it against a checksum pinned in the source, and installs the shared library into serpcast's data directory (`$XDG_DATA_HOME/serpcast/`, default `~/.local/share/serpcast/`), where the transport finds it. It accepts `--proxy` so the download can go through the user's egress, prints what it downloaded from and where it put it, and refuses to overwrite a differing file without `--force`. `serpcast doctor` reports which library was loaded and from where, whether impersonation is active and the target, and, only with `--remote`, requests a fingerprint echo service through the transport (and `--proxy` if given) and prints the JA3/JA4/HTTP2 values it saw.

## Acceptance criteria

- [ ] The install command is the only code in serpcast that downloads the library, and it runs only when invoked.
- [ ] A checksum mismatch aborts with an error and leaves nothing installed.
- [ ] After install, `serpcast query` works with no path configured.
- [ ] `doctor` without `--remote` makes no network request.
- [ ] README documents both commands, the pinned version, and the Nix/distro alternative (point `SERPCAST_LIBCURL_PATH` at your own libcurl-impersonate).
- [ ] Tests isolate the data dir in a temp dir (download mocked via a local server) and assert the real data dir is untouched.

## Blocked by

- searchcast-engine (serialized: every earlier task edits the CLI or the README, and the runner never auto-resolves conflicts)

## Prompt

Goal: make installing the native library one explicit command, never a side effect (ADR 0002). Use the pinned version and checksums constant the `impersonated-transport` task defined (the one CI uses); extend it if a platform is missing, never duplicate it. Record where the checksums came from.

FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.
