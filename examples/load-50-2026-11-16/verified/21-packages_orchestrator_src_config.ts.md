### 1. Long sweep intervals become near-continuous sweeps
- Verdict: CONFIRMED
- Severity (verified): low
- Location (verified): packages/orchestrator/src/config.ts:93-94 (value*1000, no upper bound), used at :138 and packages/orchestrator/src/sweeper.ts:39
- Duplicate of: none
- Reasoning: `seconds()` only checks `Number.isInteger(value) && value >= 0` and returns `value * 1000`; `OrphanSweeper.start` passes it to `setInterval(() => void this.run(), intervalMs)`. Node clamps delays above 2^31-1 ms (about 24.8 days) to 1 ms, so `PI_SWEEP_INTERVAL_SECONDS=2592000` sweeps back to back (the `#running` guard only serialises runs). Needs an operator to set an absurdly large value; the default is 300, so impact is limited to extra list calls.
