### 1. Disabling the request timeout permits stalled uploads indefinitely
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/ingest/src/main.ts:26
- Duplicate of: none
- Reasoning: `server.requestTimeout = 0` removes Node's bound on receiving a request, and the comment's premise is wrong: requestTimeout covers receipt of the request, not the SSE response lifetime (the stream route is a GET with no body). A client can send `POST /sessions/{id}/events` with Content-Length and stall; `readJsonObject` waits forever. But server.ts authenticates (line 81) and checks session ownership before reading the body, so only a token holder can do it, and each stalled connection costs only a socket plus small buffers (128 KiB cap); Node has no connection cap, so exhaustion needs fd limits. Real hardening gap, narrow trigger.
