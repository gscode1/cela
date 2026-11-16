## Findings
### 1. Closing during gate acquisition can still return a launch command
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/start-gate.ts:40
- What happens: If the previous turn has resolved but `command()` has not yet received its release function, closing the connection aborts the waiter. The abort releases its gate turn, but `previous` can already have won `Promise.race`, so `command()` still returns the bridge argv after close. A subsequent waiter can also start while that bridge is starting, defeating serialization.
- Evidence: `await Promise.race([previous, cancelled])` is followed by returning a release function without rechecking the signal; `command()` assigns that function only after `await gate.acquire(mine.signal)`.
- Fix idea: Recheck cancellation after the race and before returning the acquired turn, releasing it and rejecting if aborted. Remove the abort listener when acquisition completes.

END-OF-REPORT
