### 1. Remote output ignores stdout backpressure
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/sandbox-env/src/bridge.ts:64
- Reasoning: The mechanism is real: the vendored SDK's `pump()` in packages/vendor/agent-sandbox-client/src/commands.ts:386-392 calls `this.callbacks.onStdout?.(event.data)` synchronously and never waits, and the bridge ignores the `write()` return (`onStdout: (chunk) => void stdout.write(chunk)`). But the trigger is unlikely. The bridge's stdout is a pipe to pi-env's Connection, which reads it continuously with `child.stdout.on("data", ...)`. On POSIX, Node makes stdio pipes blocking, so `process.stdout.write` does not queue in userland; a slow reader blocks the loop and the gRPC stream backs up naturally. pi-env also caps frames at 16 MB. Unbounded memory growth needs a stalled parent plus a very large output, and "high" is overstated.

### 2. Closing a connection waiting for the start gate does not cancel its turn
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/sandbox-env/src/start-gate.ts:53-57 (also index.ts:70-73)
- Reasoning: Sequence: A holds the gate cold-starting; B's `Connection` calls `command()`, which suspends at `release = await gate.acquire()`. B's session closes, and `close()` runs `start.release()` and `connection.close()`. `free()` finds `release` undefined and does nothing. When A frees the gate, B's `acquire()` resolves and sets `release`, and `command()` returns. In pi-env's `#start`, `if (this.#closed) throw closed();` then fires and no bridge is spawned. Nothing ever calls `free()` for B, and `acquire()`'s `setTimeout(release, 45_000)` is the only release. So the gate stays dead for the full 45 s (not "until readiness", since no bridge ever reports ready), and several closed waiters stack. The report's "until readiness or the timeout" is slightly off, since it is always the full timeout.

### 3. A stdout failure during the final flush can be reported as success
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/sandbox-env/src/bridge.ts:49-51,108
- Reasoning: The code is as described: `flush` does `stream.write(new Uint8Array(0), () => resolve())`, ignoring the callback's error, and `await flush(stdout)` at line 108 is not raced against `outputFailed`, so a failure that arrives during the flush is swallowed and the exit code is returned. An earlier error mostly wins the first race, because it is emitted on nextTick and `outputFailed` resolves before the exit outcome is processed. The only gap is a failure landing in the narrow window after `exit` wins. A failing stdout here means EPIPE, i.e. the parent already closed the pipe and is tearing the connection down. The returned exit code then goes to a parent that is gone, so there is no practical consequence. The mechanism is real but the trigger is rare and the impact is negligible.
