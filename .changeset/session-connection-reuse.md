---
'serpcast': minor
---

Transport sessions reuse their connections (keep-alive, one HTTP/2 connection per origin, as Chrome does), never sharing them with another session, and gain `session.close()`. The engine chain keeps each engine's session between searches and closes its connections when the session is dropped (idle expiry, `clearSessions()`, `close()`). Measured through Tor: median request latency on one session fell from about 520 ms to about 90 ms.
