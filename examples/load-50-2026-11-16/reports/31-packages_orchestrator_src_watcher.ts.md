## Findings

### 1. One stalled submission blocks all run watches

- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/watcher.ts:61
- What happens: Lookups and failure handlers run sequentially under a single polling guard. If one lookup or handler stalls, later submissions are never checked, and subsequent timer ticks cannot start another pass. For example, a handler waiting for its conversation to become idle can prevent an unrelated session’s terminal model failure from being detected.
- Evidence: `await this.#options.lookup(...)` and `await this.#options.onUnanswered(...)` execute inside the loop; `if (this.#polling) return` rejects overlapping polls.
- Fix idea: Process watches independently with bounded concurrency, and apply timeouts or cancellation so a stalled operation cannot block unrelated submissions.

END-OF-REPORT
