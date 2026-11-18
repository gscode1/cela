# 0029: Run outcomes from `Submission.wait()`; withdraw inputs queued behind a failed run

Status: accepted, 2026-11-18 (issue #179).

## Context

The run watcher (`packages/orchestrator/src/watcher.ts`) learns how each input ended, so rejected credentials and a
used-up turn budget fail the session. It polled `Storage.submissionByRequest` every 2 s for every unsettled input,
reading the adapter directly, on the assumption that Pi Durable does not report run outcomes to the host. Pi Durable
1.5.2 does: `Submission.wait()` resolves with the settled record (`done`, or `unanswered` with reason and detail), and
`harness.submission(id)` reacquires a submission after a restart.

`settings.afterFailedRun` was unset, so Pi's default `keep` applied: after a run failed without ending the session (a
429 that outlasted the retries, a network error), the messages queued behind it waited until the next input arrived,
and the watcher kept polling them.

A message admitted while a run works gets its `maxTurns` at admission (#177), before that run's turns are spent. When it
then starts its own run, the stale limit lets that run overshoot the session's turn budget.

## Decision

- **Outcomes come from `Submission.wait()`.** `Host.settlement` looks the submission up by request id (one Storage
  read: the Harness has no such lookup) and awaits it. Each watch is its own promise; a failed lookup or handler is
  retried every 2 s until the service stops. Nothing polls.
- **`afterFailedRun: "withdraw"`.** Inputs queued behind a failed run settle `unanswered` with reason `run_failed`. They
  never run; the client sees `live.runFailure` and sends them again if it wants. Rejected alternatives: `keep` leaves
  them hidden until some later input runs them; `continue` sends paid requests again right after a failure, against
  the rule that a failure must not turn into retried spend.
- **The turn limit is set again when a run answers.** The watcher's `onDone` recomputes `maxTurns` as the budget minus
  the turns used before the run in progress. Pi reads `maxTurns` at the end of every round, so a queued run is bounded
  from its first round. Admission and `onDone` both write `maxTurns`; the writes of one conversation run one after
  another, each reading the counts afresh, so a limit computed before a run answered never lands after the one
  computed once it had (#203). The run's rounds are read again after the transcript until both reads agree: a round
  committed between them would make the limit one too low, and `turn_limit` fails the session.

## Consequences

- Failure detection is immediate instead of up to 2 s late, and idle sessions cost no queries.
- A message queued behind a failed run is dropped, not delayed. Clients that queue follow-ups must watch for
  `runFailure`.
- `Host.submissionState` stays for tests and the test-fault gate.
