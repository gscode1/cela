### 1. Remote output ignores local backpressure
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/sandbox-env/src/bridge.ts:64-65
- Duplicate of: none
- Reasoning: `onStdout: (chunk) => void stdout.write(chunk)` discards the boolean return and the SDK callback (sandbox-client.ts:31-35) is synchronous, so nothing pauses the gRPC stream. True mechanism, but stdout is the pipe to the local orchestrator process which reads pi-env frames continuously; memory grows only if the parent stalls while the remote keeps producing output. Not observed trigger.

### 2. Output errors during the final flush can be reported as success
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/sandbox-env/src/bridge.ts:49-51, 108-109
- Duplicate of: none
- Reasoning: `flush` is `stream.write(new Uint8Array(0), () => resolve())`, ignoring the callback's error argument, and after an `exit` outcome only `flush` is awaited, so an EPIPE at that point still returns the remote exit code (0). The only way stdout fails is the parent closing its pipe, in which case no one is reading the exit code, so the loss is practically unobservable.

### 3. Stdout errors can occur before the error listener is installed
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/sandbox-env/src/bridge.ts:63-66 vs 81-85
- Duplicate of: none
- Reasoning: The `stdout.once("error")` listener is attached only after `await options.start(...)` (which can take up to the 45 s start gate), while `onStdout` can already write during start. A stdout error in that window with no listener would be an uncaught exception. It needs pi-env to emit output before it has been sent any request and the parent pipe to break at that moment; the consequence is the bridge dying, which it would do anyway (exit 1).
