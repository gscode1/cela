## Findings

### 1. Disconnect during watch creation leaks the stream
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/stream.ts:121
- What happens: If the client disconnects while `host.watch()` is pending, the response’s `close` event can occur before its listener is registered. The handler then creates a keepalive interval and registers and starts a watch for an already-destroyed response. Nothing cleans them up until the watch independently closes.
- Evidence: `const watched = await host.watch(conversationId);` precedes `res.on("close", () => finish());`.
- Fix idea: Track disconnection before awaiting watch creation. After the await, stop the newly created watch and return if the response has already closed.

### 2. Deletion can miss a stream being established
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/stream.ts:150
- What happens: A stream request can pass the session status check, then pause while creating its watch. If deletion closes the session’s registered streams during that pause, this stream registers afterward and remains open without receiving the `deleted` event.
- Evidence: `streams.add(sessionId, finish)` occurs only after `await host.watch(conversationId)`.
- Fix idea: Coordinate stream registration with deletion, or recheck the session’s deletion state after registration and close the stream if deletion has begun.

END-OF-REPORT
