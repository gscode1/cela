# 0002: Orphan sweep

Status: accepted, 2026-11-16 (issue #9). Implements the "periodic sweep" of the plan's Lifecycle baseline.

## Context

Session deletion removes the claim, the PVC and the OneCLI objects, but a crash, a test that dropped its rows before
the delete finished, or a session that was never deleted through the API leaves objects behind. Each is a gVisor Pod
and a PVC, or a OneCLI agent whose token still works. Nothing reconciled the cluster against `inbox.sessions`.

## Decision

The orchestrator (the schema owner, so only one process) runs `OrphanSweeper` every `PI_SWEEP_INTERVAL_SECONDS`
(300; 0 turns it off). Decision and execution are split: `planSweep` (`sweep.ts`) is a pure function from
`{sessions, claims, PVCs, OneCLI agents and secrets, now}` to a list of actions; `OrphanSweeper` (`sweeper.ts`)
reads the world, executes the list and logs every action.

**What counts as an orphan.** Only a session that is `deleted` or has no row at all (`session-deleted`,
`session-unknown`). `active`, `failed` and `deleting` sessions are live.

**What may be swept, by exact pattern only:**

| Object | Pattern | Orphan when |
|---|---|---|
| SandboxClaim | name `pi-conv-<n>` and label `pi-durable-k8s/session-id` is a UUID | the label's session is deleted or unknown |
| PVC | `workspace-pi-conv-<n>` | no claim of that name exists (labelled or not) and the session that owns conversation `<n>` is deleted or unknown |
| OneCLI agent and secrets | agent `pi-session-<uuid>`, secrets `pi-session-<uuid>-git` and `-api` | that session is deleted or unknown |

Everything else is left alone: unlabelled claims (the e2e Phase 1 claim `e2e-phase1`), `control-<n>` labels of the
test-only control sessions, other names, other namespaces. A claim whose PVC is still wanted by another claim name is
never touched.

**Safety.**

- *Grace age.* Nothing younger than `PI_SWEEP_GRACE_SECONDS` (600) is swept, from the object's `creationTimestamp`.
  OneCLI does not report creation times; an agent is judged by its session alone. That is safe because the session row
  exists before any of its objects does and is never hard-deleted by the API. That holds only if
  the session list is read after the object lists: the sweeper lists claims, PVCs and OneCLI first and the sessions
  last, so a session created while the lists were being read is in the snapshot.
- *Independent sources.* Kubernetes (claims and PVCs together, since a PVC is orphaned only when no claim of that name
  exists) and OneCLI are listed separately. A failed listing is logged (`sweep-list-failed`) and only that source is
  skipped; the other is still swept.
- *Bounded.* At most `PI_SWEEP_MAX_ACTIONS` (10) per run, claims first, then PVCs, then agents. The rest waits.
- *Logged.* One `sweep-action` line per action (kind, claim or session id, reason), `sweep-action-failed` with the
  message on error. Names and ids only; no token or secret value is ever in the log (the agent token is not even carried
  into the action list).
- *Reuses the delete path.* A claim goes through `Sandboxes.destroyOrphan`, which is the teardown of session deletion
  (stop the bridge, `deleteClaimAndPvc`). That function still refuses a claim whose label is not the one the sweep
  read, so a claim that changed hands between listing and deleting survives. A lone PVC goes through the same function
  with a key no label can equal. OneCLI goes through `RepoAccess.revokeSession`, the by-name revoke that session
  deletion also uses (agent first, so its token dies first).
- *Tombstones.* A `deleted` session already has its tombstone from the delete that did not finish. A session with no
  row has nothing to record; the log line is its trace.

## Not in scope: an active session whose claim can never work again

A claim created under the shared token (before ADR 0001) belongs to an `active` session and fails every call with the
"delete the claim and its PVC" error. The sweep does not remove it. The workspace is the only copy of that session's
files, the session is one the user can still talk to, and ADR 0001 made recreating it an explicit operator decision.
Deleting the session through `DELETE /sessions/{id}` removes the claim and PVC through the normal path. (This is how the
leftover test sessions on c2, among them the owners of `pi-conv-5858` and `pi-conv-5873`, were cleaned.)

## Consequences

- The sweep needs `list` on PVCs, in addition to the claim verbs the orchestrator already has (`deploy/orchestrator-rbac.yaml`).
- A OneCLI shared with another environment that also creates `pi-session-<uuid>` agents would see those agents swept
  as "unknown". c2's OneCLI serves this project only. Do not share one OneCLI between two session databases.
- A conversation whose session row is hard-deleted by hand (as the e2e cleanup does after deleting through the API) has
  any leftover claim swept as `session-unknown`, which is the intent.
