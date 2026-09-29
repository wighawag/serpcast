---
title: Code recipes can set a cookie in their session, like a page's `document.cookie`
slug: recipe-set-cookie
spec: serpcast
blockedBy: []
covers: []
---

## What to build

Some sites set a cookie from their page's JavaScript rather than with `Set-Cookie` (for example a token earned by answering a challenge, which the page then writes with `document.cookie`), and the next request must carry it. A code recipe has no way to do that today: `ctx` offers `http`, `session` (JSON state), `signal`, `maxResults`, `blocked`, `recipeError`; requests carry no caller headers; the `cookie` header is built only from the session's `CookieStore`, which the recipe cannot reach. A private recipe's build stopped on exactly this (2026-09-29).

Add `ctx.cookies.set(url, cookieString)` with `document.cookie` semantics: `cookieString` is what a script would assign (`name=value; Path=/; Secure; SameSite=...; Max-Age=...`), applied as if set by a page at `url` (host-only unless `Domain` is given and valid for that host, the same rules the store already applies to `Set-Cookie`, minus `HttpOnly`, which a script cannot set). Stored in the engine's transport session `CookieStore`, so it is sent exactly where Chrome would put it, persisted with the session like any other cookie, and dropped with it. Also `ctx.cookies.get(url)` (the `document.cookie` view: names and values the store would send to `url`, non-HttpOnly only) and `ctx.cookies.delete(url, name)`.

Cookie names containing characters such as `#` must survive storing and sending byte for byte (RFC 6265 token rules allow `#`; check the parser and serializer do not drop, encode or reject it, and test it), because the motivating site uses one.

## Acceptance criteria

- [ ] A recipe sets a cookie, the next `ctx.http` request to a matching URL carries it in the Chrome position; a non-matching URL does not; Secure/Path/Domain/Max-Age honoured; `HttpOnly` in the string is ignored (as for `document.cookie`); a name with `#` round-trips exactly (tested with the local server seeing the header).
- [ ] The cookie persists across searches through the state store and is dropped with the session (idle expiry, `clearSessions`).
- [ ] `get` and `delete` tested; README code-recipe context table and CONTEXT updated; changeset (minor).

## Blocked by

- None, can start immediately.

## Prompt

Read `packages/serpcast/src/cookies.ts` and `code.ts`. Keep the public repo engine-neutral. FIRST, check this task against current reality. RECORD non-obvious decisions.
