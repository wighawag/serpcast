---
'serpcast': minor
---

`fetch` and `script` requests now send `sec-fetch-site` the way Chrome does, derived from the request URL relative to the `referer`: `same-site` for a sibling subdomain or another port, `cross-site` for another site or scheme (they always sent `same-origin` before). A request that is not same-origin also sends only the page's origin as `referer`, a `fetch` adds `origin`, and a cross-site one adds `sec-fetch-storage-access: active`, as measured from Chromium. The site rule is built in (no public suffix list); the new request option `fetchSite` overrides it. `headerTable()` accepts `url` and `fetchSite`, and `fetchSite()`, `FETCH_SITES` and the `FetchSite` type are exported.
