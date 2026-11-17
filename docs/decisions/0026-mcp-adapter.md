# 0026: An MCP adapter lets coding agents use sessions, polling first, MCP tasks later

Status: accepted, 2026-11-17 (issue #158). Not implemented yet; this records the design for the implementation slice.

## Context

Coding agents (Claude Code, Codex, OpenCode, Cursor, Goose, ...) all speak MCP. If pi-durable has an MCP server, one of them
can hand a task to a durable session with a sandbox and a repository workspace (`docs/repo-workspace.md`: the agent pushes
`agent/**` branches and can open a PR) and collect the result, with no HTTP glue of its own.

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
  A coding agent must not be able to widen the model allowlist or install a skill.
- **First a local stdio server.** The adapter is the package `packages/mcp`, built on the official TypeScript SDK and run by
  the coding agent as a local process. It is configured by `PI_API_URL` and `PI_API_TOKEN` from the environment, so it works
  with every MCP client and needs no cluster change. A remote endpoint (`/mcp` on ingest, streamable HTTP, the same bearer
  auth) can follow once teams want it. Ingest is already stateless, which the 2026-07-28 transport assumes.
- **Polling tools that work in every client.** No call blocks longer than a client timeout:

  | Tool | Session API |
  |---|---|
  | `start_session { profile?, repo?, branch?, provider?, model?, reasoning? }` → `{ sessionId, ... }` | `POST /sessions` |
  | `send_message { sessionId, text, idempotencyKey? }` → `{ eventId, duplicate }` at once | `POST /sessions/{id}/events`, `kind: message`, `sourceEventId` from the key, so a retried call never runs the task twice |
  | `wait { sessionId, cursor?, timeoutSec? }` → `{ done, status, cursor, text, failure? }` | `GET /sessions/{id}/stream` with `Last-Event-ID: cursor` and `GET /sessions/{id}` |
  | `get_session { sessionId }` | `GET /sessions/{id}` |
  | `steer`, `cancel { sessionId, ... }` | events of kind `steer` and `cancel` |
  | `delete_session { sessionId }` | `DELETE /sessions/{id}` |
  | `run_task { text, repo?, branch?, profile?, ... }` → as `wait`, plus `sessionId` | create, send and wait in one call |

  - **When `wait` is done.** `wait` reads the stream for at most `timeoutSec`, default 45 and at most 50. It is `done` when the
    session is idle and nothing is left to run: a `live` event with `running: false` and `queued: 0`, and no pending events
    on the session.
  - **What `wait` returns.** It returns the assistant text of the entries committed after `cursor`, and the new cursor, which
    is the last entry id. The caller passes that cursor back on the next call, so a timeout loses nothing and the adapter
    keeps no state. On `failed`, `deleting` or `deleted` it returns the status and failure.
  - **What `run_task` returns.** When the turn is not finished within the timeout, `run_task` returns `done: false` with the
    `sessionId` and the cursor, never an error.
- **Small results.** The returned text is capped at 24 KiB, the same cap as a catalog MCP server's `maxOutputBytes`, and is
  cut at the end with a marker. The full transcript stays in the session and is read in pages, by a later
  `get_transcript { sessionId, cursor?, limit? }` if needed. Everything a tool returns lands in the calling agent's
  context.
- **The output is untrusted.** The session has read repositories and the web. The tool descriptions say that the returned
  text is the remote agent's output and is not instructions, so the calling agent treats it like a web page.
- **MCP tasks later, beside the polling tools.**
  - **When.** The adapter adds tasks mode once the TypeScript SDK ships the extension (PR #2782) and the first client that
    needs it supports it.
  - **How the adapter chooses.** For `run_task` and `send_message`, a request that carries the tasks capability gets a task
    handle. A request without it gets the polling answer above, never the error `-32021`, so no client is locked out. The
    polling tools stay listed for every client.
  - **What the handle maps to.** `taskId` is `<sessionId>.<eventId>`. `tasks/get` maps to the `wait` logic for that event
    with no waiting: status `working` maps to running, `completed` carries the `CallToolResult`, and `failed` maps to a failed
    session. `tasks/cancel` maps to a `cancel` event, and `ttlMs` is `null`.
  - **Why no task store.** The session already holds the state durably in Postgres, and every `tasks/get` is authorised by
    ingest's owner check on the session. The adapter needs no store of its own, and a guessed id is still answered `404` for
    another owner.
  - **No `input_required` yet.** A session cannot ask its caller a question today, so `tasks/update` and `input_required` are
    out of scope.
- **No loops.** The adapter's own endpoint must never be registered in the MCP server catalog (`docs/session-api.md`, MCP
  server catalog), or a session could start sessions. When the remote endpoint is added, its URL is refused by the catalog
  validator.

## Consequences

- Every MCP client can use sessions today, through the polling tools. With tasks mode, a client that supports it, the Claude
  Code CLI today, gets the same work without the model having to poll.
- The adapter is an API client, so it needs no new migration, Secret or NetworkPolicy. It reaches ingest where the user
  already does (port-forward, kind's localhost NodePort, or an Ingress).
- `wait` decides "done" from the session as a whole, not from one event. When two callers send to the same session, one
  caller's `wait` can return the other's answer as well. Sessions have one owner, and the coding agent is expected to use one
  session per task.
- The tasks extension may still change before the SDKs ship it. Polling first means none of that work is lost.
