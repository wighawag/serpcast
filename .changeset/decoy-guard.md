---
'serpcast': minor
---

Add an opt-in decoy guard to the engine chain: `createSerpcast({decoyGuard: ['bing']})` checks the named engines' answers with the new exported `isDecoy(query, results)` rule, and a page unrelated to the query becomes a failure of the new `SerpcastError` kind `decoy` (the chain tries the next engine, with no cooldown).
