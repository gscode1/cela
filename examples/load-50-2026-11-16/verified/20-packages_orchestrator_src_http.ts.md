### 1. A stream can open after session deletion has closed its streams
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/http.ts:96-101 (with stream.ts:121,150 and sessions.ts:302)
- Duplicate of: 15-packages_orchestrator_src_stream.ts.md #2
- Reasoning: The handler only rejects `status === "deleted"`; a `deleting` session passes. `SessionService.#delete` calls `streams.closeSession(id, "deleted")` exactly once, before `destroySandbox` and before the status flips to `deleted`. A GET /stream arriving during that (multi-second) interval, or racing the check/registration gap, registers after closeSession and is never ended or told `deleted`; it keeps receiving keepalives until the client leaves. No data loss, so low.
