---
title: Fix the unhandled rejection when a declarative recipe is aborted between redirect hops
slug: declarative-abort-unhandled-rejection
spec: serpcast
blockedBy: []
covers: []
---

## What to build

In `packages/serpcast/src/declarative.ts`, `abortable(promise, signal)` rejects at once when `signal` is already aborted and never attaches a handler to `promise`. The session's `request()` then rejects too (the real transport calls `signal.throwIfAborted()`), and that rejection is unhandled, which crashes a Node process by default. It happens when the caller aborts, or the recipe's own timeout fires, between two redirect hops. Found while building `engine-chain-and-state` (observation `declarative-abortable-unhandled-rejection.md`, which this task resolves and deletes). `code.ts` already has a correct helper, `untilAborted`, which attaches the handlers before the early return; the declarative runner should use it (or an equivalent shared helper) instead of its own `abortable`.

## Acceptance criteria

- [ ] A regression test aborts (and separately lets the recipe timeout fire) between two redirect hops, with a fake session whose `request()` rejects when given an aborted signal, and asserts no unhandled rejection occurs (for example with a `process.on('unhandledRejection')` spy or vitest's unhandled-error detection) and that the call rejects with the signal's reason or a `timeout` error as before.
- [ ] The test fails on the current code and passes after the fix.
- [ ] There is one abort helper for the runners, not two copies.
- [ ] The observation note `work/notes/observations/declarative-abortable-unhandled-rejection.md` is deleted.
- [ ] Existing tests pass unchanged in meaning.

## Blocked by

- None, can start immediately.

## Prompt

Goal: a caller's abort or a recipe timeout must never crash the process. Keep the change small. FIRST, check this task against current reality (launch snapshot; may have drifted). RECORD non-obvious in-scope decisions.

## Decisions

- **Where the shared helper lives:** `declarative.ts` imports `untilAborted` from `./code.js`, the same way `browser.ts` already does. The alternative was moving it into a new shared module such as `src/abort.ts`, which is cleaner but touches three files for no change in behaviour. This doesn't create a circular import, because `code.ts` only imports a type from `declarative.ts`. Only the runner modules are affected.
