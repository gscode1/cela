# 0054: Parked tools and approval gates for human steps (Pi Durable 1.6 signals)

Status: proposed, 2026-11-22 (issue #269, step 3). Design only; nothing is built. Builds on [0053](0053-pi-durable-1-6.md)
(the 1.5.2 to 1.6.0 upgrade, reserved), [0004](0004-idle-suspend.md), [0017](0017-schema-sharding.md),
[0028](0028-token-budget.md), [0029](0029-run-outcomes-from-wait.md), [0034](0034-egress-rules.md) and
[0041](0041-browser-sandbox.md).

## Context

Two things need a human in the middle of a run:

- **MFA login** (#269 step 3). A person completes the login in a live view of the sandbox's browser, then hands the session
  back. ADR 0041 forbids credentials, cookies and signed-in state in a sandbox (`0041:109-113`, `0041:234`); the person types
  them, the model never sees them.
- **Approval** of a risky call or of a new egress host. Today the only controls are static: the profile's tool list
  (`ProfileDefinition.tools`, `packages/session-core/src/profiles.ts:79`) and egress rule sets (`profiles.ts:111-115`).

With Pi Durable 1.5.2 a tool that waits for a person holds its invocation, the run and the sandbox. Pi 1.6.0 adds what is
missing (changelog 1.6.0, "Added"): `defineSignal` and `harness.signal(taskId, token, key, value)`, answering `delivered`,
`duplicate`, `invalid`, `closed` or `not_found`; tools whose `execute()` returns `{ sleep: { signals, until } }` and have a
`cancel()` for an aborted park; and `beforeTool` hooks that return `{ sleep }` or `{ block }` (examples 39, 40 and 44 in
`packages/durable/test/examples` at v1.6.0). Parked work "holds no invocation" and its slot shows `sleeping` or `waiting`.

The existing path is built for this. A session event is a row in `inbox.events`, claimed by the owning shard's drain
(`inbox.ts:203`, `sessions.ts:177`), deduplicated by `UNIQUE (source, source_event_id)` (`session-api.md:155`) and submitted
with a stable request id (`session-api.md:139-146`). The stream already forwards each tool slot's status verbatim
(`stream.ts:55`), and `liveEvent` is `running: true` for as long as the run exists (`stream.ts:38`).

## Decision

### 1. One park record, owned by the orchestrator

Pi stores no description of what a sleep waits for, only keys and a deadline (example 39). Ingest has no Harness
(`0028:40`), so a table says what is parked: `inbox.session_parks (session_id, call_id, kind, key, summary, state,
expires_at, resolved_by, created_at, closed_at)`, `kind` is `login` or `approval` or `egress`, `state` is `open`,
`resolved`, `expired` or `cancelled`. The orchestrator writes it (a tool or gate upserts by `(session_id, call_id)`, so the
reruns of a gate on every wake, which Pi does by design, create no second row). Ingest reads it to answer a client at once.
The id a client uses is the call id, which the stream already carries (`LiveEvent.tools[].callId`, `stream.ts:21`).

### 2. Resolving a park: `POST /sessions/{id}/parks/{callId}`

Body `{ kind: "login-complete" }` or `{ kind: "approval", decision: "approve" | "deny", note?, sourceEventId? }`.

- **Delivery goes through `inbox.events`** as a new event kind `signal`, not a synchronous proxy to the orchestrator. A click
  during an orchestrator restart is not lost, ordering with `cancel` and `delete` is the existing per-session order
  (`session-api:152-160`), and routing to the owning shard is free: only that shard claims the session's rows
  (`sessions.ts:177`, [0017](0017-schema-sharding.md) "Everything periodic is per shard"), so no `421` path is needed.
- **Auth**: the session's owner, checked like every session call (`session-api.md:220`; another owner's session and an
  unknown park are `404`). An `approval` park may require an admin (`PI_API_ADMINS`, `session-api.md:75`) when the profile
  says `approvers: "admin"`. A client never names a Pi key or token; the orchestrator derives both from the park's `kind`
  and `call_id`, and refuses a body whose `kind` does not match the park (`400`).
- **Answers**: `202 { eventId, duplicate }` as for events. A park that is not `open` is `409 { error: "park closed",
  state }` before any row is written. The race the table cannot see is settled by Pi's own answer when the row is drained:
  `delivered` and `duplicate` mark the row `submitted` (`duplicate` is success: the first value wins, a key serves one
  wait); `closed` and `not_found` (the call timed out, was aborted or was deleted in between) fail the row with a fixed
  error and no retry, via `PermanentError` (`sessions.ts:41`); `invalid` cannot happen after ingest validates the body.
  The client learns the outcome from the stream, as the tool result.
- **Expiry** is the park's `until` (Pi's clock), fixed at the first pass (example 44 does this with `api.memo`). A late
  answer is `closed`. Defaults: `login` 10 minutes, `approval` and `egress` 30 minutes; a profile may set
  `timeoutSeconds` up to 24 hours for approvals only.

### 3. MFA login: a parking tool, never the credentials

A tool `browser_login(site, reason)` in the browser flavour only. It registers a `login` park, makes the live view available
(transport is out of scope here, see Open questions), returns `{ sleep: { signals: [LoginComplete.key(callId)], until } }`
and, once woken, returns text only: `Login completed.`, `The person cancelled.` (an `isError` result) or `No login within
10 minutes.` (`isError`). The signal value is `{ outcome: "done" | "cancelled" }`, no secret. Its `cancel()` revokes the live
view and marks the park `cancelled`. The invariants of #269 hold: the cookies stay in Chromium's memory, the model sees no
value, and a profile with a logged-in site must not claim `open-web` (checked at the profile write, with the browser
flavour conflicts in `browserFlavourConflict`, `0041:109-113`).

Because the browser state lives only in the Pod (`0041:142`), the Pod must outlive the login. Idle suspend decides by the
last tool call only (`0004:110-115`, `0004:39-40`); a person typing in a live view makes no call, so the live view's
traffic touches the sandbox's last-use time (`Sandboxes#lastUsed`, `sandboxes.ts:108`) and config refuses a login timeout
at or above `PI_SANDBOX_IDLE_SUSPEND_SECONDS` unless that is 0.

### 4. Approval gates: a profile field, a `beforeTool` hook

```
approvals?: {
  tools?: string[];            // exact tool names, as GET /admin/tools lists them
  egressHosts?: string[];      // hosts the agent may ask for, exact or "*.example.com", never "*"
  timeoutSeconds?: number;     // 60..86400, default 1800
  approvers?: "owner" | "admin";  // default "owner"
}
```

- **Tools.** A `beforeTool` hook of an `approvals` extension parks a call whose tool is listed: it upserts the park,
  returns `{ sleep: { signals: [Approval.key(callId)], until } }`, and on the wake returns `undefined` (approved) or
  `{ block: ... }`. The hook runs again on every wake and registry publication (changelog, Gates), so it only reads the park
  and the signal. The extension is added per conversation only for a profile that has `approvals`, as MCP extensions are
  (`host.ts:215-245`), and reads the session's profile snapshot, so an edit of the profile never reaches a running session
  (`sessions.ts:278`). v1 matches tool names only: a gate on `bash` asks for every command. Matching arguments is left open.
- **Egress hosts.** A gate cannot see them: `beforeTool` sees a tool name and arguments, and `bash curl` hides its host in a
  string, while the proxy decides at CONNECT, in the sandbox's network path ([0035](0035-egress-proxy-runtime.md)). Holding
  that connection at the proxy is rejected: the proxy would need a callback to the orchestrator and would hold sockets for
  minutes. Instead a parking tool `request_egress(host, port, reason)` is offered when `egressHosts` is set. A host outside
  `egressHosts` is refused at once without a park. An approval makes the orchestrator write a session rule, `allow`, `direct`,
  never `route=onecli`, with `expiresAt` of 1 hour, through the functions `session-api.md:62` and `0034:58` already reserve
  for the orchestrator; the proxy applies it within one poll (about 5 s, `session-api.md:66`). The session's sandbox facts
  say that a refused host can be requested ([0049](0049-sandbox-environment-instructions.md), [0052](0052-coding-profile-packages.md)).
- **What the model sees.** Deny: tool result `isError`, `Denied by the user. Do not try the same action another way.` plus
  the approver's note, which is client input: truncated to 500 characters, control characters dropped, quoted as the
  user's words. Timeout: `Not approved within N minutes. The action was not run.` Neither is a run failure: the model
  gets its next turn, and [0029](0029-run-outcomes-from-wait.md) (`afterFailedRun: "withdraw"`) is not triggered.

### 5. Interactions

- **Idle suspend ([0004](0004-idle-suspend.md)).** A parked call is not a call in flight, so a gate-parked session's sandbox
  suspends on schedule and resumes lazily at the first call after the approval (`0004:51-53`): a gate costs a PVC, not a Pod.
  A login park is the exception in section 3.
- **Budgets.** A park spends no turn and no token: turns are model responses counted from the transcript
  (`sessions.ts:495`) and the model does not run while parked. `maxTurns` (`sessions.ts:513`, `0029:29-34`) is unchanged. The
  turn limit is recomputed when the run answers, and a long park does not delay it, because the run is the same run. A steer
  queued meanwhile joins only after the park's tool round (`session-api.md:144-145`); the way out is `cancel`. The token budget
  stays an admission check with the overshoot of `0028:23-26`.
- **Stream.** `sleeping` and `waiting` reach clients with no code change (`stream.ts:55`, a string), but `running: true`
  must not read as "thinking". The `live` event gains, per tool entry, `park?: { kind, summary, expiresAt }`, merged in
  `serveStream`'s `emit` from the park table (`stream.ts:223`; `liveEvent` stays a pure projection of the docs).
  `session-api.md:180` documents the field. No new SSE event; the resolution arrives as the tool's `entry`.
- **Abort and delete.** `cancel` and the `delete` row call `Host.abort` (`host.ts:590`; `sessions.ts:599`), which aborts
  parked tools: Pi runs each tool's `cancel()` (login: revoke the view, close the park). A gate-parked call has no `cancel()`;
  the orchestrator closes parks of a deleted session in the delete steps and those of a settled run in the watcher's
  `onDone`, and a late signal is `closed`. `Host.abort` waits for idle, bounded by `abortWaitMs` (`host.ts:586-600`);
  whether a parked call counts as idle must be shown by a test (Open questions).
- **Restart.** Parks are Pi tasks in Postgres and survive; `harness.resume()` (`host.ts:319`) continues them and the signal
  rows wait `pending` while the orchestrator is down (`session-api.md:168`). The park table is derived state: on start the
  orchestrator closes `open` rows whose call is no longer parked. A 1.6.0 database cannot be opened by an older Harness
  (changelog, `task_too_old`), so a rollback with open parks blocks them; the rollout of [0053](0053-pi-durable-1-6.md)
  decides what to do about it.

### 6. Out of scope

- **`afterTools` and `onYield` tasks.** `limitTurns` already bounds turns (`sessions.ts:513`). In-run token enforcement, the
  gap `0028:23-26` records, is what they could close; a later ADR if the overshoot matters.
- **`onAbort: "keep"`.** It is for input a sender cannot take back; every input here comes from a user, whose `cancel` must
  withdraw it (`session-api.md:147`).
- Also not used: `SubmissionDraft.notify` and `executeTool(..., { wait: false })` (subagents and parallel nested calls).

## Implementation sketch

1. Dependencies: [0053](0053-pi-durable-1-6.md) merged. Migration for `inbox.session_parks` and the `signal` event kind;
   `approvals` in `ProfileDefinition` with validation (`profiles.ts`) and the console form.
2. Orchestrator: signal definitions, `Host.signal`, the `signal` drain case with the answer mapping, park writes, cleanup on
   abort, delete, restart and `onDone`; `park` in the `live` event.
3. Ingest: `POST /sessions/{id}/parks/{callId}`, `session-api.md`, a smoke test over two shards.
4. The `approvals` extension and the tool gate; e2e with the faux provider: approve, deny, timeout, cancel while parked,
   restart while parked.
5. `request_egress` and the session rule write.
6. `browser_login`, behind the live view's own ADR.

## Open questions

- The live view's transport and auth (VNC or CDP screencast through ingest, token scope, how it reaches the sandbox with
  only the proxy as a destination, [0038](0038-network-modes.md)). This ADR assumes it; without it step 6 cannot ship.
- Does a `beforeTool` hook get the call id? Otherwise the key is a digest of tool name and arguments, as in example 44, and
  two identical calls in one turn share an approval.
- Does a parked call let the conversation go idle for `Host.abort`, and does `abort` run `cancel()` for a park a restart
  found? To be tested against 1.6.0 first.
- Argument-level gates (`bash` commands matching a pattern), and `approvers` as a named group instead of owner or admin.
- How an approver is told: nothing pushes today. The console polls the stream; a webhook is a separate decision.
- A park on an `egress` rule outliving the proxy poll: the host is reachable only after about 5 s; the tool result should say so.
