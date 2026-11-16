### 1. A stale session snapshot can cause a live session's credentials to be revoked
- Verdict: PLAUSIBLE
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/sweep.ts:128-141 (agents and secrets have no age check in production: main.ts maps listAgents to `{id, identifier}` only) with packages/orchestrator/src/sweeper.ts:54-59
- Duplicate of: none (same mechanism as 29 #1)
- Reasoning: The mechanism is real: `Promise.all([listSessions(), ..., listOneCli()])` takes the session snapshot independently of the OneCLI listing, secrets have no grace check at all (line 133-135), and agents have no `createdAt`, so a session row inserted after the snapshot whose agent/secrets appear in the later OneCLI listing is planned as `session-unknown`; `revokeSession` then deletes by name without rechecking the DB (repo-access.ts:271-300). ADR 0002's claim "the session row exists before any of its objects" holds only relative to the true time, not the snapshot. But the window is the OneCLI list latency (tens to hundreds of ms) while a session must go create -> sandbox claim ready -> mint GitHub token -> createAgent/createSecret (`ensureAccess`) inside it, which takes seconds, and the sweep runs every 300 s. Very unlikely in practice; not high severity, though the effect (dead proxy token on a live session) would be real.

### 2. Repeatedly failing actions can starve the rest of the sweep
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sweep.ts:143
- Duplicate of: 29 #2
- Reasoning: `planSweep` returns `actions.slice(0, maxActions)` in fixed order (claims, PVCs, agents) with no knowledge of earlier failures; `OrphanSweeper.run` just logs `sweep-action-failed` and the next run re-plans the same head. Starvation needs at least `maxActions` (10) orphans whose teardown fails persistently (e.g. `deleteClaimAndPvc` throws on label mismatch, or a PVC stuck on a finalizer hits its 180 s timeout and throws). Possible but requires a sustained failure of many items; ADR 0002 documents "the rest waits".
