# Timing and memory metrics

Issue #58. [Decision 0004](decisions/0004-idle-suspend.md) quotes a resume of about 15 s, which is one observation of
Pod Ready. This page defines what the orchestrator now logs so that time to first instruction, resume latency and
bridge memory can be measured instead of guessed. All of it is JSON log lines on stdout (`log()`), no metrics server.

## Where a turn spends its time

A turn starts when the inbox hands an input to the session service (`SessionService.apply`). The sandbox is created
lazily, at the turn's first tool call, so the order is: input handed to Pi Durable, the model runs, the first tool call
opens the sandbox, the first command runs.

| Phase             | Logged when                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `input-submitted` | `Host.submitInput` returned: the input is durably handed to the agent.                    |
| `claim-requested` | `Sandboxes#open` starts: the SandboxClaim is about to be created, adopted or resumed.     |
| `claim-ready`     | The claim is bound and its Pod is Ready (the SDK's wait ended).                           |
| `bridge-started`  | The start gate let this env spawn its bridge process (bridges start one at a time).       |
| `bridge-ready`    | The bridge wrote `bridge: ready` (its Kubernetes and gRPC clients are loaded).            |
| `first-exec`      | The first `exec` of the turn through the bridge returned.                                 |

A phase is logged the first time the turn reaches it. A warm turn (env already open) has no claim or bridge phases.

### Events

`turn-phase`, one per phase, `ms` since the turn started:

```json
{"t":"2026-11-16T10:00:03.020Z","event":"turn-phase","session":"6f1c...","conversation":7,"turn":"0b7e...","phase":"claim-ready","ms":12020}
```

`turn-timing`, one summary per turn, logged at `first-exec`. `sandbox` is `cold` (the claim was created for this turn),
`resumed` (a suspended sandbox was resumed) or `warm` (the claim existed and was running; the bridge may still have been
reopened after an idle eviction, see the `bridge-*` phases). `spans` are intervals between phases:

```json
{"t":"...","event":"turn-timing","session":"6f1c...","conversation":7,"turn":"0b7e...","sandbox":"cold",
 "phases":{"input-submitted":20,"claim-requested":3020,"claim-ready":12020,"bridge-started":12020,"bridge-ready":24020,"first-exec":24120},
 "spans":{"agent-to-tool":3000,"claim":9000,"bridge":12000,"sandbox-to-exec":21100}}
```

| Span              | From to                           | Meaning                                                              |
| ----------------- | --------------------------------- | -------------------------------------------------------------------- |
| `agent-to-tool`   | `input-submitted`, `claim-requested` | Model time before the first tool call (not the platform's).       |
| `claim`           | `claim-requested`, `claim-ready`  | Claim create or resume until Pod Ready. Cold start and resume latency. |
| `bridge`          | `bridge-started`, `bridge-ready`  | Bridge cold start, about 12 s on 250m CPU (plan.md).                 |
| `sandbox-to-exec` | `claim-requested`, `first-exec`   | Time to first instruction: what the platform adds to the first tool call. |

`turn` is the inbox event id, which is also the Pi Durable `requestId`, so it ties a turn to `event-submitted` and
`event-failed` (`eventId`). Limits: a turn that never runs a tool logs `input-submitted` and no summary; a message
queued behind a running turn restarts the clock, so the summary belongs to the later input.

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
