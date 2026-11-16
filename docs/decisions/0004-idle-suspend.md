# 0004: Idle shutdown by suspending the sandbox

Status: accepted, 2026-11-16 (issue #9). Replaces the "set `shutdownAfterSeconds` as a backstop" line of Phase 4.

## Context

Idle sandboxes hold a gVisor Pod (100m CPU and 128 Mi requested) for sessions nobody is using. The plan forbids the
obvious answer: `Sandbox.spec.shutdownTime` / `shutdownAfterSeconds` is an absolute time after which the controller
deletes the Sandbox, and with its `shutdownPolicy: Delete` the workspace PVC goes with it. A session is a
conversation that can resume days later, so a deadline that deletes its workspace is wrong, and "renew on activity" is
an orchestrator write per call that fails the same way when the orchestrator is down.

`shutdownPolicy: Retain` keeps the Sandbox object after `shutdownTime` but marks it `Expired` and tears the Pod down
(`handleSandboxExpiry` in `controllers/sandbox_controller.go`). It is still an absolute deadline that has to be
renewed, and `Expired` is not a state the controller resumes from, so it is no substitute for a suspend.

## What `operatingMode: Suspended` does (agent-sandbox v1.0.11, verified in source and on c2)

- `Sandbox.spec.operatingMode` is `Running` (default) or `Suspended`
  (`kubectl explain sandbox.spec.operatingMode`; `clients/k8s/applyconfiguration/api/v1beta1/sandboxspec.go` documents
  it: "the controller terminates the backing Pod but retains the Sandbox object and its volumes so it can later be
  resumed. Resuming creates a new Pod from the current podTemplate that reattaches the retained volumes").
- `controllers/sandbox_controller.go` (`reconcilePod`, the branch on `OperatingModeSuspended`): deletes the Pod it owns,
  and `reconcilePVCs` is not skipped, so the PVC stays. The `Suspended` condition goes `PodTerminating`, then
  `Suspended=True` with reason `PodTerminated`; `Ready` is `False` with reason `SandboxSuspended`. The Service stays.
- A Sandbox owned by a SandboxClaim may be patched, and the claim controller does not revert it. The claim API has no
  operating mode; `extensions/controllers/sandboxclaim_controller.go` only patches the Sandbox's pod-template metadata
  and labels (`mergePodMetadata`), never the mode. Verified on c2 with a throwaway claim: a merge patch of
  `spec.operatingMode` to `Suspended` removed the Pod within seconds, the PVC (same uid) and the claim stayed, the
  claim reported `Ready=False/SandboxSuspended`, and 40 s later the mode was still `Suspended`. Patching back to
  `Running` gave a Ready Pod in 15 s on the same PVC.
- `Finished` is not set by a suspension (the controller keeps the previous value), so a future
  `ttlSecondsAfterFinished` would not delete a suspended sandbox either.

## Decision

After `PI_SANDBOX_IDLE_SUSPEND_SECONDS` (1800; 0 turns it off) with no call, the orchestrator suspends the session's
sandbox. The next tool call resumes it. No deadline, no deletion, no renewal.

- **Builds on bridge eviction.** `Sandboxes#evictIdle` already closes an idle env's bridge after
  `PI_SANDBOX_IDLE_EVICT_SECONDS` (120). Suspension needs the last-use time of sandboxes whose env was evicted, so
  `Sandboxes` keeps a second map, `#lastUsed`, that outlives the env. Config refuses a suspend age below the eviction
  age. A timer every 30 s lists the Sandboxes and `planSuspend` (pure, `lifecycle.ts`) picks the `pi-conv-<n>` ones that
  are `Running` and idle long enough.
- **A restart postpones, never suspends.** A Running sandbox the process has no record of (it just started, or it never
  used it) starts its idle clock at first sight. Suspended sandboxes need no tracking.
- **Suspend completes before anything else.** The patch is followed by a wait for `Suspended=True`; calls for that
  conversation wait for it (`#replacing`), so a resume cannot race a Pod that is still terminating and connect to it.
- **Resume is lazy**, like claim creation. `#open` calls `resumeIfSuspended` (patch to `Running`) before the SDK's
  Ready wait, because a Suspended Sandbox is never Ready and the wait would only time out. It runs on every open, so
  it also covers an orchestrator restart and a session whose sandbox was suspended by an earlier process.
- **Busy conversations are skipped** (a call in flight, a recycle or suspend under way).
- Only `pi-conv-<n>` Sandboxes are considered, which excludes the Phase 1 claim `e2e-phase1`.

## Consequences

- RBAC: `patch` on `sandboxes` (deploy/orchestrator-rbac.yaml). The claim stays the unit of ownership; nothing but the
  mode is written to the Sandbox.
- A suspended session costs its PVC and a Service. A resumed one starts a fresh Pod (about 15 s) and loses whatever ran
  in the old one, which was idle by definition.
- The workspace marker for repo sessions is on the PVC and survives. The in-memory GitHub token cache
  (`RepoAccess.beforeUse`) renews its token at the next call as it does after an eviction.
- Not done: suspending a sandbox that is busy but silent for 30 minutes (a model thinking). Its next command resumes it.

## Addendum: cap on open bridges (issue #43)

Idle eviction is a time rule, not a bound: sessions that all run tools within two minutes keep one bridge each, about
100 MiB apiece (the load-50 test peaked at 4.9 GiB). With the 2 Gi limit about 18 open bridges OOM-kill the
orchestrator and interrupt every session. `PI_MAX_OPEN_BRIDGES` (default 12, whole number of 1 or more, checked at
start) caps envs that are open or opening.

- `Sandboxes.ensure` for a conversation with no env, at the cap, first evicts the least recently used env that has no
  call in flight (`bridge-cap-evict`). If every env is in use, the call waits in a FIFO queue (`bridge-cap-wait`).
  Both logs carry `open`, `max` and `waiting`.
- A slot is an entry in `#envs`, so it is released by close, eviction, teardown and a failed open alike; each of those
  serves the queue. A call finishing also serves it, because its env has become evictable.
- The wait ends when the call's abort signal fires (the `Context` passed to every `ExecutionEnv` method); the call then
  fails and takes no slot. A signal that fires after the slot was granted does not undo the open.
- Eviction never touches an env with a call in flight, so the in-flight record of ADR 0003 is unaffected. An evicted
  env's next call opens a fresh bridge on the same claim, as after idle eviction.
- Separate from the start gate in `packages/sandbox-env/src/start-gate.ts`, which only serialises the CPU-heavy
  cold starts of bridges that are already allowed to open.
- A call that waits longer than the model or tool timeout above it fails there; the queue is not durable.

## Addendum: measuring resume (issue #58)

The 15 s above is Pod Ready only. The orchestrator now logs `turn-timing` per turn (claim, Pod Ready, bridge ready, first
exec) and `bridge-rss` per open bridge; how to read them, the measurement procedure and the readinessProbe-period
experiment are in [docs/metrics.md](../metrics.md). Results go there once measured.
