## Findings
### 1. A failed bridge start delays unrelated sandboxes
- Severity: medium
- Confidence: high
- Location: packages/sandbox-env/src/index.ts:51
- What happens: If a bridge exits before reporting ready, such as when its sandbox connection fails, its gate turn is not released on exit. Other sandboxes in the process must wait up to 45 seconds before starting; multiple failures can compound the delay.
- Evidence: All connections use `gatedStart(startGate, ...)`; the gate releases on the ready log or close, otherwise `setTimeout(release, this.#maxHoldMs)` releases it.
- Fix idea: Release the turn when the bridge process exits or fails to spawn, as well as when it reports ready. Retain the timer as a fallback.

END-OF-REPORT
