# Timing and memory metrics

Issue #58. [Decision 0004](decisions/0004-idle-suspend.md) quotes a resume of about 15 s, which is one observation of
Pod Ready. This page defines what the orchestrator now logs so that time to first instruction, resume latency and
bridge memory can be measured instead of guessed. All of it is JSON log lines on stdout (`log()`), no metrics server.

## Where a turn spends its time

A turn starts when the inbox hands an input to the session service (`SessionService.apply`). The sandbox is created
lazily, at the turn's first tool call, so the order is: input handed to Pi Durable, the model runs, the first tool call
asks for the sandbox, the claim and bridge come up, the first command is dispatched.

| Phase              | Logged when                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `input-submitted`  | `Host.submitInput` returned: the input is durably handed to the agent.                            |
| `tool-requested`   | The first tool call reaches the sandbox layer, before anything it may wait for.                   |
| `claim-requested`  | `Sandboxes#open` starts: the SandboxClaim is about to be created, adopted or resumed.             |
| `claim-ready`      | The claim is bound and its Pod is Ready (the SDK's wait ended).                                   |
| `bridge-started`   | The start gate let this env spawn its relay process (starts go one at a time; since ADR 0016 the relay is a thin `node:net` process and the bridge runs in the orchestrator). |
| `bridge-ready`     | The broker wrote `bridge: ready` on the relay's log connection (the sandbox process is running).  |
| `first-exec-start` | The first `exec` of the turn is dispatched into the env. The bridge is spawned lazily by the first request, so on a cold turn this comes before `bridge-started`. |
| `first-exec-sent`  | The first exec request leaves for a ready bridge: at `bridge-ready` after the dispatch, or at the dispatch when the bridge was already up. Ends the turn. |

A phase is logged the first time the turn reaches it. A warm turn (env already open) has no claim or bridge phases.
There is deliberately no phase for the end of the exec: a 60 s command is the user's workload, not startup latency.

### Events

`turn-phase`, one per phase, `ms` since the turn started:

```json
{"t":"2026-11-16T10:00:03.020Z","event":"turn-phase","session":"6f1c...","conversation":7,"turn":"0b7e...","phase":"claim-ready","ms":12020}
```

`turn-timing`, one summary per turn, logged at `first-exec-sent`. `sandbox` is `cold` (the claim was created for this turn),
`resumed` (a suspended sandbox was resumed) or `warm` (the claim existed and was running; the bridge may still have been
reopened after an idle eviction, see the `bridge-*` phases). `spans` are intervals between phases:

```json
{"t":"...","event":"turn-timing","session":"6f1c...","conversation":7,"turn":"0b7e...","sandbox":"cold",
 "phases":{"input-submitted":20,"tool-requested":2020,"claim-requested":3020,"claim-ready":12020,"first-exec-start":12020,"bridge-started":12020,"bridge-ready":24020,"first-exec-sent":24020},
 "spans":{"model":2000,"cap-wait":1000,"claim":9000,"bridge":12000,"sandbox-to-exec":22000}}
```

| Span              | From, to                              | Meaning                                                                                                                   |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `model`           | `input-submitted`, `tool-requested`   | Model time before the first tool call. Not the platform's.                                                                |
| `cap-wait`        | `tool-requested`, `claim-requested`   | Waiting before the claim is requested: a bridge slot at the bridge cap (`PI_MAX_OPEN_BRIDGES`, derived from the memory limit by default), a recycle under way, credential renewal.  |
| `claim`           | `claim-requested`, `claim-ready`      | Claim create or resume until Pod Ready. Cold start and resume latency.                                                    |
| `bridge`          | `bridge-started`, `bridge-ready`      | Relay start plus the broker's sandbox connect. Before ADR 0016 it was the bridge's Node cold start, about 12 s on 250m CPU (plan.md); compare against that.                                                                      |
| `sandbox-to-exec` | `tool-requested`, `first-exec-sent`   | Time to first instruction: everything the platform adds between the first tool call and the first command being sent, bridge start included. |

`turn` is the inbox event id, which is also the Pi Durable `requestId`, so it ties a turn to `event-submitted` and
`event-failed` (`eventId`). Limits: a turn that never runs an exec logs no summary (if its first tool call is not an
exec, `sandbox-to-exec` includes the time until the first exec); a message queued behind a running turn restarts the
clock, so the summary belongs to the later input. An unfinished turn is forgotten when the session is cancelled, deleted
or swept, after an hour, or when more than 1000 are pending.

### Correlation in other lines

`session`, `conversation` and `turn` are added to the sandbox lines of the current turn: `claim-ready`, `claim-failed`,
`sandbox-resumed`, `env-reopen`, `env-prepare-failed`, `exec-record-failed` and `bridge-cap-wait`. Filter one turn with
`kubectl logs deploy/pi-orchestrator | grep '"turn":"<event id>"'`. Lines of the idle sweeps (`sandbox-suspended`,
`sandbox-recycled`, `bridge-cap-evict`) belong to no turn and keep their fields.

## Bridge memory

Every `PI_BRIDGE_RSS_INTERVAL_SECONDS` (default 60, 0 = off) the orchestrator logs one line per open env. Since ADR 0016 the
RSS is that of the **relay** (a small `node:net` process), not of the bridge: the SDK and Kubernetes clients now live in
the orchestrator, so their cost shows in the orchestrator's own RSS, which is the number to compare at 12 and 50 sessions.
The RSS is `VmRSS` of `/proc/<pid>/status`, found by the relay's `--claim` argument among the orchestrator's children. On a system
without `/proc` (a Mac) nothing is logged; a failed read never affects a session.

```json
{"t":"...","event":"bridge-rss","session":"6f1c...","conversation":7,"claim":"pi-conv-7","rssBytes":104857600,"open":3}
```

### Bridge cap and container memory

At start, one `bridge-cap` line (docs/decisions/0018-derived-bridge-cap.md). `max` is `"unlimited"` when there is no cap;
the line has `"level":"warn"` and a `warning` when that is because the container has no memory limit.

```json
{"t":"...","event":"bridge-cap","max":74,"source":"derived","memoryLimitBytes":2147483648,"reserveBytes":268435456,"perBridgeBytes":25165824}
```

On the same interval as `bridge-rss` (also when no bridge is open), one `memory-sample` line: `memoryCurrentBytes` is the
container's own cgroup `memory.current` (v1: `memory.usage_in_bytes`), located through `/proc/self/cgroup` so a host cgroup tree is never read as the container's, when readable, with `memorySource` `cgroup`; otherwise it is
the orchestrator process's RSS, `memorySource` `rss`, which leaves out the relay processes. `open` and `max` are the open
bridges and the cap. The cgroup number includes page cache, so it reads a little high.

```json
{"t":"...","event":"memory-sample","memoryCurrentBytes":251658240,"memorySource":"cgroup","open":10,"max":74}
```

`measure-timing.mjs` fits a line through the `cgroup` samples (memory against `open`) and prints the base and the cost
per bridge. Compare them with the 256 MiB and 24 MiB the cap is derived from; they should stay below them. Samples at
only one `open` value give no fit.

## Measuring

`tests/e2e/measure-timing.mjs` reads the orchestrator log (read-only `kubectl logs`) and prints n, p50, p90 and max of
every phase and span by sandbox state, the base and per-bridge memory fit, and median and peak bridge RSS per session. It runs from the Mac.

```
node tests/e2e/measure-timing.mjs --context <kube context> --namespace <namespace> [--since 24h] [--deployment pi-orchestrator]
node tests/e2e/measure-timing.mjs --file saved-orchestrator.log      # offline
```

Procedure for a clean sample (use the lab cluster):

1. Cold: create N sessions (N of 10 or more) and send each a message that runs one tool call (`echo hi`).
2. Resume: wait for the suspend age (set `PI_SANDBOX_IDLE_SUSPEND_SECONDS` low, for example 150, which must not be below
   `PI_SANDBOX_IDLE_EVICT_SECONDS`), check `kubectl get sandbox` shows `Suspended`, then send the same message again.
3. Warm: send a second message within the eviction age.
4. Run the script. `sandbox=cold`, `resumed` and `warm` rows are the three cases. Restore the settings.

## Experiment: sandbox readinessProbe period

`deploy/sandbox-template.yaml` has a `readinessProbe` on `/v1/health` with the Kubernetes default `periodSeconds: 10`.
A Pod that becomes healthy just after a probe waits up to 10 s to be marked Ready, so `claim` (cold and resume) may carry
up to 10 s of probe delay. Hypothesis: with `periodSeconds: 1` (and `initialDelaySeconds: 0`), the `claim` span drops by
about 5 s on average (half a period) and `sandbox-to-exec` by the same.

Method: measure as above with the template as it is (baseline); set `periodSeconds: 1` in the template, apply it to the
lab namespace, delete the warm pool Pods so they are recreated from it (a new claim and a resume both use the new
template), measure again with the same N; compare `span:claim` p50 and p90 for `cold` and `resumed`. Keep the change only
if p50 improves by more than the run-to-run spread; a 1 s probe adds one tiny request per second per Pod to sandboxd.

## Results

First baseline: c2 lab cluster, 2026-11-16, throwaway namespace `pi-e2e-t58a`, branch `58-timing-metrics` (default
template, readinessProbe period 10 s, orchestrator `cpu: "1"`), driven by phase 4's `create-send-stream`, `concurrency`,
`idle-suspend` and `sandbox-is-lazy` tests. The sample is small (5 cold, 1 resumed, no warm turn that ran a tool), so
treat these as orders of magnitude, not a benchmark; a second run of the same tests earlier that evening gave a resume
claim of 3.8 s, so the resume number varies a lot.

| sandbox | n | claim p50 | claim p90 | bridge p50 | bridge p90 | sandbox-to-exec p50 | sandbox-to-exec p90 |
| ------- | - | --------- | --------- | ---------- | ---------- | ------------------- | ------------------- |
| cold    | 5 | 17.0 s    | 28.0 s    | 1.8 s      | 2.3 s      | 20.6 s              | 30.0 s              |
| resumed | 1 | 15.5 s    | –         | 1.9 s      | –          | 17.5 s              | –                   |
| warm    | 0 | –         | –         | –          | –          | –                   | –                   |

What it says: the claim (Pod ready) dominates; the bridge cold start is about 2 s at the current CPU limit, not the ~12 s
of plan.md, so #59 (shared bridge) is mainly a memory change. `model` and `cap-wait` were near zero (scripted model, no
bridge-cap contention).

readinessProbe `periodSeconds` 10 against 1 (not measured yet, see #82: run.sh re-applies the template, so it needs an override first):

| probe period | state   | n | claim p50 | claim p90 |
| ------------ | ------- | - | --------- | --------- |
| 10 s         | cold    | TODO | TODO   | TODO      |
| 1 s          | cold    | TODO | TODO   | TODO      |
| 10 s         | resumed | TODO | TODO   | TODO      |
| 1 s          | resumed | TODO | TODO   | TODO      |

Bridge RSS per open session (same run): p50 about 126 MiB, peak 133 MiB, with up to 5 bridges open.
