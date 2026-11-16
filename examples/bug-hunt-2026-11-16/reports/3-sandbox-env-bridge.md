## Findings

### 1. Remote output ignores stdout backpressure
- Severity: high
- Confidence: high
- Location: packages/sandbox-env/src/bridge.ts:64
- What happens: If Pi reads slowly while the remote process produces output, `stdout.write()` eventually returns `false`, but the bridge continues consuming remote output and queues it in memory. A sufficiently large response can exhaust the bridge’s memory and terminate it, losing the response and disrupting the connection.
- Evidence: `onStdout: (chunk) => void stdout.write(chunk)`; the SDK’s callback consumer continues pulling events without waiting for the writable to drain.
- Fix idea: Consume remote events through a pull-based interface and pause consumption until stdout drains. Apply equivalent bounded handling to stderr.

### 2. Closing a connection waiting for the start gate does not cancel its turn
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/start-gate.ts:53
- What happens: If a connection closes while its `command()` is waiting behind another startup, `release()` has no acquired release function to call. The queued acquisition remains; when its turn arrives, it holds the gate until readiness or the 45-second timeout, delaying live connections behind it. Multiple closed waiters can compound the delay.
- Evidence: `release = await gate.acquire()` assigns `release` only after waiting, while `free()` only calls `release?.()`.
- Fix idea: Make queued acquisitions cancellable, or record that the gated start was closed and immediately release any subsequently acquired turn without launching.

### 3. A stdout failure during the final flush can be reported as success
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/bridge.ts:49
- What happens: If the remote process exits successfully but a buffered stdout write fails during the final flush, the flush callback resolves regardless of its error. The bridge can then return the remote exit code, including zero, even though the parent did not receive the complete output.
- Evidence: `stream.write(new Uint8Array(0), () => resolve())`; after the exit wins the race, `await flush(stdout)` is not raced against `outputFailed`.
- Fix idea: Reject the flush on write errors and treat that rejection as a fatal bridge failure, including errors emitted while the flush is pending.

## Areas checked with no findings
- Token derivation and bridge environment allowlisting for master-key and cross-sandbox token exposure.
- Bridge argument parsing and target selection.
- Sequential stdin writes and remote stdin closure.
- Sandbox handle cleanup on normal process closure and start failure.

END-OF-REPORT
