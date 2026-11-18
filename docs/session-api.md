# Session API

The session API lets a remote client create sessions, send messages, steer a running turn, stream events,
reconnect, and delete. It is inbox-shaped: the API writes an event to Postgres and returns; the orchestrator
consumes it. Terms follow `plan.md`: one session = one Pi conversation = one named SandboxClaim = one PVC.

## Processes

| Process | Replicas | Role |
|---|---|---|
| `ingest` (`packages/ingest`) | 2, stateless | Authenticates, checks the session owner, writes `inbox.events`, serves `GET /sessions/{id}`, proxies the SSE stream. Keeps accepting events while the orchestrator restarts: its readiness depends on the database only. |
| orchestrator (`packages/orchestrator`) | 1 per shard, `Recreate` | Owns the Pi Durable storage schema of its shard (`PI_ORCH_SHARD`, default 0, schema `<PI_DURABLE_SCHEMA>_s<k>` for k > 0; ADR 0017, `docs/scaling.md`). Claims inbox rows and submits them to Pi Durable. Serves the SSE stream. |

**The orchestrator serves the SSE stream.** Ingest only authenticates the caller and proxies the bytes; it holds no
stream state. A client talks to ingest only.

Both connect to the CloudNativePG `pi-pg-rw` service directly (no transaction-pooled proxy). The shared code
(inbox migration, store, authentication) is `packages/session-core`.

```
client -> ingest --INSERT--> inbox.events <--claim-- orchestrator --submit(requestId=row id)--> Pi Durable
client <- ingest <--proxy SSE--------------------- orchestrator <--Conversation.watch()-------- Pi Durable
```

## Endpoints

All routes except the probes and the console (below) need `Authorization: Bearer <token>`. Errors are JSON `{ "error": "..." }`.

| Call | Success | Notes |
|---|---|---|
| `POST /sessions` body `{ profile?, provider?, model?, reasoning?, repo?, branch? }` | `201 { sessionId, profile: { name, version }, provider, model, reasoning? }` | Creates the session for the caller (the token's owner). No conversation or sandbox yet. The body is optional; without it the session runs the default profile and the default model. `profile` (optional) is the name of a session profile (see Session profiles): an unknown, malformed or disabled-for-new profile is `400`; omitted, the settings' `defaultProfile` applies (`coding` unless changed; if that profile is gone or disabled the answer is `503`, never another profile). The profile's definition is stored with the session as a snapshot. `provider` and `model` default to the profile's `defaultModel`, `reasoning` to its `reasoning`, and then to the settings; a request value always wins, and the result is checked against the allowlist and cap as below. `provider` and `model` go together and must be a pair on the allowlist (see Models; the pair is compared field by field, so a provider id containing a slash never matches), else `400 { "error": "model <provider>/<model> is not allowed" }`. `reasoning` (optional) is the effort of the session: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`; anything else is `400 { "error": "reasoning must be one of ..." }`, and a level above the operator cap `maxReasoning` is `400 { "error": "reasoning <level> is above the allowed maximum <cap>" }` (see Models). Omitted, the session gets the settings default (none stored when there is none). `repo` (`owner/name` on github.com) and `branch` (optional) give the session a cloned repository workspace, see `docs/repo-workspace.md`; a bad value is `400` (a branch follows git's ref-name rules, e.g. no path component ends in `.lock`) and `branch` without `repo` is `400`. The response echoes the model the session will use (and `repo`/`branch`), and the reasoning effort (`reasoning`, from `PI_MODEL_REASONING`; absent when unset). |
| `POST /sessions/{id}/events` body `{ kind, text?, sourceEventId? }` | `202 { eventId, duplicate }` | `kind` is `message`, `steer` or `cancel`. `text` is required for `message` and `steer` (at most 65,536 characters, i.e. JavaScript string length; the whole JSON body is separately limited to 128 KiB in bytes). `sourceEventId` (at most 200 characters) deduplicates. Neither may contain NUL or unpaired surrogates (Postgres cannot store them). `400` invalid body, `409` session is deleting or failed, or the id belongs to another session, `410` session deleted. |
| `GET /sessions/{id}/stream` | `200 text/event-stream` | See Streaming. `503` with `Retry-After` while the orchestrator is down, `410` for a deleted or deleting session. Ingest picks the orchestrator by the session's shard (`PI_ORCH_URL` with `{shard}`); an orchestrator of another shard answers `421`, which a client does not see. |
| `GET /sessions/{id}` | `200 { sessionId, status, model: { provider, model, reasoning? }, profile: { name, version }, skills?: [{ name, version, digest }], repoSkills?: true, repoContext?: true, repo?, failure?, createdAt, lastActivityAt, events: { pending, submitted, failed } }` | Answered from Postgres, so it works while the orchestrator is down. `skills` (only when the session's profile has skills) is the exact content the session pinned. `repoSkills: true` and `repoContext: true` are present only when the snapshot turned them on and the session has a repo. `status` is `active`, `failed`, `deleting` or `deleted`; `failure` is present only when `failed`. A session that predates per-session models reports the default model; one that predates profiles reports `profile: { name: "coding", version: 1 }`. |
| `GET /admin/settings` | `200 { defaultModel, allowlist, reasoning, maxReasoning, defaultProfile, turnBudget, tokenBudget, revision, updatedAt, updatedBy }` | Admins only (see Models and failure). `404` if the settings row is not seeded yet. |
| `PUT /admin/settings` body `{ defaultModel?, allowlist?, reasoning?, maxReasoning?, defaultProfile?, turnBudget?, tokenBudget?, expectedRevision? }` | `200`, the new settings as in GET | Admins only. Full or partial: omitted fields keep their value; `reasoning: null` clears it, `maxReasoning: null` removes the cap, and `reasoning` above `maxReasoning` is `400`. `defaultModel` is `provider/model`, `allowlist` an array of them (at most 100; the default is always allowed and put first), `reasoning` one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `null`, `defaultProfile` the name of an existing profile that is enabled for new sessions (else `400`; checked inside the write transaction, see Concurrent admin edits), `turnBudget` an integer from 1 to 1000000, `tokenBudget` an integer from 1 to 1000000000000 or `null` for no limit (the default; ADR 0028). A bad value or an unknown key is `400` and changes nothing. While a model catalog is published (`GET /admin/models`), a `defaultModel` or an `allowlist` entry that this write adds and that is not in it is `400 { "error": "defaultModel \"<p/m>\" is not in the model catalog" }` (or `allowlist entry ...`); entries kept from the stored value are not re-checked, and without a catalog nothing is checked. A `credential` of `missing` never refuses a model. `expectedRevision` that is not the stored `revision` is `409` and changes nothing. Writes a history entry and notifies the other processes. |
| `GET /admin/settings/history` (`?limit=`, default 50, at most 500) | `200 { history: [{ id, changedAt, changedBy, old, new }] }` | Admins only. Newest first; `old` is null for the seed. |
| `GET /admin/profiles` | `200 { defaultProfile, profiles: [{ name, currentVersion, revision, enabledForNew, definition, createdAt, createdBy, updatedAt, updatedBy }], invalid: [{ name, message }] }` | Admins only. Every profile at its current version. `invalid` lists profiles whose current version fails validation (edited by hand); they cannot be chosen. |
| `GET /admin/profiles/{name}` | `200`, the profile as above plus `versions: [{ version, definition, createdAt, createdBy }]`, newest first | Admins only. `404` if there is none. |
| `GET /admin/models` (`?all=1`) | `200 { models: [{ provider, id, name?, reasoning, contextWindow?, maxTokens? }], providers: [{ provider, credential }], source, filtered, credentials?, reason? }` | Admins only; other query keys are ignored. The model catalog the orchestrator published at its start (`source: "orchestrator"`). The full catalog is about 1,650 models and 240 KB, so the default view never returns a big list: only the providers whose `credential` is `"configured"`, with `filtered: true`, and never `scripted` (a test provider for CI, e2e and the quickstart; writes naming it still pass validation). `credentials` says what an empty or short list means: `"configured"` (at least one provider is), `"none-configured"` (OneCLI was checked and holds no model credential: `models: []`, `providers: []`), or `"unknown"` with a `reason` (OneCLI could not be checked: no admin key, or listing the secrets failed; `models: []`). `?all=1` returns the full catalog with `filtered: false`, `scripted` included, and no `credentials`. Before an orchestrator that publishes the catalog ever started: `{ models: [], providers: [], source: "none", filtered: false, credentials: "unknown", reason }`. `reasoning` says whether the model supports thinking levels. `credential` per provider is `"configured"` (an OneCLI secret's host pattern covers the provider's base host, or, for `openai-codex`, `PI_CODEX_ACCOUNT_ID` is set, or the provider is `scripted`), `"missing"` or `"unknown"`. It is a hint, not proof: the key may be invalid or the agent may lack the grant, and only a first turn proves it. It is read at the orchestrator's start only. |
| `GET /admin/tools` | `200 { tools: [name], source }` | Admins only. The tool names a profile's `tools`, `modelTools` and skill checks accept: what the orchestrator published at its start (`source: "orchestrator"`), or the built-in names before it ever started (`"builtin"`). |
| `PUT /admin/profiles/{name}` body `{ definition?, enabledForNew?, expectedRevision? }` | `201` for a new profile, `200` after; the profile as in GET plus `versionCreated` | Admins only. A create needs `definition`. A `definition` that differs from the current one is written as the next version (versions are immutable); an identical one writes nothing. `enabledForNew` (default true on create) only decides whether new sessions may choose the profile; it never affects existing sessions and is not versioned. A bad definition, an unknown key, a tool that is not installed, an MCP server that is not in the catalog or (while a model catalog is published) a `defaultModel` that is not in it is `400` and changes nothing. Disabling the profile that is the settings' `defaultProfile` is `409` (select another enabled default first). `expectedRevision` that is not the stored `revision` (enable and disable count, they add no version) is `409` and changes nothing. To remove a profile, disable it, then `DELETE` it (below). |
| `GET /admin/skills` | `200 { skills: [{ name, currentVersion, digest, description, disableModelInvocation, createdAt, createdBy, updatedAt, updatedBy }] }` | Admins only. Every skill at its current version. |
| `GET /admin/skills/{name}` | `200 { name, currentVersion, versions: [{ name, version, digest, description, disableModelInvocation, size, files: [{ path, size, sha256, executable }], source, createdAt, createdBy }] }`, newest first | Admins only. `404` if there is none. |
| `POST /admin/skills/{name}/versions` body `{ files: [{ path, content \| contentBase64, executable? }], source? }` | `201` for a new version, `200` when the content is identical to the current version (nothing written); the version as in GET plus `versionCreated` | Admins only; the body may be up to about 7 MiB. `files` must include `SKILL.md`, which starts with a YAML frontmatter block that gives the `description` (see Skills); there is no separate `description` field (sending one is `400`). A bad name, a frontmatter that is missing, malformed, without a non-empty `description` or with a `name` that differs from `{name}`, traversal or absolute path, duplicate path, field that is not `path`/`content`/`contentBase64`/`executable` (so no symlinks, devices or modes), NUL or unpaired surrogate in text, or a limit exceeded (see Skills) is `400` and writes nothing. `source` is optional (see Reserved `source`); it is not part of the digest, so identical files with another `source` are `200`, write nothing and keep the stored version's `source`. |
| `GET /admin/skills/{name}/versions/{v}` (`?content=true`) | `200`, the version as above; with `content=true` each file also has `contentBase64` | Admins only, so a skill can be reviewed like code. `404` if there is none. Versions cannot be updated or deleted one by one (`405`); `DELETE /admin/skills/{name}` removes the whole skill. |
| `GET /admin/skills/{name}/versions/{v}/zip` | `200`, `application/zip`, `attachment; filename="{name}-v{v}.zip"` | Admins only. The version's files at their paths (no top-level folder), stored without compression, each with Unix mode `0644`, or `0755` when the manifest marks it executable, so an unzip restores the executable bit and a re-upload gives the same digest. `404` if there is none; `409` if the stored bytes do not match the manifest. |
| `GET /admin/mcp-servers` | `200 { servers: [...], invalid: [{ name, message }] }` | Admins only. Every server of the MCP catalog, by name. A server is `{ name, url, transport, enabled, readOnly, timeoutMs, maxOutputBytes, onecliSecret, revision, source, reachability, createdAt, createdBy, updatedAt, updatedBy }`. `reachability` is always `"unknown"`: the API does not probe the network, and a host that is not allowed in the OneCLI rules fails only when the orchestrator connects (log `mcp-discovery-failed`). `invalid` lists rows edited by hand into something the validator rejects; the orchestrator skips them. |
| `GET /admin/mcp-servers/{name}` | `200`, one server as above | Admins only. `404` if there is none. |
| `PUT /admin/mcp-servers/{name}` body `{ url?, transport?, enabled?, readOnly?, timeoutMs?, maxOutputBytes?, onecliSecret?, source?, expectedRevision? }` | `201` for a new server, `200` for an update, the server as in GET | Admins only; creates or updates. A create needs `url` (https, no credentials) and `readOnly` (your declaration that the server is stateless and read-only: one client serves every session); `transport` is `streamable-http` (the only one), `enabled` defaults to true, `timeoutMs` to 60000 (1000 to 300000), `maxOutputBytes` to 24576 (1024 to 24576: it can only tighten the cut of the text a call returns), `onecliSecret` (a reference, never a secret; unused until #42) to null. An update lays the body over the stored row, so `{"enabled": false}` disables a server. `name` matches `^[a-z][a-z0-9-]{0,31}$`, is immutable (`history` is reserved) and becomes the tool prefix `mcp__<name>__`. A bad value, an unknown key or a `name` that differs from the path is `400` and changes nothing. `source` is optional (see Reserved `source`): omitted keeps the stored one, `null` clears it, and a change of `source` alone is a write (a new `revision`, a history entry) that changes no behaviour. `expectedRevision` that is not the stored `revision`, or any `expectedRevision` for a server that does not exist, is `409` and changes nothing. A change that alters nothing writes nothing. Writes a history entry and notifies the orchestrators. |
| `DELETE /admin/mcp-servers/{name}?expectedRevision=N` | `200 { name, deleted: true }` | Admins only. Removes the row for real (to keep it, `PUT` `enabled: false`); the history keeps the old value. See Deleting below: `409` with `blockedBy` while a profile's current version names it, and the name is never created again. `404` if there is none. |
| `DELETE /admin/profiles/{name}?expectedRevision=N` | `200 { name, deleted: true, lastVersion }` | Admins only. Removes the profile and every version. See Deleting below: `409` with `blockedBy` while it is the default or open to new sessions (disable it first). Sessions keep their snapshot. `404` if there is none. |
| `DELETE /admin/skills/{name}?expectedRevision=N` | `200 { name, deleted: true, lastVersion }` | Admins only. Removes the skill with every version and file; `expectedRevision` is the skill's current version. See Deleting below: `409` with `blockedBy` while a profile's current version or a session that is not deleted pins it. `404` if there is none. Single versions cannot be deleted (`405`). |
| `GET /admin/mcp-servers/history` (`?name=`, `?limit=`, default 50, at most 500) | `200 { history: [{ id, changedAt, changedBy, name, action, old, new }] }` | Admins only. Newest first. `action` is `create`, `update` or `delete`; `old` is null for a create, `new` for a delete. |
| `DELETE /sessions/{id}` | `202 { sessionId, status }` | Idempotent. See Deletion. |
| `GET /healthz`, `GET /readyz` | `200` | Both processes. Ingest is ready when migrations succeeded and the database answers. The orchestrator is ready only once it owns the schema (the Service therefore always points at the owner). |

Status codes for authentication: `401` for a missing or wrong token. `/admin/*` answers `403` to an authenticated caller whose owner is not listed in `PI_API_ADMINS` on ingest (comma-separated owner names from `PI_API_TOKENS`, whose tokens must be unique across owners: both processes refuse to start otherwise; empty or unset means nobody). `404` when the session does not exist **or
belongs to another owner**: the two look the same, so the API does not reveal that a session exists.

### Concurrent admin edits

ADR 0023. Settings, each profile and each MCP server have a `revision`: an integer that starts at 1 and goes up by one with
every write that changes something (a new profile version, enable or disable, an MCP `source` change). A no-op write leaves
it. A write may send `expectedRevision`: a stored resource at another revision answers `409 { error }` and changes nothing,
so an editor that loaded revision 3 cannot overwrite a revision 4 it never saw. Omitted, the write behaves as before (last
writer wins). `expectedRevision` must be a positive integer (else `400`) and is taken out of the body before the other keys
are checked, so an unknown key is still `400`. A revision starts again at 1 when a deleted MCP server is created again, so
it does not protect a draft across a delete and re-create.

The default profile is checked inside the write transaction, under one advisory lock shared by `PUT /admin/settings` and the
profile writes that disable a profile. Selecting a `defaultProfile` that does not exist or is disabled stays `400` (a bad
value). Disabling the current default profile is `409` ("select another enabled profile as the default first"): the body is
valid, the stored state refuses it. Concurrent "select X as the default" and "disable X" therefore never leave a disabled or
missing default; one of them gets the error.

### Reserved `source`

A skill version and an MCP server accept an optional `source: { repository, commit }` and return it (`null` when none).
`repository` is 1 to 200 characters without whitespace or control characters; `commit` is lowercase hex, 7 to 64
characters; any other key is `400`. It is reserved for the future catalog repository sync (see the
[admin UI plan](admin-ui-plan.md#later-a-catalog-repository)): stored and returned, never part of a skill's digest, and
nothing acts on it. A skill version is immutable, so its `source` is set when it is created.

`DELETE` is also an inbox row (kind `delete`). `POST .../events` with `kind: "delete"` is refused; use `DELETE`.

### Admin console

`GET` and `HEAD` of `/console` and `/console/*` return the static admin console (`packages/admin-ui`, see the
[plan](admin-ui-plan.md)). They are answered before the bearer gate and before the schema check, because the page holds
no secret: the operator's token goes from the browser to `/admin/*` only. Other methods are `405`.

- Screens (slice 2): global settings and session profiles. Both send `expectedRevision` on every write and keep the draft on
  a `409`, with reload and compare. The profile editor reads `GET /admin/tools`, `/admin/mcp-servers` and `/admin/skills`, and
  previews what a new session would get with the session-creation rules (allowlist with the default model, then profile,
  then settings; no caller overrides) before saving.
- Served only when `PI_CONSOLE_DIR` names the built bundle (the chart sets `/app/console` with `console.enabled`, default
  off). Otherwise every console path is `404`.
- `/console` redirects (`308`) to `/console/`. A path with a file extension is an asset: it is served from the directory
  or is `404`, never `index.html`. Any other path under `/console/` is a client-side route and gets `index.html`. A path
  that would leave the directory (`..`, a NUL or a backslash, also percent-encoded) is `404`.
- `GET /console/config.json` is answered by ingest, never from a file, with `{ "catalogs": "manage" | "readOnly" }` (from
  `PI_CONSOLE_CATALOGS`, the chart's `console.catalogs`; default `manage`; any other value stops ingest at start). It holds no
  secret and needs no token. `readOnly` hides the write controls of the Skills and MCP servers screens and nothing more:
  the admin API accepts writes from any admin either way.
- Console responses and every `/admin/*` response, including `401`, `403` and errors, carry `Cache-Control: no-store`,
  `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. The console contains no inline script or style.
- Reach it by port-forward or a route restricted to operators; ingest does not rate-limit failed sign-ins
  ([chart README](../charts/pi-durable/README.md#admin-console)).

## Event lifecycle

1. Ingest inserts a row into `inbox.events` (`status = pending`) and returns `202`. A trigger sends
   `NOTIFY inbox_events`.
2. The orchestrator wakes on the notification (and on a 1 s poll as the safety net), and per session opens a
   transaction that claims that session's oldest pending rows with `FOR UPDATE SKIP LOCKED`, up to 20 at a time,
   ordered by `(created_at, id)`.
3. For each row, in order, it submits to Pi Durable with `requestId = <row id>`:
   - `message`: `whenBusy: "followUp"`. On an idle session it starts a turn; on a busy one it queues behind the
     running turn in Pi Durable's own inbox and starts the next turn when the current one answers. When the running
     turn fails instead (a model error, the turn limit), the messages queued behind it are withdrawn: they never run,
     the stream's `live.runFailure` says why, and the client sends them again if it still wants them
     ([ADR 0029](decisions/0029-run-outcomes-from-wait.md)).
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

A stream lasts only as long as one connection, never as long as the session: proxies, restarts and networks end it.
Clients reconnect with `Last-Event-ID` and lose nothing. Behind a gateway, give the stream path no total request
timeout (the chart's `ingest.httpRoute` does, see [ADR 0026](decisions/0026-ingest-routes.md)); the keepalive every
15 s keeps idle timeouts from closing a live stream.

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
  `hack/gen-api-secret.sh`; it never prints the tokens). Tokens are compared in constant time. A token must be at least 16 characters with no whitespace (it could not be sent in a bearer header); a bad entry stops the process at start with an error that does not print the token.
- The owner is stored on the session at creation and checked on every call (ingest) and again on the stream
  (orchestrator). A token of another owner gets `404`.
- Test setup creates two owners, `alice` and `bob`.

## Models and failure

- **Selection.** The default model, the allowlist (`provider/model` pairs; the model id may contain slashes; the
  default is always allowed), the default reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or none), an optional cap on the effort a request may ask for (`maxReasoning`, same levels, or none; `009_reasoning_cap.sql`)
  and the turn budget are stored in Postgres (`inbox.settings`, one row; `inbox.settings_history` is the append-only
  log of changes with who, when, old and new; migration `006_settings.sql`, `docs/decisions/0008-settings-in-postgres.md`).
  Ingest and the orchestrator read them through a `SettingsCache` that loads at start, refreshes on `LISTEN pi_settings`
  (the writer sends `pg_notify` in the same transaction) and on a 30 s poll; an unreadable or invalid row keeps the last
  good value and logs. A change is therefore live in seconds on every replica, no restart. The write path is
  `PUT /admin/settings` (above). **Seeding:** the first ingest to start inserts the row from the environment
  (`PI_MODEL_PROVIDER`, `PI_MODEL_ID`, `PI_MODEL_ALLOWLIST`, `PI_MODEL_REASONING`, `PI_SESSION_TURN_BUDGET`, ConfigMap
  `pi-model-config`; `insert ... on conflict do nothing`, so two replicas are safe). After that the table wins and a
  differing environment logs `settings-env-ignored` once at ingest start. The committed seed is OpenAI Codex
  `gpt-6.1-terra` (`gpt-6.1-sol` is allowlisted too, and the scripted models, which the e2e suites select through
  `PUT /admin/settings` and restore afterwards). With an OneCLI token the orchestrator installs every built-in provider at start, whatever
  the allowlist says, so adding a built-in provider through settings needs no restart. Without a token it installs only the
  allowlisted providers, and a provider the orchestrator code does not ship needs a new release.
- **Storage.** The chosen model is stored with the session (`inbox.sessions.model_provider`, `model_id`, `model_reasoning`; migrations
  `002_models.sql`, `003_reasoning.sql`), so changing the default later does not change existing sessions. The orchestrator creates the Pi
  conversation with it; Pi Durable keeps it in the conversation across restarts (`docs/model-credentials.md`).
- **Per-session reasoning.** `POST /sessions` may carry `reasoning`; the levels are pi-ai 1.5.2's `off` plus its thinking
  levels, ordered `off < minimal < low < medium < high < xhigh < max`. The request wins over the settings default, and
  `maxReasoning` caps it (a default above the cap cannot be stored). Ingest does **not** check that the chosen model
  supports reasoning: it has no model catalog (pi-ai lives in the orchestrator, and ingest must not depend across that
  layer). For a model without reasoning the provider layer ignores or clamps the level (`docs/model-credentials.md`), so
  the stored value is the request, not a guarantee of effect. Revisit if an operator needs that refused at the API.
- **`failed` is terminal.** A model error that reads as rejected credentials (401, 403 or 407 from the provider or
  the OneCLI gateway), or a session that used up its turn budget (the `turnBudget` setting, model turns in total, read before every input) or its token budget (the `tokenBudget` setting, tokens in total from Pi Durable's `pi.usage`, read before every input; ADR 0028),
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
- The relay processes (one small Node process per session with a sandbox, `node:net` only; the SDK and the sandboxd token
  live in the orchestrator's in-process broker, see `docs/decisions/0016-in-process-broker.md`) are started through
  `/usr/bin/env -i` (`bridgeCommand` in `bridge-launcher.ts`), which gives them only `PATH`, `HOME`, `TZ`, `LANG` and
  `NODE_OPTIONS`. The sandboxd token (derived per claim from the master key; see
  `docs/decisions/0001-per-sandbox-sandboxd-token.md`), the database URL, the API tokens, the OneCLI agent token and the
  sandbox master key are not in their argv or environment (checked by the e2e suite in `/proc/<pid>/environ`).
- An existing claim is adopted only if its `SANDBOXD_AUTH_TOKEN_SHA256` env matches the token hash the orchestrator
  derives for it. A claim from before per-sandbox tokens (or after a master rotation) is refused with an error that
  says to delete the claim and its PVC.
- Every Pi Durable submission carries `requestId = <inbox row id>`: `SubmissionDraft.requestId` is part of the
  1.5.2 type of `Conversation.submit()`, and its README documents that a repeated `requestId` returns the existing
  submission. Test 4 exercises it.
- Idle bridges are closed after 2 minutes (`PI_SANDBOX_IDLE_EVICT_SECONDS`) and reopened by the next tool call (the
  orchestrator was OOM-killed at 512 Mi with about ten bridges otherwise; its limit is now 2 Gi: 1 Gi was also OOM-killed by the parallel lifecycle e2e tests).
- Per-turn timings (`turn-timing`) and bridge memory (`bridge-rss`, every `PI_BRIDGE_RSS_INTERVAL_SECONDS`, default 60,
  0 = off) are logged as described in `docs/metrics.md`.
- Open bridges are capped at `PI_MAX_OPEN_BRIDGES` (default derived from the memory limit, 74 at 2Gi; `docs/scaling.md`): a new open evicts the least recently used idle env, or waits
  in a FIFO queue when all are in use. `docs/decisions/0004-idle-suspend.md`.
- **Idle suspend.** A sandbox with no call for 30 minutes (`PI_SANDBOX_IDLE_SUSPEND_SECONDS`, 0 = never; not below the
  eviction age) is suspended: `Sandbox.spec.operatingMode: Suspended` deletes the Pod and keeps the Sandbox, the claim
  and the PVC. The next tool call resumes it (about 15 s) and sees the old workspace. `docs/decisions/0004-idle-suspend.md`.
- **Interrupted commands.** A command that was aborted (cancel, steer), timed out, or was running when the orchestrator
  died gets its sandbox Pod replaced (the claim and PVC stay), because a `setsid` child escapes the process-group kill.
  The next tool call waits for the new Pod. `docs/decisions/0003-recycle-pod-on-interrupt.md`.

- `POST /sessions` only inserts `inbox.sessions`. The orchestrator creates the Pi conversation on the first event or
  stream (`inbox.sessions.conversation_id`) and the SandboxClaim `pi-conv-<conversation id>` lazily at the first tool
  call, through the Harness `env` callback, as before. A session that only chats never gets a sandbox or a PVC. A
  repository session is the exception: `prepare` provisions the sandbox and clones before the first input is submitted.
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
`PI_SWEEP_INTERVAL_SECONDS` (300; 0 = off; every seconds setting is at most 2147483, a larger one is refused at start) it removes SandboxClaims `pi-conv-<n>` (`pi-s<k>-conv-<n>` on shard k; each shard sweeps its own) labelled with a session UUID, workspace
PVCs `workspace-pi-conv-<n>` without a claim, and OneCLI agents `<prefix><uuid>` (`PI_ONECLI_NAME_PREFIX`, default `pi-session-`) with their secrets, when the session
is `deleted` or has no row, and the object is older than `PI_SWEEP_GRACE_SECONDS` (600). At most `PI_SWEEP_MAX_ACTIONS`
(10) per run; each action is one `sweep-action` log line. Unlabelled claims, `control-<n>` labels and every other name are
never touched, and neither is a session that is `active`, `failed` or `deleting`, even when its sandbox can no longer work.

## Test-only surface

The orchestrator still has the Phase 3 scripted-session surface, now under `/control/...`, behind the same bearer
token, and only when `PI_ORCH_CONTROL=1` (the production manifest leaves it unset; the e2e run sets it through `tests/e2e/chart-values.py` (`orchestrator.extraEnv`) so `tests/e2e/run-phase3.sh` keeps running). It
bypasses the inbox. `PI_ORCH_TEST_FAULTS=1` makes the orchestrator honour `payload.testFault` on an inbox row, which
only SQL can write; the Phase 4 crash test uses it to exit between submit and mark.

## Deployment

- `hack/install.sh` creates `api-auth` (`hack/gen-api-secret.sh` does the same on its own). The chart's `templates/ingest/` is the
  2-replica Deployment (250m / 256Mi limits each) and Service `pi-ingest`.
- **Image delivery:** ingest and orchestrator run multi-arch application images built by `images/build.sh`.
  Dependencies and session-core migrations are packaged at build time; no runtime code volumes or unpack containers.
  See [image builds](../images/README.md) and the chart's image values for digest overrides.
- The inbox schema is `packages/session-core/migrations/*.sql` (`001_inbox.sql` to `014_shard.sql`, which adds `inbox.sessions.shard`; `008_profiles.sql` adds the profile tables, `010_skills.sql` the skill tables), applied
  in order by both processes at start. Each applied file is recorded in `inbox.schema_migrations`; when all are
  recorded the start issues one SELECT, no lock and no DDL. Missing files run idempotently under an advisory lock
  and `lock_timeout = 3s` (a blocked migration fails and is retried, it never queues ahead of traffic). The first
  start after this table was introduced re-runs the idempotent files once to record them
  (`docs/decisions/0005-migrations-without-ddl-locks.md`). After migration 002 an older ingest or orchestrator still
  runs but does not know the `failed` status or the model columns.
- Probes: ingest serves `/healthz` as soon as the process is up and `503`s `/readyz` and the API until migrations
  succeeded (then ready means the database answers). The orchestrator listens before it migrates; its `/readyz` is
  owner-only.
- The chart's `models` values (ConfigMap `pi-model-config`) is the settings seed (ingest) and the orchestrator's provider
  list and fallback; `PI_CONSOLE_DIR` (set only with `console.enabled`) names the console bundle and `PI_CONSOLE_CATALOGS` (`console.catalogs`, `manage` or `readOnly`) its catalog mode; `PI_API_ADMINS` (plain env on ingest, `alice`) names the admin owners. The orchestrator also takes the
  OneCLI agent token and CA (`docs/model-credentials.md`).

## Known limits

- One orchestrator replica per shard: the Pi Durable storage allows one owner per schema. Capacity grows by adding shards
  (`orchestrator.shards` in the chart, which sets `PI_ORCH_SHARDS` at ingest; a session never moves), see ADR 0017 and `docs/scaling.md`.
- Conversation state of deleted sessions stays until the maintenance job.
- A crash between creating a Pi conversation and storing its id in `inbox.sessions` leaves one empty, unreferenced
  conversation.
- A steer posted when the session is idle starts a turn (it is not dropped or rejected).
- `live` events are best effort, not cursor-addressable (see Reconnect semantics).
- Backpressure: a slow SSE client delays its own watch only; Pi Durable folds commits meanwhile.
- No rate limits, quotas, per-token scopes, or CORS. Plaintext HTTP inside the cluster. NetworkPolicy and CiliumNetworkPolicy
  limit which pods can reach ingest and the orchestrator (`docs/network-policy.md`); the bearer token is the control beyond that.
- `GET /sessions/{id}` reports inbox counts and last activity, not whether a turn is running; the stream's `live`
  event does.

## MCP server catalog

Remote MCP servers (ADR 0007) are managed at runtime through `/admin/mcp-servers` (table above; ADR 0009); there is no
`PI_MCP_SERVERS` any more. The orchestrator reloads the catalog on `LISTEN pi_mcp_servers` (and a 30 s poll), so a change
takes effect without a restart:

- A server that is added or enabled gets its `mcp-<name>` extension. Its tools are listed in the background; until that
  works, calls to them settle `tool_unavailable`.
- A server that is disabled or deleted loses its extension: a new call to one of its tools settles `tool_unavailable`.
  Calls that already run finish, and then the client is closed.
- A server whose row changed (url, limits, anything) gets a new client and its tools are listed again; a tool whose
  input schema changed is logged as `mcp-schema-changed`.
- Which sessions get which servers: only those whose profile names them (`mcpServers`, see Session profiles). A profile
  that names a server gets `tool_search` and that server's tools; a session whose profile names none (the default
  `coding` profile) gets neither. A server that is missing or disabled when the session is created is not an error: its
  tools are `tool_unavailable` until it is enabled. The orchestrator's `ONECLI_AGENT_TOKEN` and the host rule are
  still needed: a row never opens egress (`docs/onecli-host-rules.md`).

## Session profiles

A profile (ADR 0010) is a named, versioned definition of what a session gets, edited through `/admin/profiles` and chosen
with `profile` on `POST /sessions`. A definition is a JSON object whose fields are all optional:

| Field | Meaning | Absent means |
| --- | --- | --- |
| `tools` | coding tools enabled for the session (a subset of the installed ones: `read`, `write`, `edit`, `bash`) | all |
| `modelTools` | of those, the tools offered to the model (a subset of `tools`) | all enabled |
| `instructions` | text added to the system prompt (at most 8000 characters) | none |
| `defaultModel`, `reasoning` | the model and effort when the request names none; checked against the allowlist and `maxReasoning` at creation | the settings' |
| `turnBudget` | model turns the session may use in total; replaces the settings' budget for it | the settings' |
| `mcpServers` | names of MCP catalog servers; the session gets `tool_search` and their tools | no MCP |
| `skills` | `[{ name, version }]`: exact skill versions (at most 20); see Skills | none |
| `repoContext` | `true`: add the repo's `AGENTS.md` / `CLAUDE.md` to the session's instructions as project instructions; see Repo context (ignored without a repo) | off |
| `repoSkills` | `true`: add the skills found in the session's cloned repo to its catalog; see Repo skills (needs `read`; ignored without a repo) | off |

- **Versions and snapshots.** Every changed `PUT` is the next version of the profile. A session stores the name, the
  version and the resolved definition when it is created (`inbox.sessions.profile_*`); the orchestrator uses that
  snapshot only, so editing or disabling a profile never changes a session that exists, running or resumed. A session
  created before profiles runs as `coding` version 1.
- **`coding` version 1** is seeded by migration `008_profiles.sql` (and, only while it is still that seed, migration `012` writes version 2, `{ "repoSkills": true }`, and `013` version 3, which adds `"repoContext": true`) with the empty definition: every coding tool, no extra
  instructions, the settings' model, reasoning and turn budget, **and no MCP server**. (Before profiles a new session got
  every enabled server; to restore that, add the servers to `coding`.)
- **Two states.** `enabledForNew` is whether a new session may choose the profile; a stored snapshot stays valid either
  way. A profile that is missing, disabled or invalid is refused, never replaced by a more permissive one.
- **Names are checked when written.** Tools against what the orchestrator published at its start
  (`inbox.orchestrator_capabilities`; before it ever started, the four built-in names), MCP servers against the catalog.
  A stored profile whose tool later stops existing is logged by the orchestrator at start (`profile-unresolved`); its
  sessions have fewer tools, never more.
- **Deleted only when unused.** A profile closed to new sessions that is not the default can be deleted with all its
  versions; sessions keep their snapshot. See Deleting below.

### Deleting profiles, skills and MCP servers

[ADR 0027](decisions/0027-admin-delete.md). A `DELETE` removes the rows and needs `?expectedRevision=N` (`400`
without it; for a skill, its current version). It is refused with `409 { error, blockedBy }` while anything live
refers to it: `blockedBy` has `profiles: [{ name, version }]` (current versions that pin or name it),
`sessions: { count, sample }` (sessions that are not deleted and pin the skill, at most five ids), `defaultProfile: true`
or `enabledForNew: true`. There is no force and no cascade. A deleted name is never used again: a create under it is
`409`, and a profile publish naming a deleted MCP server is `400`. `POST /sessions` answers `409` ("retry") when the
profile got a new version, was closed or deleted while the session was being created.

## Skills

A skill (ADR 0011) is an Agent-Skills-style folder: a `SKILL.md` plus optional scripts and resources, which the model
loads on demand. Skills are stored in Postgres as immutable, numbered versions and are selected only by profiles
(`skills: [{ name, version }]`); nothing about a skill reaches a session whose profile does not name it.

- **A version** is a `SKILL.md` (at most 32 KiB, UTF-8) whose frontmatter gives the description, up to 128 files and
  5 MiB (all sizes in bytes), and a SHA-256 `digest` of its name, description and files (path, content hash, executable bit). A path is relative with
  plain segments (`[A-Za-z0-9_][A-Za-z0-9._-]*`, at most 200 characters): no `..`, no absolute path, no hidden file, no
  duplicates (also by case). Only regular files can be published. Names match `[a-z][a-z0-9-]{0,63}`. A profile names
  at most 20 skills, and the catalog they add must fit in 32 KiB. A profile that names skills must keep the `read` tool
  (in `tools` and `modelTools` when given): the admin write is `400` otherwise, and tools are never widened silently.
- **Frontmatter.** The admin store reads `SKILL.md` as a repo would (#71 reuses the same parser), so a skill folder is
  the same in both. `SKILL.md` starts with a block between two `---` lines of flat `key: value` lines; values are plain
  or quoted (`"..."` with `\n \t \" \\ \uXXXX`, `'...'` with `''`) single-line strings, and `#` starts a comment. Not
  supported, and `400`: nesting, lists, `|` and `>` blocks, anchors and tags, a repeated key, a block over 100 lines or
  8 KiB. Keys: `description` (required, non-empty, one line, at most 1024 characters, no control characters),
  `name` (optional; when present it must equal `{name}` of the URL, else `400`; absent, the URL's is used) and
  `disable-model-invocation` (`true` or `false`; with `true` the version is kept out of the catalog, though it can still
  be pinned and is still written to the sandbox). Other keys are ignored but still must parse. The digest covers the
  whole file, so what the model sees is in it.
- **Pinning.** A profile write checks that every named version exists and stores its `digest` next to `name` and
  `version`. A session snapshots that definition, so publishing v2 of a skill changes neither the profile (still v1)
  nor any session; to adopt v2, write a new profile version naming it, which only new sessions use.
- **In the prompt.** At creation the orchestrator appends a catalog to the conversation's instructions (after the
  profile's own `instructions`) in Pi's wording: the model is told to use the read tool to load a skill's file when a
  task matches its description and to resolve relative paths against the skill's directory, followed by an
  `<available_skills>` block with, per skill, `<name>`, `<description>` and `<location>` (the absolute sandbox path
  `/workspace/.skills/<name>/<digest>/SKILL.md`), XML-escaped. Skills with `disable-model-invocation: true` are not
  listed, and a profile whose skills are all of that kind adds no catalog. Bodies are never in the prompt. The text is stored with the conversation, so it never changes.
- **In the sandbox.** When a session's sandbox env opens (the first tool call, and again after a suspend, a Pod recycle,
  an eviction or an orchestrator restart), the orchestrator writes the pinned files to
  `/workspace/.skills/<name>/<digest>/` before the env serves its first operation; concurrent first calls wait for it.
  Files are staged in `/workspace/.skills/.staging` and renamed into place, so a skill directory exists only complete
  and a repeat attach writes nothing. Postgres is the source of truth and the workspace a cache. The bytes are verified
  against their hashes and the pinned digest first; a corrupt, missing or changed bundle fails the tool call (closed),
  and a session whose conversation cannot be created that way fails its input for good. A session that never calls a
  tool never opens a sandbox. Files marked `executable` are `chmod 755`; others run through their interpreter.
- **Security.** Only admins publish (and every publish is logged `skill-published` with the author and digest). A
  skill's description and body are model input: review them like code (`?content=true`). The workspace volume is
  writable by the agent, so it is a cache and not an immutable boundary; the next attach does not repair a directory
  that already exists.

### Repo skills

With `repoSkills: true` (ADR 0014; on in `coding` from version 2) a repo session also gets the skills of its clone:
`/workspace/repo/.pi/skills/**/SKILL.md` and `/workspace/repo/.agents/skills/**/SKILL.md`, read through the sandbox,
with the frontmatter rules above (`description` required, `name` defaults to the directory, `disable-model-invocation`
honoured; an invalid file is skipped and logged as `repo-skill-skipped`). Their `<location>` is the path in the repo.

- **One catalog.** The instructions become the profile's `instructions` followed by one `<available_skills>` block: the
  pinned (admin) skills first, which win a name collision, then the repo's. Together at most 20 skills and 32 KiB.
- **When.** After the clone, and again for each new message or steer of the session, but only while its sandbox is
  already open: a suspended sandbox is never resumed for this, and a message to it keeps the last catalog. A restart
  rescans at the next message. A skill added to the checkout shows up at the next message while the sandbox is open.
  No watcher, no per-request scan. Unchanged text writes nothing; a scan that fails is logged and leaves the
  instructions as they were.
- **Not pinned.** The repo's skills are whatever the checkout holds, unlike a pinned skill. They are not copied.

### Repo context

With `repoContext: true` (ADR 0015; on in `coding` from version 3) a repo session's instructions also carry the repo's own
context file: the first regular file of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` in
`/workspace/repo` (the root only; a symlink or directory is passed over), as Pi renders it:
`Project-specific instructions and guidelines:` and `<project_instructions path="/workspace/repo/AGENTS.md">...</project_instructions>`.
A file over 32 KiB is cut at a character boundary with a note, and one over 1 MiB is skipped (both logged). The order is the
profile's `instructions`, the project instructions, then the skills catalog (Pi's order). It is read in the same pass, at the same
times and under the same rules as repo skills (after the clone and at each new message while the sandbox is open; unchanged text
writes nothing; a failure keeps the instructions), and needs no `read` tool.

## Isolation status (admins only)

`GET /admin/status` uses the same bearer authentication and `PI_API_ADMINS` allowlist as the other admin routes
(401 without authentication, 403 for non-admins). It reads Postgres only; ingest has no Kubernetes access.

```json
{
  "shards": [
    {
      "shard": 0,
      "configuredRuntime": "gvisor",
      "observedRuntime": null,
      "networkPolicy": "enforced",
      "networkPolicyCheckedAt": "2026-11-17T00:00:05.000Z",
      "networkPolicyDetail": {
        "state": "enforced",
        "reason": "every verified denied target was blocked",
        "controls": { "dns": true, "allowedTcp": true },
        "targets": [
          { "name": "postgres", "address": "10.0.0.5:5432", "verdict": "blocked", "outcome": "timeout" }
        ]
      },
      "updatedAt": "2026-11-17T00:00:00.000Z"
    }
  ],
  "networkPolicy": {
    "state": "enforced",
    "checkedAt": "2026-11-17T00:00:05.000Z",
    "detail": { "state": "enforced", "reason": "..." }
  }
}
```

Rows are ordered by shard. An empty list means no shard has published status yet, not verified isolation.
Each orchestrator publishes after acquiring its shard's ownership lock. At every start it resolves the configured
SandboxWarmPool's SandboxTemplate and checks `spec.podTemplate.spec.runtimeClassName` directly, so editing the
manifest cannot bypass the guard via a stale duplicate environment value. Anything other than exactly `gvisor`
(including absent/empty, reported as `""`) refuses startup unless `PI_ALLOW_INSECURE_RUNTIME=1`; an override emits a
prominent structured warning on every start. RBAC grants `get` on pools and templates.

`observedRuntime` resets to null at start, then records the latest attached sandbox Pod's `spec.runtimeClassName`
(empty string means the node default). The claim's resolved Sandbox and Pod-name annotation identify that Pod,
including warm-pool allocations. This is the latest observation, not a guarantee that every existing sandbox has the
configured runtime; template changes do not update existing sandboxes (ADR 0019).
`networkPolicy` is `unknown` until the isolation probe has run, `running` while it does, then `enforced`,
`not-enforced` or `inconclusive` ([network policy](network-policy.md#isolation-probe)). Only shard 0's orchestrator
measures it (the policies are namespace-wide), so every shard row shows shard 0's value, and `networkPolicyCheckedAt`
and `networkPolicyDetail` (what it tried, why) are set on shard 0's row only. The top-level `networkPolicy` object is
the same state, time and detail in one place. A restart resets it to `unknown` until the next run. Neither a configured
runtime nor an unknown or `inconclusive` policy proves network isolation; `not-enforced` means a sandbox can reach cluster
services. The probe only reports: nothing is blocked. `updatedAt`
is the last start/attach write, not a heartbeat; rows persist through downtime and may be stale.
The new `inbox.shard_status` migration uses the recorded-migration mechanism (ADR 0005), so current-schema restarts
perform no DDL. `GET /admin/status` is read-only (405 for other methods).

`POST /admin/status/probe` (admin only, no body) asks shard 0's orchestrator to run the isolation probe again, for
example after a CNI or policy change. Ingest only records the request in Postgres; the orchestrator picks it up within
about 5 s and the probe takes seconds to about a minute (longer with an image pull). Answers: `202 {"requested": true,
"state": "requested"}`; `202 {"requested": false, "state": "running"}` while a run is in progress (no second run is
queued); `503` before shard 0 has published a status row. Poll `GET /admin/status` until `networkPolicy.state` is no
longer `running` and `checkedAt` is new.
