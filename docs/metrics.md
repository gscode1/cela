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
| `bridge-started`   | The start gate let this env spawn its bridge process (bridges start one at a time).               |
| `bridge-ready`     | The bridge wrote `bridge: ready` (its Kubernetes and gRPC clients are loaded).                    |
| `first-exec-start` | The first `exec` of the turn is dispatched through the bridge. Not its completion, see below.     |

A phase is logged the first time the turn reaches it. A warm turn (env already open) has no claim or bridge phases.
There is deliberately no phase for the end of the exec: a 60 s command is the user's workload, not startup latency.

### Events

`turn-phase`, one per phase, `ms` since the turn started:

```json
{"t":"2026-11-16T10:00:03.020Z","event":"turn-phase","session":"6f1c...","conversation":7,"turn":"0b7e...","phase":"claim-ready","ms":12020}
```

`turn-timing`, one summary per turn, logged when the first exec is dispatched. `sandbox` is `cold` (the claim was created for this turn),
`resumed` (a suspended sandbox was resumed) or `warm` (the claim existed and was running; the bridge may still have been
reopened after an idle eviction, see the `bridge-*` phases). `spans` are intervals between phases:

```json
{"t":"...","event":"turn-timing","session":"6f1c...","conversation":7,"turn":"0b7e...","sandbox":"cold",
 "phases":{"input-submitted":20,"tool-requested":2020,"claim-requested":3020,"claim-ready":12020,"bridge-started":12020,"bridge-ready":24020,"first-exec-start":24120},
 "spans":{"model":2000,"cap-wait":1000,"claim":9000,"bridge":12000,"sandbox-to-exec":22100}}
```

| Span              | From, to                              | Meaning                                                                                                                   |
| ----------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `model`           | `input-submitted`, `tool-requested`   | Model time before the first tool call. Not the platform's.                                                                |
| `cap-wait`        | `tool-requested`, `claim-requested`   | Waiting before the claim is requested: a bridge slot at `PI_MAX_OPEN_BRIDGES`, a recycle under way, credential renewal.  |
| `claim`           | `claim-requested`, `claim-ready`      | Claim create or resume until Pod Ready. Cold start and resume latency.                                                    |
| `bridge`          | `bridge-started`, `bridge-ready`      | Bridge cold start, about 12 s on 250m CPU (plan.md).                                                                      |
| `sandbox-to-exec` | `tool-requested`, `first-exec-start`  | Time to first instruction: everything the platform adds between the first tool call and the first command being sent.     |

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

Every `PI_BRIDGE_RSS_INTERVAL_SECONDS` (default 60, 0 = off) the orchestrator logs one line per open bridge. The RSS is
`VmRSS` of `/proc/<pid>/status`, found by the bridge's `--claim` argument among the orchestrator's children. On a system
without `/proc` (a Mac) nothing is logged; a failed read never affects a session.

```json
{"t":"...","event":"bridge-rss","session":"6f1c...","conversation":7,"claim":"pi-conv-7","rssBytes":104857600,"open":3}
```

## Measuring

`tests/e2e/measure-timing.mjs` reads the orchestrator log (read-only `kubectl logs`) and prints n, p50, p90 and max of
every phase and span by sandbox state, and median and peak bridge RSS per session. It runs from the Mac.

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

TODO: fill in after the live measurement (cluster, date, N, orchestrator and template versions).

| sandbox | n | claim p50 | claim p90 | bridge p50 | bridge p90 | sandbox-to-exec p50 | sandbox-to-exec p90 |
| ------- | - | --------- | --------- | ---------- | ---------- | ------------------- | ------------------- |
| cold    | TODO | TODO   | TODO      | TODO       | TODO       | TODO                | TODO                |
| resumed | TODO | TODO   | TODO      | TODO       | TODO       | TODO                | TODO                |
| warm    | TODO | TODO   | TODO      | TODO       | TODO       | TODO                | TODO                |

readinessProbe `periodSeconds` 10 against 1:

| probe period | state   | n | claim p50 | claim p90 |
| ------------ | ------- | - | --------- | --------- |
| 10 s         | cold    | TODO | TODO   | TODO      |
| 1 s          | cold    | TODO | TODO   | TODO      |
| 10 s         | resumed | TODO | TODO   | TODO      |
| 1 s          | resumed | TODO | TODO   | TODO      |

Bridge RSS per open session: TODO (p50 and peak in MiB, with the number of open bridges).
