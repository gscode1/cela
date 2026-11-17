# 0018: The cap on open bridges is derived from the memory limit

Status: accepted, 2026-11-17 (issue #91). Builds on [0004](0004-idle-suspend.md) (the cap), [0016](0016-in-process-broker.md)
(what an open env costs) and [0017](0017-schema-sharding.md) (one cap per shard).

## Context

`PI_MAX_OPEN_BRIDGES` defaulted to 12, set when a bridge was a 100 MiB Node process. Since ADR 0016 an open env is a small
relay process and in-process broker state: about 11 MiB each, with an idle orchestrator at 115-147 MiB (measured
2026-11-17). A fixed 12 is far below what the 2Gi limit holds and it is not tied to the limit, so changing one without
the other is a silent mistake in either direction.

Removing the cap is not safe. `Host.open` calls `harness.resume()`, which continues every unfinished run at once, and each
resumed run reopens its bridge at its next tool call. The only gates are the cap and `StartGate`, which serialises relay
spawns only. If that peak exceeds the memory limit the container is OOM-killed, the runs are durable, and the same peak
returns within about a minute: a self-sustaining crash loop. Each round also recycles the Pod of every conversation that
had an exec in flight (ADR 0003), so the loop reaches the scheduler too. With a cap the same overload becomes queueing
(`cap-wait`), which is visible and recoverable. (Read from the code; the loop was not reproduced, and how Pi Durable paces
`resume()` internally is not verified.)

## Decision

Derive the cap at start from the container memory limit; keep `PI_MAX_OPEN_BRIDGES` as the override.

| `PI_MAX_OPEN_BRIDGES` | Cap |
| --- | --- |
| unset or `auto` | `max(1, floor((memoryLimit - 256 MiB) / 24 MiB))` |
| unset or `auto`, no memory limit | unlimited, `warn` log at start |
| integer of 1 or more | that number |
| `0` | unlimited (like the other `0 = off` settings) |
| anything else | refuse to start |

- Constants, in `packages/orchestrator/src/bridge-cap.ts`: base reserve 256 MiB, per bridge 24 MiB, each about twice the
  measured value. Defaults: 512Mi gives 10, 1Gi 32, 2Gi 74, 4Gi 160, 8Gi 330; predicted use at the cap is about half the limit.
- The limit is `process.constrainedMemory()`, which reads the cgroup (v1 and v2). It returns 0 when there is no limit or it is
  unknown (documented Node behaviour, seen on Node 26 on macOS). A cgroup without a limit can surface as a huge number
  (page-rounded 2^63 on v1, 2^64-1 from some libuv versions on v2), so 0, undefined, non-finite and anything at or above
  2^50 bytes (1 PiB) is treated as no limit. This was not observed in a container: the Node 22 and 26 images could not be
  pulled while writing it, so the guard is defensive.
- Unlimited is `Infinity` in `Sandboxes`; its comparisons (`size < max`, `size >= max`) need no special case, and logs
  print `"unlimited"` because JSON would turn `Infinity` into null.
- A limit at or below the reserve still gives one slot. Zero would deadlock every tool call.
- Logs: `bridge-cap` at start (`max`, `source`, `memoryLimitBytes`, `reserveBytes`, `perBridgeBytes`), and `memory-sample`
  on the `bridge-rss` interval (`memoryCurrentBytes`, `memorySource`, `open`, `max`), so `measure-timing.mjs` can fit the
  base and per-bridge cost from any deployment and show when the constants are stale.
- At the limit, behaviour is unchanged from ADR 0004: evict the least recently used idle env, else wait in the FIFO queue.
- `deploy/orchestrator.yaml` drops the `PI_MAX_OPEN_BRIDGES=12` env and sets the memory request equal to the limit. Each
  shard derives from its own limit; `add-shard.sh` clones the Deployment, so shards match.

## What the cap protects

Memory only. It stays a memory safety bound and must not become a concurrency control. CPU is the real ceiling (one
orchestrator saturated 1 CPU at 100 sessions using 1.25 GiB of 8Gi), so the answer to CPU is more shards, not a lower cap.
Pods and the kube API are not bounded either (an evicted env's Pod runs until idle suspend); use a ResourceQuota. Sizing
guidance is in [scaling.md](../scaling.md).

## Not done

- Admission on live memory headroom or event-loop lag (a feedback loop on a noisy signal that oscillates), a cap derived
  from CPU, a claim-creation rate limiter, a durable queue, per-session priority, a fixed upper clamp.
- A unit test of per-env memory (open 20 envs against a stub, fail above 18 MiB each). With a stub `start` no relay is
  spawned, so a process-memory delta would measure the test, not the product, and would be flaky. The honest check is the lab
  one: sample `memory.current` at 0 and at 50 or more open bridges and compare the fit from `measure-timing.mjs` with the
  constants (fail above 18 MiB per bridge or 192 MiB base).
- Nothing above 100 open bridges has been run. The V8 heap limit may be reached before the cgroup limit at the larger
  caps; check it in the first load test above 100.
- `StartGate` exists for a 12 s cold start that is now 0.26 s. Whether to delete it is a separate issue.
