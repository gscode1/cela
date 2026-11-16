### 1. Oversized request bodies reset the connection instead of returning an error
- Verdict: REJECTED
- Severity (verified): n/a
- Location (verified): packages/session-core/src/http.ts:25
- Duplicate of: none
- Reasoning: I reproduced the exact pattern (`for await (const chunk of req)` throwing past a limit, then `res.writeHead(400); res.end()` in the catch) on Node v26 with a 60 MB body sent by both curl and fetch: the client received `400` every time, no reset. Destroying the request after the throw does not prevent the response already queued on the socket from being delivered in that case. A client still mid-upload could in principle see a reset on some Node versions or proxies, but no failing trigger exists in this code base.
