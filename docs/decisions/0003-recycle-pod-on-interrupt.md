# 0003: Recycle the sandbox Pod after an interrupted command

Status: accepted, 2026-11-16 (issue #9). Closes the Phase 3 finding about `setsid` children.

## Context

Phase 3 measured it: when the stream of a command dies, the daemon reaps the command's process group and same-group
descendants, but a background child that called `setsid` survives. Pi Durable aborts commands on `cancel` and when a
steer lands mid-tool, and a command has its own timeout; an orchestrator killed mid-command loses the stream the same
way. The leftover keeps running inside the session's sandbox, with the session's workspace and (for repo sessions)
its proxy token, until something replaces the Pod.

## Decision

When the orchestrator knows a command was interrupted, it **deletes the sandbox Pod, never the claim or the PVC**. The
Sandbox controller creates a clean Pod on the same PVC (Phase 3 sandbox-loss behaviour). It applies to every session,
repo or not: one rule, no flag, and the cost of a recycle is a Pod start (about 15 s on the example test cluster, measured).

**What counts as interrupted** (`interruptedExec` in `lifecycle.ts`): an `ExecutionEnv.exec` that returned an
`aborted` or `timeout` error, or threw (the connection to the sandbox broke while it ran). A command that exits by
itself, with any exit code, is not interrupted. File operations never leave processes behind and never trigger it.

**In the running orchestrator.** `Sandboxes.lazyEnv` classifies each `exec` outcome. When the last call in flight of
that conversation ends and one of them was interrupted, the env is closed and `recyclePod` runs. Calls that arrive
meanwhile wait for it, so none reaches a dying Pod. `recyclePod` deletes the Pod bound to its uid (10 s grace; what
runs there is what we are getting rid of) and returns when a Pod with another uid is Ready. The next call opens a new
env: the SDK waits for the Sandbox, the bridge connects to the new Pod.

**A failed recycle blocks calls; it is never skipped.** If `recyclePod` fails, the owed recycle is kept (with the work to
run again) and the next call of that conversation retries it before it does anything. If the retry fails too, that call
throws, which the inbox treats as retryable; no call ever runs in a Pod that was not recycled. The alternative, letting
waiters proceed after a logged failure, would run the next command beside the escapee this ADR exists to remove. The
same holds for the recycle at start. The in-flight record stays set until a recycle succeeds.

**Across an orchestrator restart.** The dead process cannot tell us. So the orchestrator records "a command may be
running" in Postgres before the first command of a burst (`inbox.sessions.exec_in_flight_at`, migration 005) and clears
it when the last call ended without interruption, or once a recycle has finished. A record still set at start means the
previous process died mid-command. The clear is not awaited by the call that ends the burst, but the next burst's set
waits for it: the two run on different pool connections, and an unordered clear landing after the set would leave the
record cleared while a command runs (issue #207). `Host.open` recycles those sandboxes' Pods *before* `harness.resume()`, so the
continuing run (the interrupted command reads as `interrupted`, and is not replayed) finds a clean Pod. If a recycle
fails, the record stays and the next start tries again.

**Cost and limits.**

- One extra Postgres write per command burst (two updates: set, clear). Control sessions (no session row) are not
  recorded: a restart does not recycle them, which is the behaviour the Phase 3 suite tests.
- A recycle takes up to a minute of wall time (gVisor Pod start plus PVC re-attach); the tool call that follows
  waits for it.
- A Pod deleted with a 10 s grace can lose writes that were not flushed yet. Only an interrupted command is in that
  position, and its output is already unreliable.
- A recycle of a Pod that is not there (a suspended sandbox) is a no-op.

## Addendum: per shard (issue #84)

The exec markers are read per shard: `inbox.sessions` has a `shard` column since [0017](0017-schema-sharding.md), and each
orchestrator recycles only the Pods of its own shard's conversations at start. Nothing else here changed; the bridge
that the recycle reconnects is the broker and relay of [0016](0016-in-process-broker.md).

## Rejected

- *Kill the escapees from inside.* The agent can start processes in any session or process group; there is no list
  to kill and the daemon's view is what failed.
- *Recycle only repo sessions* (the plan's first wording). A plain session's escapee still burns CPU and can write to the
  workspace; one rule is simpler and the cost is the same.
- *Recycle every sandbox at every orchestrator start.* It restarts Pods of idle sessions for nothing.
