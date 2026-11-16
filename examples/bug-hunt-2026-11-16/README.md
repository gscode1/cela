# Five AI agents hunt bugs in their own platform

A live run on 2026-11-16: five durable Pi agent sessions, each in its own gVisor sandbox with a fresh clone of this
repository, reviewed one area of pi-durable-k8s for bugs. The platform they ran on is the code they reviewed.

Everything here is real output. Nothing was edited except the summaries in this file.

## Setup

|          |                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cluster  | a small arm64 lab cluster (Kubernetes, Cilium, gVisor), not a cloud                                                            |
| Sessions | 5, created through the session API with `{ provider: "openai-codex", model: "gpt-6.1-terra", repo: "gscode1/pi-durable-k8s" }` |
| Model    | GPT 6.1 terra, reasoning `medium`, through a ChatGPT/Codex subscription injected by OneCLI                                     |
| Sandbox  | one gVisor pod per session (250m CPU, 256 MiB), workspace PVC, the repo cloned with a token scoped to this one repository      |
| Tools    | Pi's coding tools (bash, read, write, edit), running inside the sandbox                                                        |
| Limits   | static review only: the sandbox image has no Node, so the agents could not run the tests                                       |

Each session got one area and the same rules ([briefs/](briefs/)):

1. Orchestrator inbox and turn processing
2. Sandbox lifecycle (orphan sweep, pod recycle, idle suspend)
3. The bridge between Pi and the sandbox
4. Session API and auth
5. Kubernetes manifests and shell scripts

The rules ask for real defects only, re-checked before reporting, at most about 40 tool calls, and a fixed Markdown
report ending in `END-OF-REPORT`.

## What happened (timeline)

From the orchestrator log ([raw/orchestrator.log](raw/orchestrator.log)) and the runner's timeline
([raw/timeline.log](raw/timeline.log)), all times UTC:

| Step                                          | Sessions 1 and 2 | Sessions 3 to 5              |
| --------------------------------------------- | ---------------- | ---------------------------- |
| Session created, message posted               | 11:07:59         | 11:12:36 to 11:12:42         |
| Sandbox ready (claim to running pod)          | +18 s            | +19 s                        |
| Repo token minted, OneCLI agent provisioned   | +66 s            | +21 to +30 s                 |
| `git clone` done, message handed to the agent | +96 s            | +31 to +41 s                 |
| Report finished                               | before 11:12:43  | +42 to +49 s after hand-over |

The agents were fast: 5 to 8 tool calls each, usually one large `bash` that printed several files at once, then
the report. The slow part was workspace setup, not the review.

Sessions 1 and 2 were slower because the platform was misbehaving at the time (next section).

## Bugs the run found before the agents did

Two problems showed up only because real sessions ran. No agent reported them.

1. **The first five sessions used the test model.** Ingest reads the default model from a ConfigMap into environment
   variables. The e2e test overlay had set it to a scripted test model. Putting the ConfigMap back did nothing for pods
   already running, so `POST /sessions` still defaulted to the test model until ingest was restarted. Those sessions
   were deleted ([false-start/](false-start/)). The runner now names the model explicitly.
2. **Ingest crash-looped while repo sessions started.**
   - The orchestrator keeps a database transaction open while it prepares a session's workspace: sandbox, OneCLI
     agent, `git clone`. Here that took 96 s.
   - At start, ingest re-ran its schema migrations, including `ALTER TABLE`. Those waited behind that transaction,
     hit the 30 s statement timeout, and blocked every insert queued behind them.
   - Ingest only starts its HTTP server after migrating, so `/healthz` did not answer and the liveness probe killed
     the pod, over and over.

   The fix ([gscode1/pi-durable-k8s#4](https://github.com/gscode1/pi-durable-k8s/pull/4)) records applied migrations
   and runs no DDL when the schema is current. It also uses a short `lock_timeout` when a migration does run, and
   serves `/healthz` before migrating. ADR 0005 has the details.

   Re-test after the fix: I restarted ingest while a repo session was cloning. Both new pods listened
   at once, finished the migration check in 0.3 s (nothing to apply) and stayed up with 0 restarts. The session
   finished normally.

A smaller operator lesson: my first runner ran five stream clients inside the 256 MiB ingest container, which likely
caused the first ingest restart. The second runner ([run-hunt2.sh](run-hunt2.sh), [multi-stream.mjs](multi-stream.mjs))
follows all sessions from one small process and resumes with `Last-Event-ID`.

## What the agents found

19 findings in 5 reports ([reports/](reports/)). An agent's report is not proof, so every finding was re-checked
against the code by an independent verifier agent told to try to refute it ([verified/](verified/)), and the
important ones were spot-checked by hand.

| Area      | Finding                                                           | Agent said | Verdict      | Verified severity |
| --------- | ----------------------------------------------------------------- | ---------- | ------------ | ----------------- |
| inbox     | Batch with a later delete stalls 30 s on its own row lock         | high       | confirmed    | medium            |
| inbox     | A failed session's abort is never retried                         | high       | confirmed    | medium            |
| inbox     | Watch recovery only covers 24 h / 1000 submissions                | medium     | plausible    | low               |
| inbox     | SSE backpressure leaks `close` listeners                          | medium     | confirmed    | low               |
| lifecycle | Orphan sweep can delete a live claim or PVC                       | high       | **rejected** | n/a               |
| lifecycle | Repo preparation bypasses idle tracking                           | high       | confirmed    | medium            |
| lifecycle | Failed pod recycle lets calls into a dirty sandbox                | high       | confirmed    | medium            |
| lifecycle | Clearing the in-flight marker races the next command              | medium     | plausible    | low               |
| lifecycle | Non-canonical names (`pi-conv-01`) map to another session         | high       | plausible    | low               |
| bridge    | Bridge ignores stdout backpressure                                | high       | plausible    | low               |
| bridge    | Closing a connection that waits for the start gate blocks it 45 s | medium     | confirmed    | medium            |
| bridge    | stdout error during the final flush reported as success           | medium     | plausible    | low               |
| API       | A client-chosen `sourceEventId` can block deletion                | high       | confirmed    | medium            |
| API       | An event can be accepted while the session is being deleted       | medium     | confirmed    | low               |
| API       | A delete that fails 5 times in a few seconds can never be retried | high       | confirmed    | **high**          |
| deploy    | `push-code.sh` can leave the orchestrator scaled to 0             | high       | confirmed    | medium            |
| deploy    | Secret scripts pass values on the kubectl command line            | high       | confirmed    | low               |
| deploy    | A failed host-rules update leaves the OneCLI allowlist off        | high       | confirmed    | medium            |
| deploy    | Test cleanup deletes rows before resources are gone               | medium     | confirmed    | low               |

Totals: **12 confirmed, 6 plausible, 1 rejected.** The agents rated 12 findings high. After verification, one is high,
8 are medium and the rest are low or rejected.

Notes on the results:

- **Precision was good, severity was not.** Almost everything pointed at a real mechanism, but the agents
  consistently rated their findings too severe. The verifier usually lowered the rating because of a mitigation the
  agent never read: a statement timeout that turns a "deadlock" into a 30 s stall, a second firewall layer, or a
  trigger that needs hand-made resources.
- **The one rejection was well reasoned but wrong.** The sweep cannot race a new claim, because claim names come from
  conversation ids, and those are never reused.
- **The most useful finding** was the delete retry: five attempts about one second apart, then the delete is marked
  failed for good, and a second `DELETE` is deduplicated away. A Kubernetes API hiccup of a few seconds leaves a
  session stuck in `deleting` with its sandbox, PVC and OneCLI agent alive, and the orphan sweep treats `deleting` as
  live.

## Fixes

All 12 confirmed findings were fixed the same day. Each fix was written by an implementation agent with a unit test
that fails without it, then run on the lab cluster (phase 4: 15 e2e tests, phase 4c: repo sessions) before merging.

| PR                                                       | Fixes                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#21](https://github.com/gscode1/pi-durable-k8s/pull/21) | Deletes retry with backoff until done, and a repeated `DELETE` re-queues a failed one (the high one). The server's delete key can no longer be taken by a client id. Event admission is one conditional insert. No session-row update inside the batch transaction. A failed session's abort is retried. |
| [#15](https://github.com/gscode1/pi-durable-k8s/pull/15) | Repo clones go through the tracked sandbox env. A failed pod recycle is retried before the next call, never skipped. A closed connection gives up its start-gate turn. SSE backpressure removes its listeners.                                                                                           |
| [#17](https://github.com/gscode1/pi-durable-k8s/pull/17) | `push-code.sh` always scales back and swaps code only after a good extract. Secret scripts pass values through private files, not argv. Host-rules update creates allow rules before touching the block rule and restores it on failure. Test cleanup only drops rows of deleted sessions.               |

Checked live after #21: a message using the id `delete:<session>` followed by `DELETE` reached `deleted` in 3 s. A
message and a delete sent back to back finished in 3 s with no statement timeout. An event posted after the delete got
`410`.

The 6 plausible findings are not fixed: their triggers need hand-made resources, a parent process that stalls for a
long time, or more than 24 h of unsettled runs.

Found along the way, not by the hunt:

- [#4](https://github.com/gscode1/pi-durable-k8s/pull/4): the ingest crash loop described above.
- [#6](https://github.com/gscode1/pi-durable-k8s/pull/6): the public-release cleanup had broken the e2e entry point for
  an empty `KUBE_CONTEXT`.
- [#22](https://github.com/gscode1/pi-durable-k8s/pull/22): two flaky unit tests, 5 failures in 36 full-suite runs
  before, 0 in 24 after. One was a test deleting a directory while a Host still wrote to it. The other was a real
  nondeterministic error message.

## Resources

From [raw/resources.log](raw/resources.log), sampled every 20 s:

| State                           | Orchestrator memory   |
| ------------------------------- | --------------------- |
| Idle                            | about 110 MiB         |
| 2 sessions with open bridges    | about 420 MiB         |
| 3 sessions with open bridges    | about 550 to 600 MiB  |
| Bridges closed after 2 min idle | back to about 116 MiB |

Each open session costs about 150 MiB in the orchestrator, because each one runs its own Node bridge process. That is
why the orchestrator was OOM-killed at 1 GiB in an earlier test run, and why a shared in-process broker is next on
the list.

Cleanup after `DELETE /sessions/{id}` for all five, measured: claims gone after 4 s; PVCs, sandbox pods and the five
per-session OneCLI agents gone after 11 s.

## Reproduce

```sh
# needs a cluster set up from deploy/, an owner token in the ingest pods, and a reachable model
examples/bug-hunt-2026-11-16/run-hunt2.sh      # creates the missing sessions, follows them, writes raw/
```

## Files

| Path                                              | What                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [briefs/](briefs/)                                | The prompt: one area per session plus the common rules                                         |
| [reports/](reports/)                              | Each agent's final report, verbatim                                                            |
| [verified/](verified/)                            | The verifier's verdict per finding                                                             |
| [raw/](raw/)                                      | Transcripts (`*.stream`, one SSE entry per line), timeline, orchestrator log, resource samples |
| [false-start/](false-start/)                      | The first attempt that ran on the test model                                                   |
| `run-hunt.sh`, `run-hunt2.sh`, `multi-stream.mjs` | The runners                                                                                    |
