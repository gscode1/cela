## Findings

### 1. Long sweep intervals become near-continuous sweeps
- Severity: medium
- Confidence: high
- Location: packages/orchestrator/src/config.ts:138
- What happens: `PI_SWEEP_INTERVAL_SECONDS` accepts values above Node’s maximum timer delay. For example, an interval of 30 days is converted to milliseconds and passed to `setInterval`, which clamps the overflowed delay to 1 ms. Instead of running monthly, the sweeper repeatedly lists cluster and database resources as fast as its runs complete.
- Evidence: `intervalMs: seconds(env, "PI_SWEEP_INTERVAL_SECONDS", 300)`; `seconds` checks only that the value is a non-negative integer before multiplying by 1000.
- Fix idea: Reject sweep intervals whose millisecond value exceeds Node’s maximum timer delay, or implement long intervals using shorter scheduled delays.

END-OF-REPORT
