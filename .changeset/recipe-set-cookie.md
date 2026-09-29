---
'serpcast': minor
---

Code recipes can set a cookie the way a site's page script does: `ctx.cookies.set(url, cookie)` applies a `document.cookie` string (`name=value; Path=/; Secure; Max-Age=...; Domain=...`) as the page at `url` would (the store's `Set-Cookie` rules, `HttpOnly` ignored, never replacing an `HttpOnly` cookie; returns `false` when rejected). The cookie lives in the engine's transport session, so it is sent where Chrome puts it by every matching request, and kept and dropped with the session. `ctx.cookies.get(url)` reads what `document.cookie` would (non-`HttpOnly` cookies sent to `url`) and `ctx.cookies.delete(url, name)` removes them by name. Cookie names such as `a#b` are kept byte for byte. Transport sessions gain `documentCookies` (exported with the `documentCookies(jar)` helper and the `DocumentCookies` type); on an injected `ChainTransport` it is optional, and without it `ctx.cookies` is a `recipe` error.
