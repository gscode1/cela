# Scaling the orchestrator

The orchestrator is horizontally scaled by sharding the Postgres schema, one Deployment per shard
([decision 0017](decisions/0017-schema-sharding.md)). A new session is placed on the shard with the fewest active sessions
and stays there.

| | Shard 0 | Shard k > 0 |
| --- | --- | --- |
| Deployment, Service | `pi-orchestrator` (and Service `pi-orchestrator-0`) | `pi-orchestrator-<k>` |
| Postgres schema | `PI_DURABLE_SCHEMA` (`durable`) | `<schema>_s<k>` (`durable_s<k>`), created at start |
| SandboxClaim, PVC | `pi-conv-<n>`, `workspace-pi-conv-<n>` | `pi-s<k>-conv-<n>`, `workspace-pi-s<k>-conv-<n>` |
| Env | `PI_ORCH_SHARD=0` (default) | `PI_ORCH_SHARD=<k>` |

Conversation ids repeat across shards (each schema mints from 2); `(shard, conversation_id)` is the identity.

## Add a shard

```bash
NAMESPACE=pi-durable-poc deploy/add-shard.sh 1   # Deployment + Services, and ingest PI_ORCH_SHARDS=2, PI_ORCH_URL=...{shard}...
NAMESPACE=pi-durable-poc deploy/push-code.sh     # every shard, on the shared code volume
```

`add-shard.sh` clones the live `pi-orchestrator`, so it carries the same env and code volume, and schedules next to it
(the code volume is ReadWriteOnce). It is safe to run again. `PI_ORCH_SHARDS` must never decrease.

Ingest: `PI_ORCH_SHARDS` (default 1) is the shard count for new sessions; `PI_ORCH_URL` holds `{shard}` when it is above 1.
The manifest in `deploy/ingest.yaml` stays single-shard; `kubectl apply` of it again resets both, so run `add-shard.sh`
after a re-apply.

## Behaviour to know

- A shard that is down: its sessions' events stay `pending`, their streams answer 503 with `Retry-After`; other shards are
  not affected. When it returns, runs resume with no new input.
- A stream sent to the wrong shard answers 421 and creates nothing.
- `deploy/push-code.sh` restarts every shard (and leaves each running, with at least 1 replica).
- Shards share one node; there is no rebalancing.

The e2e suite for all of this is `tests/e2e/run.sh shards` ([e2e.md](e2e.md)).
