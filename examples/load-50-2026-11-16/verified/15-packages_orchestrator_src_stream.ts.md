### 1. Disconnect during watch creation leaks the stream
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/stream.ts:121, 147-151
- Duplicate of: none
- Reasoning: `res.on("close", ...)` is registered at line 151, after `await host.watch(conversationId)` (121). If the client disconnects during that await the `close` event has already fired and is never seen. The code then still starts the keepalive `setInterval` (its guard only skips the write), registers in `streams`, and starts the watch; `watch.closed` only resolves on Harness close and the registry only closes on session deletion. So interval, watch and registry entry live until the session is deleted or the process exits. The window is the watch-creation time (ms), so a slow leak.

### 2. Deletion can miss a stream being established
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/stream.ts:150
- Duplicate of: 20-packages_orchestrator_src_http.ts.md #1
- Reasoning: `streams.add(sessionId, finish)` runs after `await host.watch`. `SessionService.#delete` calls `streams.closeSession(session.id, "deleted")` once, before `destroySandbox`; a stream registered afterwards is never closed or sent `event: deleted` and just keeps sending keepalives. The window is wide because http.ts only refuses `status === "deleted"`, and a `deleting` session stays admitted for the whole duration of destroySandbox/teardown (seconds).
