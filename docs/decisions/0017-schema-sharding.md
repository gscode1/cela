# 0017: Horizontal scaling by schema sharding, one orchestrator Deployment per shard

Status: accepted, 2026-11-17 (issue #84). Builds on [0001](0001-per-sandbox-sandboxd-token.md),
[0002](0002-orphan-sweep.md), [0003](0003-recycle-pod-on-interrupt.md), [0004](0004-idle-suspend.md),
[0005](0005-migrations-without-ddl-locks.md), [0013](0013-e2e-namespace-per-run.md) and
[0016](0016-in-process-broker.md).

Note (install slice 11b, issue #141): `deploy/add-shard.sh` and `deploy/postgres.yaml` are gone; shards are the chart value `orchestrator.shards`.

## Context

One orchestrator owns one Postgres schema (the adapter's advisory lock allows a single owner), so one process serves
every session: its CPU, memory and bridge cap are the capacity limit. Two reviews of #84 (`hs-core`, `hs-ops`) looked at
active/active over one schema. That needs an adapter fork (ID allocator, sequence lock, fenced commits), a scoped
Harness per epoch and external fencing, and its safe policy ("no takeover until the old owner is dead") gives the same
availability as sharding. Sharding keeps every shard exactly today's proven system: advisory lock, fail-closed storage,
`Harness.open()` recovery.

One thing breaks if the schemas are simply multiplied: **conversation ids are minted per schema, starting at 2**
(`next_id`). Two shards mint the same id. The id was the global identity of a conversation: the claim and PVC name
`pi-conv-<n>` (and so the sandboxd token), every lookup of a session by `conversation_id` (`main.ts`, `skills.ts`,
`store.ts`), and `inbox.sessions` had no unique constraint on it. Unfixed, shard 1 would attach to shard 0's workspace
and hand out another session's repository credentials.

## Decision

- **Identity is `(shard, conversation_id)`.** `inbox.sessions.shard` (migration `014_shard.sql`, default 0) with a unique
  index on `(shard, conversation_id)`. Every lookup by conversation id in orchestrator code names the shard: one store
  function, `sessionByConversation(db, shard, id)`, and shard predicates in the exec markers, watch and abort recovery,
  profile reapply, the `#create` update and the inbox tick. A source-scan test
  (`packages/orchestrator/test/shard-invariants.test.ts`) fails on any `conversation_id = $n` SQL without `shard`, and on
  a `pi-conv-` literal outside `lifecycle.ts`. Nothing seeds ID ranges: that would write adapter-private state.
- **Static assignment at ingest.** `createSession` takes `PI_ORCH_SHARDS` (default 1) and picks the shard with the fewest
  `active` sessions, ties to the lowest. The count and insert are not atomic, so racing creates may pick the same
  shard; that only affects balance. A session never moves.
- **One Deployment per shard.** `PI_ORCH_SHARD=k`. Shard 0 keeps today's names: schema `PI_DURABLE_SCHEMA`, Deployment
  and Service `pi-orchestrator`, claims `pi-conv-<n>`, so a single-shard stack and every e2e suite are unchanged. Shard
  k > 0: schema `<schema>_s<k>` (created at start with `create schema if not exists`; `deploy/postgres.yaml` runs only at
  initdb), claims `pi-s<k>-conv-<n>`, Deployment and Service `pi-orchestrator-<k>`. `deploy/add-shard.sh k` clones the
  live Deployment (as the phase 3 double-owner test does), adds the Services `pi-orchestrator-0` and `pi-orchestrator-<k>`
  and sets ingest's `PI_ORCH_SHARDS` and URL together. As of installation slice 2, it inherits the same image digest; shards no longer require a shared code volume or node affinity.
- **Routing.** `PI_ORCH_URL` may contain `{shard}` (`http://pi-orchestrator-{shard}:8081`); ingest substitutes the
  session's shard and forwards the upstream `Retry-After`. A shard that receives a stream for another shard's session
  answers 421 before `ensureConversation`, so a misrouted stream never creates a conversation in the wrong schema.
- **Everything periodic is per shard.** Idle suspend and `destroyOrphan` match only the shard's claim names
  (`conversationOfName(shard, name)`). The orphan sweep builds its claim and PVC patterns for the shard and judges them
  by that shard's sessions. OneCLI agents are UUID-keyed and shared: a shard revokes an agent whose session is deleted
  and on that shard, or unknown only if it is shard 0, so exactly one shard acts on an unknown agent. ADR 0003 recovery
  reads the exec markers of its own shard. The stack prefix isolation of [0013](0013-e2e-namespace-per-run.md) and the
  bridge cap per replica are unchanged; `orchestrator_capabilities` is one row all shards write with the same code.
- **Failure semantics per shard.** A shard that is down leaves its sessions' events `pending` (ingest still answers 202)
  and their streams 503 with `Retry-After`; the other shards are unaffected. It resumes from Postgres when it returns,
  with no new input.

## Rejected

- Leases, epochs and takeover on one schema (the review's design): an adapter fork and external fencing for no better
  availability than "no takeover until the old owner is dead".
- Active/standby: no capacity.
- Seeding `next_id` ranges per shard: writes adapter-private state and does not fix the existing `pi-conv-<n>` names.
- A StatefulSet now: would rewrite every suite and the former code delivery tooling. Code keys only on the integer `PI_ORCH_SHARD`,
  so it can come later.
- Rebalancing, HPA, per-shard OneCLI prefixes and a `shard` abstraction layer.

## Limits

- Shards may run on different nodes (installation slice 2 removed the shared code volume). A node loss affects only the shards scheduled there.
- `PI_ORCH_SHARDS` never decreases: a session stays on its shard. Raising it without the Deployment strands new
  sessions as `pending`; `add-shard.sh` sets both.
- No rebalancing: placement balances new sessions only.
- Image rollouts must update all shards to the same digest (new shards inherit shard 0's image), and
  mixed versions across shards are not supported.
- One session's cost is still bounded by its shard's bridge cap and memory.
