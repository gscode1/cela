## Findings

### 1. Remote output ignores local backpressure
- Severity: high
- Confidence: high
- Location: packages/sandbox-env/src/bridge.ts:64
- What happens: If the bridge’s stdout or stderr consumer is slow or stops reading, remote output continues to be consumed and queued in the Node writable. A sufficiently large or continuous output can exhaust the bridge’s memory instead of slowing the remote process.
- Evidence: `onStdout: (chunk) => void stdout.write(chunk)`
- Fix idea: Propagate writable backpressure to remote output consumption, pausing reads until `drain`. This may require using an async output iterator rather than the SDK’s synchronous callbacks.

### 2. Output errors during the final flush can be reported as success
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/bridge.ts:108
- What happens: If the remote process exits successfully while stdout still has buffered data, a subsequent stdout write failure during the flush is no longer part of the race. The flush callback resolves even on error, so the bridge can return exit code 0 despite losing output.
- Evidence: `if (outcome.kind === "exit") await flush(stdout);`
- Fix idea: Make `flush` reject on its write callback’s error and handle that failure as a fatal bridge outcome.

### 3. Stdout errors can occur before the error listener is installed
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/bridge.ts:63
- What happens: The remote process can emit output while `options.start()` is still pending. If writing that output causes stdout to emit an error before the listener is registered, the error is unhandled and can terminate the bridge instead of following its fatal-error cleanup path.
- Evidence: `proc = await options.start(... onStdout: (chunk) => void stdout.write(chunk) ...)`; the stdout error listener is installed only after the await.
- Fix idea: Install stdout error handling before starting the remote process, and retain it through startup and cleanup.

END-OF-REPORT
