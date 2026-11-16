### 1. Orphan deletion can delete a newly created claim or an in-use PVC
- Verdict: REJECTED
- Severity (verified): n/a
- Location (verified): packages/orchestrator/src/kube.ts:144-157
- Reasoning: The loop at kube.ts:156 does skip a label re-check, but the premise ("a live session creates the claim meanwhile") cannot hold. `planSweep` (sweep.ts) only plans `delete-pvc`/`delete-claim` when `orphanReason(...)` is set, i.e. the owning session is `deleted` or unknown. Claim names are derived from the conversation id (`claimNameFor`), conversation ids are never reused, and a session is only marked `deleted` in `#delete` after `abort` + `destroySandbox`. So nothing live creates `pi-conv-N` after the sweep decides N is an orphan. A replacement claim for the same name would carry the same (deleted) session's label anyway, and sweeps are serialized by `#running`. Residual risk is only a post-abort stray tool call on a deleted session, which is not the reported scenario.

### 2. Repository preparation bypasses lifecycle tracking
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/host.ts:279-281 (caller sessions.ts:224)
- Reasoning: `workspaceEnv` returns `(await this.#sandboxes.ensure(id)).env`, the raw env. Only `lazyEnv` creates `#usage` entries, bumps `inUse`, waits on `#replacing`, and sets `#lastUsed`. So for a repo session whose first op is `repos.prepare`, `#evictIdle` (iterates `#usage`) never sees the env and the bridge process stays cached in `#envs` until a later tool call or `closeAll`; this leak is deterministic for repo sessions that never run a tool. Prepare also does not wait for `#replacing`: if the 30s `#suspendIdle` tick plans an idle suspend for a stale `#lastUsed` while a clone runs, `#closeEnv` closes the bridge and `suspendSandbox` deletes the Pod mid-clone (narrow window). The failure surfaces as a non-permanent error that the inbox retries, which is why this is medium, not high.

### 3. Failed recycling allows calls into a potentially dirty sandbox
- Verdict: CONFIRMED
- Severity (verified): medium
- Location (verified): packages/orchestrator/src/sandboxes.ts:222-226 (waiter at :142)
- Reasoning: `#replace` ends in `.catch(... this.#interrupted.add(conversationId); log(...))` with no rethrow, then `.finally` deletes the `#replacing` entry. A call parked at `await this.#replacing.get(conversationId)` (line 142) therefore resumes normally, calls `ensure`, and execs in the Pod that `recyclePod` failed to replace (e.g. `timed out waiting for Pod ... to be replaced`, or a failure before deletion). `#interrupted` is only consumed in `#settle` after that call ends, so the retry is after, not before. This contradicts ADR 0003 ("none reaches a dying Pod") and the retry-before-next-call intent. Impact is limited to leftovers in the same session's own sandbox, so medium rather than high.

### 4. Clearing the in-flight record races with the next command
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/sandboxes.ts:194-203
- Reasoning: `#settle` sets `usage.recorded = false` and fires `void execInFlight(false)` unawaited; the next `exec` sees `recorded === false` and issues `execInFlight(true)`. Both are independent `db.query` calls (`setExecInFlight`, store.ts:308) on possibly different pool connections with no ordering, so the clear can commit after the set, leaving `exec_in_flight_at = null` while a command runs. The next call has to go through `beforeUse` and `ensure` first, so reordering needs a slow clear and a back-to-back command; and it only matters if the orchestrator then crashes during that command. Mechanism is real, trigger is unlikely, so PLAUSIBLE and low (medium was too high).

### 5. Noncanonical sweep names can target a different workspace
- Verdict: PLAUSIBLE
- Severity (verified): low
- Location (verified): packages/orchestrator/src/lifecycle.ts:22-28 (used at sandboxes.ts:354)
- Reasoning: `SANDBOX_NAME = /^pi-conv-(\d+)$/` accepts `pi-conv-01` and `conversationOfName` returns `Number("01") = 1`; `sweep.ts` uses the same permissive `CLAIM_NAME`/`PVC_NAME`. `destroyOrphan("pi-conv-01", X)` then runs `#teardown(1, X)`, which closes conversation 1's live bridge and calls `deleteClaimAndPvc(..., "pi-conv-1", X)`. If `pi-conv-1` is labelled for a live session the label check throws (after the bridge was closed, and it would repeat every sweep since `pi-conv-01` is never deleted). If `pi-conv-1` is absent, the 404 path goes on to delete PVC `workspace-pi-conv-1`. But this needs a hand-made `pi-conv-0N` claim labelled with a deleted session's UUID; the orchestrator only creates canonical names, and a live conversation with an absent claim but present PVC is itself rare. The same permissive parse also affects `#suspendIdle` (line 260). Real defect, unreachable without foreign resources, so low (high was overstated).

Totals: confirmed=2 plausible=2 rejected=1
