# Session API

The session API lets a remote client create sessions, send messages, steer a running turn, stream events,
reconnect, and delete. It is inbox-shaped: the API writes an event to Postgres and returns; the orchestrator
consumes it. Terms follow `plan.md`: one session = one Pi conversation = one named SandboxClaim = one PVC.

## Processes

| Process | Replicas | Role |
|---|---|---|
| `ingest` (`packages/ingest`) | 2, stateless | Authenticates, checks the session owner, writes `inbox.events`, serves `GET /sessions/{id}`, proxies the SSE stream. Keeps accepting events while the orchestrator restarts: its readiness depends on the database only. |
| orchestrator (`packages/orchestrator`) | 1, `Recreate` | Owns the Pi Durable storage schema. Claims inbox rows and submits them to Pi Durable. Serves the SSE stream. |

**The orchestrator serves the SSE stream.** Ingest only authenticates the caller and proxies the bytes; it holds no
stream state. A client talks to ingest only.

Both connect to the CloudNativePG `pi-pg-rw` service directly (no transaction-pooled proxy). The shared code
(inbox migration, store, authentication) is `packages/session-core`.

```
client -> ingest --INSERT--> inbox.events <--claim-- orchestrator --submit(requestId=row id)--> Pi Durable
client <- ingest <--proxy SSE--------------------- orchestrator <--Conversation.watch()-------- Pi Durable
```

## Endpoints

All routes except the probes need `Authorization: Bearer <token>`. Errors are JSON `{ "error": "..." }`.

| Call | Success | Notes |
|---|---|---|
| `POST /sessions` body `{ provider?, model?, repo?, branch? }` | `201 { sessionId, provider, model, reasoning? }` | Creates the session for the caller (the token's owner). No conversation or sandbox yet. The body is optional; without it the session runs the default model. `provider` and `model` go together and must be a pair on the allowlist (see Models; the pair is compared field by field, so a provider id containing a slash never matches), else `400 { "error": "model <provider>/<model> is not allowed" }`. `repo` (`owner/name` on github.com) and `branch` (optional) give the session a cloned repository workspace, see `docs/repo-workspace.md`; a bad value is `400` (a branch follows git's ref-name rules, e.g. no path component ends in `.lock`) and `branch` without `repo` is `400`. The response echoes the model the session will use (and `repo`/`branch`), and the reasoning effort (`reasoning`, from `PI_MODEL_REASONING`; absent when unset). |
| `POST /sessions/{id}/events` body `{ kind, text?, sourceEventId? }` | `202 { eventId, duplicate }` | `kind` is `message`, `steer` or `cancel`. `text` is required for `message` and `steer` (at most 64 KiB). `sourceEventId` (at most 200 characters) deduplicates. Neither may contain NUL or unpaired surrogates (Postgres cannot store them). `400` invalid body, `409` session is deleting or failed, or the id belongs to another session, `410` session deleted. |
| `GET /sessions/{id}/stream` | `200 text/event-stream` | See Streaming. `503` with `Retry-After` while the orchestrator is down, `410` for a deleted session. |
| `GET /sessions/{id}` | `200 { sessionId, status, model: { provider, model, reasoning? }, failure?, createdAt, lastActivityAt, events: { pending, submitted, failed } }` | Answered from Postgres, so it works while the orchestrator is down. `status` is `active`, `failed`, `deleting` or `deleted`; `failure` is present only when `failed`. A session that predates per-session models reports the default model. |
| `DELETE /sessions/{id}` | `202 { sessionId, status }` | Idempotent. See Deletion. |
| `GET /healthz`, `GET /readyz` | `200` | Both processes. Ingest is ready when migrations succeeded and the database answers. The orchestrator is ready only once it owns the schema (the Service therefore always points at the owner). |

Status codes for authentication: `401` for a missing or wrong token. `404` when the session does not exist **or
belongs to another owner**: the two look the same, so the API does not reveal that a session exists.

`DELETE` is also an inbox row (kind `delete`). `POST .../events` with `kind: "delete"` is refused; use `DELETE`.

## Event lifecycle

1. Ingest inserts a row into `inbox.events` (`status = pending`) and returns `202`. A trigger sends
   `NOTIFY inbox_events`.
2. The orchestrator wakes on the notification (and on a 1 s poll as the safety net), and per session opens a
   transaction that claims that session's oldest pending rows with `FOR UPDATE SKIP LOCKED`, up to 20 at a time,
   ordered by `(created_at, id)`.
3. For each row, in order, it submits to Pi Durable with `requestId = <row id>`:
   - `message`: `whenBusy: "followUp"`. On an idle session it starts a turn; on a busy one it queues behind the
     running turn in Pi Durable's own inbox and starts the next turn when the current one answers.
   - `steer`: `whenBusy: "steer"`. The input joins the running turn after its current tool round. On an idle session
     it starts a turn like a message (it is not rejected).
   - `cancel`: `Conversation.abort()`: withdraws queued inputs, aborts the running turn, resolves when idle.
   - `delete`: see Deletion.
4. Only then is the row marked `submitted` (`submitted_at`, `attempts`) and the transaction committed.

Guarantees:

- **Deduplication.** `UNIQUE (source, source_event_id)`. `source` is `api:<owner>` for client events; the server's own delete row uses `system:delete` with the session id as `source_event_id`, so no client id can collide with it. A repeated post returns the
  first event's id with `duplicate: true` and writes nothing. Without a `sourceEventId` every post is its own event.
  The same id for another session is `409`.
- **No double durability, no re-run.** Pi Durable owns run recovery. The orchestrator never resubmits a row that is
  `submitted`, and never re-runs anything because a run died. If the orchestrator dies after Pi Durable accepted a
  submission but before the row was marked, the transaction rolls back, the row is `pending` again, and the retry
  submits with the same `requestId`, for which Pi Durable returns the original submission: no second turn.
- **Per-session order.** One drain per session at a time, oldest first. A transient failure stops that session's
  batch so later rows cannot overtake it. After 5 attempts (or at once for a permanent error such as a deleted
  session) the row is `failed` with `error` set and later rows proceed.
- **Batching.** Pending rows of a session are claimed together and submitted one by one in order. They are not
  merged into one model input: each keeps its own `requestId`, so each is an idempotent submission. (Merging would
  make the `requestId` depend on which rows happened to be pending.)
- **Outage.** While the orchestrator is down, rows pile up as `pending` and are processed in order when an
  orchestrator owns the schema again.

## Streaming

`GET /sessions/{id}/stream` is server-sent events built on Pi Durable 1.5's conversation view
(`Conversation.watch()`); `watchEvents` is not used. Ingest proxies it from the orchestrator.

| SSE event | `id:` | Data |
|---|---|---|
| `entry` | the Pi Durable entry id | `{ id, kind, messages: [{ role, text, calls?, isError? }] }`: one committed transcript entry (user input, assistant answer or tool call, tool result), once, in order. Entries without model messages are not sent. |
| `live` | none | `{ running, queued, partial?, tools?, runFailure? }`: the run in progress, from `pi.live` and `pi.inbox`. Sent on connect and on every change. `running: false` with `queued: 0` means idle. |
| `deleted` | none | The session was deleted; the stream ends. |
| comment `: keepalive` | | Every 15 s. |

### Reconnect semantics

**Entries resume from a cursor; the response in progress is replayed from its current state.**

- **The durable cursor is the Pi Durable entry id**: a monotonically increasing integer assigned by the storage and
  persisted in Postgres (`durable` schema) with the entry itself. It survives client drops, orchestrator restarts
  and Pod replacement, because it is the transcript's own key, not an in-memory offset. The SSE `id` of an `entry`
  event is that id. A client reconnects with
  `Last-Event-ID: <last id>` (the standard header, which an `EventSource` sends by itself). The server sends the
  entries after that id, exactly once and in order. Entries the view window no longer holds are read with
  `Conversation.entries()`, so a long outage loses nothing.
- Without `Last-Event-ID` the whole transcript is replayed from the start.
- `live` events carry no id and are not addressable by a cursor. A reconnect gets the current `live` state first, so
  a partially streamed answer is shown again from the start of what was committed so far (Pi Durable commits partial
  answers about every 100 ms and stores them at least every second). When the answer completes it arrives as an
  `entry`.
- After a client drop the orchestrator just drops that watch. After an orchestrator restart the connection ends
  (ingest ends the client response when its upstream ends, and drops an upstream that is silent for 45 s); the
  client reconnects, gets `503 Retry-After: 2` until a new orchestrator owns the schema, then resumes from its
  cursor. The restarted orchestrator continues unfinished runs by itself (Pi Durable recovery); the stream only
  reports them.
- Known gap: a `live` update that lands between two connections is not delivered as such. Only its result, the
  committed entry, is.

## Authentication and owners

One middleware, `Authenticator` in `session-core`: it maps request headers to a `Principal { owner }`. Both
processes use it, so replacing the static tokens by an OIDC verifier is a change in that one function.

- Tokens come from the Kubernetes Secret `api-auth`, key `tokens`, as `owner:token` lines (create it with
  `deploy/gen-api-secret.sh`; it never prints the tokens). Tokens are compared in constant time. A token must be at least 16 characters with no whitespace (it could not be sent in a bearer header); a bad entry stops the process at start with an error that does not print the token.
- The owner is stored on the session at creation and checked on every call (ingest) and again on the stream
  (orchestrator). A token of another owner gets `404`.
- Test setup creates two owners, `alice` and `bob`.

## Models and failure

- **Selection.** `PI_MODEL_PROVIDER`, `PI_MODEL_ID` and `PI_MODEL_ALLOWLIST` (comma-separated `provider/model` pairs;
  the model id may contain slashes) come from ConfigMap `pi-model-config`, which ingest and the orchestrator both
  read. The default is always allowed. The committed default is OpenAI Codex `gpt-6.1-terra` (`gpt-6.1-sol` is
  allowlisted too, and the scripted models, which the e2e suites use: `tests/e2e/deploy` patches the default back to
  scripted). `PI_MODEL_REASONING` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) is the reasoning effort of every new
  session.
- **Storage.** The chosen model is stored with the session (`inbox.sessions.model_provider`, `model_id`, `model_reasoning`; migrations
  `002_models.sql`, `003_reasoning.sql`), so changing the default later does not change existing sessions. The orchestrator creates the Pi
  conversation with it; Pi Durable keeps it in the conversation across restarts (`docs/model-credentials.md`).
- **`failed` is terminal.** A model error that reads as rejected credentials (401, 403 or 407 from the provider or
  the OneCLI gateway), or a session that used up its turn budget (`PI_SESSION_TURN_BUDGET`, model turns in total),
  sets `status: "failed"` and `failure` to a fixed message such as "model credentials were rejected (401/403): the
  OneCLI agent token or its grant for this provider is missing or revoked". From then on `POST .../events` returns
  `409 session is failed`, queued events end `failed`, and nothing more is sent to the provider. The transcript and
  stream stay readable, and `DELETE` works. The status commits before the conversation is aborted, so the abort is idempotent and repeated: by a retried failure, by any input that finds the session `failed`, and at orchestrator start for sessions failed in the last 24 h. Other model errors (rate limits, network) do not fail the session.

## Sessions and sandboxes

- Session ids are random UUIDs (v4), never sequential. The owner is stored per session as `owner` (the token
  entry's name) and `owner_subject` (the stable identity: `static:<owner>` for static tokens, issuer + subject for
  OIDC later); the owner check compares the subject.
- Every SandboxClaim carries the label `pi-durable-k8s/session-id: <session UUID>`. The orchestrator creates the
  claim with that label, and adopts an existing claim of the same name only if the label matches. A claim with the
  right name and another or no label is refused, and never deleted by session deletion. (Claims that predate this
  label are therefore not adopted; the claim name `pi-conv-<conversation id>` alone proves nothing.)
- The bridge processes (one Node process per session with a sandbox) are started through
  `bridge-launcher.js`, which gives them only `PI_SANDBOX_AUTH_TOKEN` (the token of their own claim, derived from the
  master key; see `docs/decisions/0001-per-sandbox-sandboxd-token.md`), the in-cluster Kubernetes endpoint, `PATH`
  and `HOME`. The database URL, the API tokens, the OneCLI agent token and the sandbox master key are not in their
  environment (checked by the e2e suite in `/proc/<pid>/environ`).
- An existing claim is adopted only if its `SANDBOXD_AUTH_TOKEN_SHA256` env matches the token hash the orchestrator
  derives for it. A claim from before per-sandbox tokens (or after a master rotation) is refused with an error that
  says to delete the claim and its PVC.
- Every Pi Durable submission carries `requestId = <inbox row id>`: `SubmissionDraft.requestId` is part of the
  1.5.2 type of `Conversation.submit()`, and its README documents that a repeated `requestId` returns the existing
  submission. Test 4 exercises it.
- Idle bridges are closed after 2 minutes (`PI_SANDBOX_IDLE_EVICT_SECONDS`) and reopened by the next tool call (the
  orchestrator was OOM-killed at 512 Mi with about ten bridges otherwise; its limit is now 2 Gi: 1 Gi was also OOM-killed by the parallel lifecycle e2e tests).
- **Idle suspend.** A sandbox with no call for 30 minutes (`PI_SANDBOX_IDLE_SUSPEND_SECONDS`, 0 = never; not below the
  eviction age) is suspended: `Sandbox.spec.operatingMode: Suspended` deletes the Pod and keeps the Sandbox, the claim
  and the PVC. The next tool call resumes it (about 15 s) and sees the old workspace. `docs/decisions/0004-idle-suspend.md`.
- **Interrupted commands.** A command that was aborted (cancel, steer), timed out, or was running when the orchestrator
  died gets its sandbox Pod replaced (the claim and PVC stay), because a `setsid` child escapes the process-group kill.
  The next tool call waits for the new Pod. `docs/decisions/0003-recycle-pod-on-interrupt.md`.

- `POST /sessions` only inserts `inbox.sessions`. The orchestrator creates the Pi conversation on the first event or
  stream (`inbox.sessions.conversation_id`) and the SandboxClaim `pi-conv-<conversation id>` lazily at the first tool
  call, through the Harness `env` callback, as before. A session that only chats never gets a sandbox or a PVC.
- Ingest does not need Kubernetes access. Only the orchestrator ServiceAccount has `delete` on `sandboxclaims` and
  `persistentvolumeclaims`, namespace-scoped.

## Deletion

`DELETE /sessions/{id}` answers `202` and queues a `delete` row. From that moment new events get `409` (`410` once deleted). Admission is one conditional insert (`session is active`), so an event whose body was still being read when the session was deleted is refused too, and the session is marked `deleting` before the delete row is written, so every accepted event sorts before it; events
accepted earlier are still processed first, in order. Then the orchestrator:

1. aborts the conversation (withdraws queued input, stops the running turn),
2. ends the session's open streams (`deleted`),
3. stops the bridge and deletes the SandboxClaim, then the workspace PVC, and waits until both are gone,
4. marks the session `deleted` (`410` from then on).

**Conversation state is not removed live.** The Postgres adapter's `deleteConversation` is a maintenance helper: it
refuses to run while a storage owns the schema, and Pi Durable 1.5 has no public live-deletion lifecycle. The
session is therefore marked deleted and its conversation rows stay in the `durable` schema until a maintenance job
runs. The job, per `docs/deletion-windows.md` of the adapter:

1. list `inbox.sessions where status = 'deleted' and conversation_id is not null`,
2. scale the orchestrator to 0 (ingest keeps accepting events),
3. with a fresh pool and the same schema configuration, call `deleteConversation(database, conversationId)` for each,
4. scale the orchestrator back to 1.

That job is not implemented here. Until it runs, deleted sessions' transcripts remain in Postgres.

A deletion cut off by a crash is safe to repeat: the `delete` row is still pending, and the Kubernetes deletes ignore
"not found".

**A delete is retried until it succeeds** (`docs/decisions/0006-deletes-retry-until-done.md`). Other events end `failed`
after 5 attempts; a `delete` row has no attempt cap, because a failed delete leaves the session `deleting` with its
sandbox, PVC and OneCLI agent alive, and the orphan sweep never touches a `deleting` session. A failing delete is
retried with a backoff of 1 s, 2 s, 4 s ... up to 60 s (held in memory per session; a restart retries at once). Only a
`PermanentError` (the session row is gone or already `deleted`) ends the row `failed`. A repeated `DELETE` also puts a
`failed` delete row back to `pending`, so a client can always retry a delete that was given up on.

### Orphan sweep

What deletion missed is removed by a periodic sweep in the orchestrator (`docs/decisions/0002-orphan-sweep.md`): every
`PI_SWEEP_INTERVAL_SECONDS` (300; 0 = off; every seconds setting is at most 2147483, a larger one is refused at start) it removes SandboxClaims `pi-conv-<n>` labelled with a session UUID, workspace
PVCs `workspace-pi-conv-<n>` without a claim, and OneCLI agents `pi-session-<uuid>` with their secrets, when the session
is `deleted` or has no row, and the object is older than `PI_SWEEP_GRACE_SECONDS` (600). At most `PI_SWEEP_MAX_ACTIONS`
(10) per run; each action is one `sweep-action` log line. Unlabelled claims, `control-<n>` labels and every other name are
never touched, and neither is a session that is `active`, `failed` or `deleting`, even when its sandbox can no longer work.

## Test-only surface

The orchestrator still has the Phase 3 scripted-session surface, now under `/control/...`, behind the same bearer
token, and only when `PI_ORCH_CONTROL=1` (the manifest sets it so `tests/e2e/run-phase3.sh` keeps running). It
bypasses the inbox. `PI_ORCH_TEST_FAULTS=1` makes the orchestrator honour `payload.testFault` on an inbox row, which
only SQL can write; the Phase 4 crash test uses it to exit between submit and mark.

## Deployment

- `deploy/gen-api-secret.sh` creates `api-auth`. `deploy/ingest.yaml` is the 2-replica Deployment
  (250m / 256Mi limits each) and Service `pi-ingest`.
- **Ingest code delivery:** `deploy/push-ingest.sh` bundles ingest and `session-core` (about 140 KB) into the
  ConfigMap `ingest-code`; an initContainer unpacks it into an emptyDir. Chosen over a code PVC because a
  ReadWriteOnce Longhorn volume cannot be mounted on two nodes, which would pin both replicas to one node. The limit
  is the ConfigMap size (1 MiB); the script refuses a bundle above 900 KB.
- The orchestrator is delivered as before (`deploy/push-code.sh`, code PVC).
- The inbox schema is `packages/session-core/migrations/*.sql` (`001_inbox.sql` to `005_exec_in_flight.sql`), applied
  in order by both processes at start. Each applied file is recorded in `inbox.schema_migrations`; when all are
  recorded the start issues one SELECT, no lock and no DDL. Missing files run idempotently under an advisory lock
  and `lock_timeout = 3s` (a blocked migration fails and is retried, it never queues ahead of traffic). The first
  start after this table was introduced re-runs the idempotent files once to record them
  (`docs/decisions/0005-migrations-without-ddl-locks.md`). After migration 002 an older ingest or orchestrator still
  runs but does not know the `failed` status or the model columns.
- Probes: ingest serves `/healthz` as soon as the process is up and `503`s `/readyz` and the API until migrations
  succeeded (then ready means the database answers). The orchestrator listens before it migrates; its `/readyz` is
  owner-only.
- `deploy/model-config.yaml` (ConfigMap `pi-model-config`) feeds both Deployments; the orchestrator also takes the
  OneCLI agent token and CA (`docs/model-credentials.md`).

## Known limits

- One orchestrator replica. The inbox claim is safe for more claimers (`SKIP LOCKED`), but the Pi Durable storage
  allows one owner.
- Conversation state of deleted sessions stays until the maintenance job.
- A crash between creating a Pi conversation and storing its id in `inbox.sessions` leaves one empty, unreferenced
  conversation.
- A steer posted when the session is idle starts a turn (it is not dropped or rejected).
- `live` events are best effort, not cursor-addressable (see Reconnect semantics).
- Backpressure: a slow SSE client delays its own watch only; Pi Durable folds commits meanwhile.
- No rate limits, quotas, per-token scopes, or CORS. Plaintext HTTP inside the cluster. c2 runs flannel, which does not
  enforce NetworkPolicy, so the bearer token is the only control between pods.
- `GET /sessions/{id}` reports inbox counts and last activity, not whether a turn is running; the stream's `live`
  event does.
