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

With the Helm chart ([charts/cela](../charts/cela/README.md)), raise the value; never lower it:

```bash
helm upgrade cela charts/cela -n <ns> -f local/values.yaml --set orchestrator.shards=2
kubectl -n <ns> rollout status deployment/pi-orchestrator-1
```

The chart renders one Deployment per shard (`pi-orchestrator`, `pi-orchestrator-1`, ...; one replica, strategy `Recreate`),
the Services `pi-orchestrator-<k>` (and `pi-orchestrator` for shard 0) and sets ingest's `PI_ORCH_SHARDS` and `PI_ORCH_URL`
together, so a shard cannot exist without its route. `tests/e2e/run.sh shards` installs the chart with `orchestrator.shards=2`.

Shards can run on different nodes. `orchestrator.shards` and `PI_ORCH_SHARDS` must never decrease.

Ingest requires `PI_ORCH_URL`: an explicit http(s) URL, with `{shard}` when `PI_ORCH_SHARDS` (default 1) is above 1.
For example, `PI_ORCH_URL=http://orchestrator-{shard}:8081` and `PI_ORCH_SHARDS=3` route shards 0, 1 and 2.
A fixed URL is valid only for shard 0. There is no service-name default and no automatic derivation of service names.
All shards from 0 through `PI_ORCH_SHARDS - 1` must have a Service matching that template.

After migrations, before readiness, ingest queries every distinct `inbox.sessions.shard` (including deleted sessions).
If any shard is outside that range, it exits with an error listing the missing routes. Restore the shard count and
its Services; do not delete sessions to bypass the check. Database/migration failures still retry while unready.
The check runs at startup, not on every request; shard counts must never decrease during a rolling deployment.

## Sizing one shard

Each shard is one process on one event loop, so size it from its memory limit and its CPU
([decision 0018](decisions/0018-derived-bridge-cap.md)).

**Memory.** At start the orchestrator derives the cap on open bridges (`PI_MAX_OPEN_BRIDGES`) from the container memory limit:

```
max = max(1, floor((memoryLimit - 256 MiB) / 24 MiB))
```

| Memory limit | Cap |
| --- | --- |
| 512Mi | 10 |
| 1Gi | 32 |
| 2Gi (default) | 74 |
| 4Gi | 160 |
| 8Gi | 330 |

- 256 MiB is the base reserve and 24 MiB the cost per open bridge, both about twice the measured values: 115-147 MiB idle
  and about 11 MiB per bridge (measured 2026-11-17 in one example environment, sessions running tool calls through the broker,
  see [metrics.md](metrics.md)). At the cap the predicted use is about half the limit. The margin is for what one
  workload did not show: model-only turns, large tool output.
- `PI_MAX_OPEN_BRIDGES=<n>` overrides it (n of 1 or more), `0` removes the cap, `auto` or unset derives it. The start line
  `bridge-cap` shows the value, its source (`derived`, `explicit`, `unlimited`) and the limit it used. With no memory limit
  the cap is unlimited and the line is logged at `warn` level: nothing then bounds the bridges, so set a limit.
- **Set the memory request equal to the limit** (the chart's orchestrator does). The cap is derived from the limit, and
  a smaller request lets the scheduler place the Pod on a node that cannot back it.
- The cap protects memory only. It does not bound Pods, claim creation, CPU or Postgres.

**CPU, the real ceiling.** In one example environment, one orchestrator saturated 1 CPU at 100 sessions running tools at once while using 1.25 GiB of 8Gi.
Plan about **100 concurrently tool-active sessions per shard at 1 CPU**; that is the largest load tested. Beyond it, add a
shard (above) rather than a bigger limit: the derived cap at 8Gi (330) is far past what one event loop was shown to serve.
Nothing above 100 open bridges has been run; the V8 heap limit may be reached before the cgroup limit at the larger caps.

**Saturation signals**

- `cap-wait` p90 in `measure-timing.mjs` (docs/metrics.md) above a second or two, or `bridge-cap-wait` lines: sessions queue
  for a bridge slot. With a derived cap, that means memory is the limit; raise the limit or add a shard.
- `nr_throttled` rising in the container's `cpu.stat`: the CPU limit is the limit. Add a shard.
- `memory-sample` against the limit: the fitted base and per-bridge cost (`measure-timing.mjs`) tell whether the constants
  still hold.

**Pods.** An evicted env's Pod keeps running until idle suspend (30 minutes), so the cap bounds neither Pods nor claim
creation. Bound them with a ResourceQuota on the namespace (`count/pods`, and CPU and memory requests). Warm pools
are not a lever: `warmPoolReplicas` is capped at 0 because claims carry env and are never adopted (ADR 0030).

## Behaviour to know

- A shard that is down: its sessions' events stay `pending`, their streams answer 503 with `Retry-After`; other shards are
  not affected. When it returns, runs resume with no new input.
- A stream sent to the wrong shard answers 421 and creates nothing.
- Each shard uses the same orchestrator image digest. Roll out image updates to every shard; a new shard inherits shard 0's image.
- Shards share one node; there is no rebalancing.

The e2e suite for all of this is `tests/e2e/run.sh shards` ([e2e.md](e2e.md)).
