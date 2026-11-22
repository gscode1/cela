# 0031: An MCP adapter lets coding agents use sessions, polling first, MCP tasks later

Status: accepted, 2026-11-17 (issue #158), amended 2026-11-18 after review. Implementation: issue #195.

**Amended by [ADR 0050](0050-mcp-admin-mode.md):** opt-in admin tools may call `/admin/*`. **Amended 2026-11-20** (issue #342): see Amendment below. The per-event outcome tasks mode waits for exists since issue #364 ([ADR 0058](0058-input-outcome-and-owner-feed.md)).

## Context

Coding agents (Claude Code, Codex, OpenCode, Cursor, Goose, ...) all speak MCP. If pi-durable has an MCP server, one of them
can hand a task to a durable session with a sandbox and a repository workspace (`docs/repo-workspace.md`: the agent pushes a
branch and can open a PR) and collect the result, with no HTTP glue of its own.

The difficulty is time. One agent turn takes minutes, sometimes longer, and MCP clients time out a `tools/call` far sooner. A
tool that blocks until the turn ends loses its result on that timeout.

The MCP specification 2026-07-28 addresses this with the Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663):

- A client that supports it says so on every request, in
  `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`.
- The server may then answer `tools/call` with a task handle (`resultType: "task"`, `taskId`, `status`, `ttlMs`,
  `pollIntervalMs`). The client polls `tasks/get`, which carries the result once `completed`, and can call `tasks/cancel`.
- A server must not return a task to a client that did not declare the extension.

It replaces the experimental tasks of 2025-11-25 (SEP-1686: `execution.taskSupport`, `tasks/result`, `tasks/list`) and is not
wire-compatible with them.

Support on 2026-11-17, checked against docs, changelogs and source:

- Clients: only the Claude Code CLI from v2.1.304 implements the extension. Its desktop app and VS Code extension do not. For
  Codex, OpenCode, Goose, Copilot, Gemini CLI and Cline nothing shows support. Several of them speak the 2026-07-28 core.
- SDKs: neither the TypeScript SDK (`@modelcontextprotocol/server`/`client` 2.4.0; typescript-sdk#2189 and PR #2782 open)
  nor the Python SDK (2.3.0, marked "deferred") implements it.

## Decision

- **A session-API client, nothing more.** The adapter calls ingest over HTTP with the caller's bearer token, exactly as any
  other client does. It has no database access, holds no model or GitHub credential, and adds no orchestrator code path.
  Ownership stays where it is: ingest checks the token's owner on every call, so one user's adapter cannot see another's
  sessions.
- **User tokens only, no admin tools.** Settings, profiles, skills and the MCP catalog stay in the admin API and the console.
  A coding agent must not be able to widen the model allowlist or install a skill. The adapter never calls `/admin/*`, but
  that does not bound the token: an owner in `PI_API_ADMINS` can use the same token on the admin API, and a coding agent with
  a shell can read its MCP config. The adapter must therefore run with the token of a non-admin owner; the docs say so.
- **First a local stdio server.** The adapter is the package `packages/mcp`, built on the official TypeScript SDK
  (`@modelcontextprotocol/server`, pinned) and run by the coding agent as a local process. It is configured by `PI_API_URL`
  and `PI_API_TOKEN` from the environment, so it works with every MCP client and needs no cluster change. A remote endpoint
  (`/mcp` on ingest, streamable HTTP, the same bearer auth) can follow once teams want it, with its own ADR.
- **The token stays put.** `PI_API_URL` must be https unless its host is loopback. Requests use `redirect: "error"`, so the
  bearer never follows a redirect. The token never appears in a log line, an error or a tool result, and logs go to stderr
  (stdout is the MCP transport).
- **Inputs are checked before any request.** A `sessionId` comes from a model, so it must match the UUID form ingest issues
  and is URL-encoded; anything else is refused without a request, so it cannot reach another path such as `/admin`. A cursor
  is a positive safe integer; ingest would read anything else as "from the start".
- **Polling tools that work in every client.** No call blocks longer than a client timeout:

  | Tool | Session API |
  |---|---|
  | `start_session { profile?, repo?, branch? }` → `{ sessionId, ... }` | `POST /sessions` |
  | `send_message { sessionId, text, idempotencyKey? }` → `{ eventId, duplicate }` at once | `POST /sessions/{id}/events`, `kind: message`, `sourceEventId` = `mcp:<sessionId>:<key>` (at most 200 characters), so a retried call never runs the task twice |
  | `wait { sessionId, cursor?, timeoutSec? }` → `{ done, status, cursor, text, truncated, runFailure?, failure?, events }` | `GET /sessions/{id}/stream` with `Last-Event-ID: cursor` and `GET /sessions/{id}` |
  | `get_session { sessionId }` | `GET /sessions/{id}` |
  | `cancel { sessionId }` | event of kind `cancel` |
  | `delete_session { sessionId }` | `DELETE /sessions/{id}` |
  | `run_task { text, repo?, branch?, profile?, timeoutSec? }` → as `wait`, plus `sessionId` | create, send and wait in one call, sharing one deadline |

  - **When `wait` is done.** `wait` reads for at most `timeoutSec`, default 45 and at most 50. The order of reads matters,
    because the first `live` view on a new stream says idle while an inbox row may still be pending (claim poll, repository
    clone, retries):
    1. `GET /sessions/{id}`. A session that is `failed`, `deleting` or `deleted` ends the wait with its status and failure.
    2. While `events.pending` is above 0, the session is not idle, whatever the stream says. The adapter reads it again about
       every second.
    3. Only a `live` view with `running: false` and `queued: 0` that arrives on a stream connection opened after a GET with
       `pending` 0 counts as idle, and only once it has held for about 500 ms with no further entry or `live` view.
  - **What `wait` returns.** It returns the assistant text (messages with role `assistant`; tool calls are left out) of the
    entries committed after `cursor`, and a new cursor. It also returns `live.runFailure` when the last run ended without an
    answer (ADR 0029: a 429, a network error or a cancel leaves the session `active` and idle), and the `events` counts, so a
    row that failed after its attempts is visible as a rise in `events.failed` instead of looking like an empty success.
  - **The cursor never skips text.** The text is capped at 24 KiB, the same cap as a catalog MCP server's `maxOutputBytes`.
    The cursor advances only past entries returned whole. When the next entry does not fit, `wait` stops before it and
    returns `truncated: true` and `done: false`, and the next call continues from there. A single entry larger than the cap
    is returned cut, with a marker, and the cursor moves past it. A caller that has no cursor for an old session gets the
    transcript from the start, so callers should keep the cursor of their last `wait`.
  - **A timeout is not an error.** At the deadline, on a `503` from the stream (orchestrator restarting) or when the stream
    closes, `wait` and `run_task` return `done: false` with the cursor so far. A `410` or a `deleted` event ends the wait with
    the status from `GET /sessions/{id}`.
  - **`run_task` has no idempotency key.** `POST /sessions` does not deduplicate, so a key would only turn a retried call into
    a second session and a `409` on its message. `run_task` returns the `sessionId` in every result, errors after the create
    included, so the caller can continue or delete the session.
  - **Deferred:** `steer` (it starts a turn on an idle session and blurs the done rule), model, provider and reasoning
    overrides (the profile decides them), and `get_transcript`.
- **Bounded creation.** Ingest has no per-owner session quota. The adapter refuses to create more than
  `PI_MCP_MAX_SESSIONS` (default 20) sessions per process, so a looping agent cannot start sandboxes without end.
- **The output is untrusted.** The session has read repositories and the web. The tool descriptions say that the returned
  text, the failure and any error message from ingest are the remote side's output and are not instructions, so the calling
  agent treats them like a web page. Annotations mark `get_session` and `wait` read-only and `delete_session` destructive (it
  drops the workspace, so unpushed work is lost). The reverse also holds: what the caller sends in `text` reaches a sandbox
  with web egress.
- **MCP tasks later, beside the polling tools.** This part is a direction, not yet a contract; the extension may change before
  the SDK ships it.
  - **When.** The adapter adds tasks mode once the TypeScript SDK ships the extension (PR #2782) and the first client that
    needs it supports it.
  - **How the adapter chooses.** For `run_task` and `send_message`, a request that carries the tasks capability gets a task
    handle. A request without it gets the polling answer above, so no client is locked out. The polling tools stay listed for
    every client.
  - **What it needs first.** A task must settle on its own event, not on the session as a whole. ADR 0029 gives the
    orchestrator each submission's outcome, but nothing persists it. Tasks mode therefore waits for a per-event outcome on
    the inbox row and `GET /sessions/{id}/events/{eventId}`; then `taskId` is `<sessionId>.<eventId>`, `tasks/get` reads that
    outcome, `tasks/cancel` maps to a `cancel` event, and the adapter needs no task store of its own, since every read is
    authorised by ingest's owner check.
  - **No `input_required` yet.** A session cannot ask its caller a question today.

## Consequences

- Every MCP client can use sessions today, through the polling tools. With tasks mode, a client that supports it, the Claude
  Code CLI today, gets the same work without the model having to poll.
- The adapter is an API client, so slice 1 needs no new migration, Secret or NetworkPolicy. It reaches ingest where the user
  already does (port-forward, kind's localhost NodePort, or an Ingress).
- `wait` decides "done" from the session as a whole, not from one event. When two callers send to the same session, one
  caller's `wait` can return the other's answer as well. Sessions have one owner, and the coding agent is expected to use one
  session per task. The per-event outcome needed for tasks mode removes this caveat.
- There is no `GET /sessions` list, so an agent that loses a `sessionId` (context compaction) leaks the session until
  someone deletes it. Every result carries the `sessionId`; a list endpoint is a follow-up.
- The polling path is complete without tasks mode, so no work is lost if the extension changes.

## Amendment, 2026-11-20 (issue #342)

- **The cap counts live sessions.** `PI_MCP_MAX_SESSIONS` limits the sessions this process created and still holds, not
  every create it ever made. A delete that ingest answers with `deleted` frees the slot at once. A session that is still
  `deleting` keeps its slot, because its sandbox is still being torn down; when the cap is hit, the adapter reads such
  sessions again and frees those now `deleted` or gone. A session this process did not create never frees a slot.
- **`wait` and `run_task` also return** `phase` (`pending`, `running` or `idle`), `tools` (the tool names of the last `live`
  event, only while `running`), `elapsedSec` (the session's age from `createdAt`) and `failedSinceStart` (messages that
  failed during the call, a rise of `events.failed` since its first read). All come from data the session API already
  returns.
