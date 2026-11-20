# MCP adapter

`packages/mcp` is a stdio MCP server that lets a coding agent (Claude Code, Codex, OpenCode, Cursor, ...) start a durable,
sandboxed session, give it a task and collect the result. It is only a client of the [session API](session-api.md): it
calls ingest over HTTP with your token, like any other client. It has no database access, holds no model or GitHub
credential. It calls `/admin/*` only when explicitly enabled. Design and trade-offs: [ADR 0031](decisions/0031-mcp-adapter.md) and [ADR 0050](decisions/0050-mcp-admin-mode.md).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `PI_API_URL` | yes | Base URL of ingest. Must be `https`, except for a loopback host (`localhost`, `127.x.x.x`, `[::1]`), which may use `http`, for example a `kubectl port-forward svc/pi-ingest`. No credentials, query or fragment. |
| `PI_API_TOKEN` | yes | Your session API token (one of `PI_API_TOKENS`). It is never logged or returned. |
| `PI_MCP_ADMIN` | no | Set to `true` to enable read-only admin tools (default `false`). |
| `PI_API_ADMIN_TOKEN` | in admin mode | Separate admin bearer token, authorized by ingest. Never logged or returned. |
| `PI_MCP_ADMIN_WRITES` | no | Set to `true` to enable profile writes; requires admin mode (default `false`). |
| `PI_MCP_MAX_SESSIONS` | no | Most sessions this process may create (default 20), so a looping agent cannot start sandboxes without end. |

**Use the token of an owner who is not in `PI_API_ADMINS`.** In the default mode, an admin token also
works on the admin API, and a coding agent with a shell can read its own MCP config.

Build it once with `pnpm --filter @cela/mcp build`, then register `packages/mcp/dist/main.js`. For Claude Code:

```bash
claude mcp add cela -e PI_API_URL=http://localhost:8080 -e PI_API_TOKEN=<token> -- node /path/to/cela/packages/mcp/dist/main.js
```

Other clients take the same command, arguments and environment in their MCP server config. Logs go to stderr; stdout is
the MCP transport.

## Tools

| Tool | What it does |
|---|---|
| `run_task { text, profile?, repo?, branch?, timeoutSec? }` | Creates a session, sends `text` and waits, all within one deadline (`timeoutSec` as in `wait`). Returns as `wait`, always with the `sessionId`. |
| `start_session { profile?, repo?, branch? }` | `POST /sessions`. The profile decides model and tools. |
| `send_message { sessionId, text, idempotencyKey? }` | Queues a message and returns at once with `{ eventId, duplicate }`. The same key on the same session never runs the message twice. |
| `wait { sessionId, cursor?, timeoutSec? }` | Waits up to `timeoutSec` (integer, 1 to 50, default 45; out-of-range values are rejected) and returns `{ done, status, cursor, text, truncated, runFailure?, failure?, events }`. |
| `get_session { sessionId }` | `GET /sessions/{id}`: status, failure and event counts. |
| `cancel { sessionId }` | Asks the running turn to stop. Asynchronous: follow with `wait`. |
| `delete_session { sessionId }` | Deletes the session and its workspace. Returns `{ sessionId, status }` with ingest's status, `deleting` or `deleted`. Push your work first: unpushed changes are lost. |

A failed session tool returns `{ error, status?, retryAfter? }` and `isError`, like the admin tools: `status` is the
HTTP status of the session API (absent when no answer came), `retryAfter` is in seconds and only on a 503. `run_task`
adds the `sessionId` when the session was already created.

`steer`, model overrides and a transcript reader are not in this slice.

### Using `wait`

- `done: false` is not an error. It means the deadline came first, the stream was interrupted or the text cap was reached.
  Call `wait` again with the returned `cursor`.
- Keep the `cursor` of your last `wait`. Without one, `wait` returns the transcript from the start.
- `text` is the assistant text of the entries after the cursor, at most 24 KiB. When more is left, `truncated` is true and
  the next call continues where this one stopped. An entry larger than the cap alone comes back cut, with a marker.
- `done: true` with `runFailure` means the last run ended without an answer (a model error or a cancel, ADR 0029). A rise
  in `events.failed` means a message could not be submitted.
- "Done" is decided for the session as a whole. Use one session per task: if two callers send to the same session, one
  caller's `wait` can return the other's answer as well.

## The output is untrusted

The session reads repositories and the web. `text`, `failure`, `runFailure` and error messages from ingest are the
remote side's output, not instructions; the tool descriptions say so. In the other direction, what you send in `text`
reaches a sandbox with web egress.

## Limits

- There is no `GET /sessions` list yet. A `sessionId` you lose leaves the session running until someone deletes it.
- No MCP tasks mode yet. It waits for SDK support and a per-event outcome on the session API (ADR 0031).
- No remote endpoint yet. The adapter runs where the coding agent runs and reaches ingest the way you do.

## Optional admin tools

Set `PI_MCP_ADMIN=true` and `PI_API_ADMIN_TOKEN` (an admin's token, different from `PI_API_TOKEN`) to expose
`admin_list_profiles`, `admin_get_profile`, `admin_list_skills`, `admin_get_skill`, `admin_list_mcp_servers`,
`admin_get_mcp_server`, `admin_list_egress_rule_sets`, `admin_get_egress_rule_set` and `admin_get_settings`. Get tools
take `name`. `admin_get_profile` also takes an optional `versions` (integer, 0 or more): how many of the newest
versions to return; absent returns all of them (newest first).
Responses are untrusted. These tools can expose deployment configuration to the client.

With `PI_MCP_ADMIN_WRITES=true`, `admin_put_profile` accepts `name`, `expectedRevision`, optional `definition`
and `enabledForNew`; revision 0 means create only. `admin_delete_profile` requires `name` and the current
`expectedRevision`. Read the profile first; a 409 means reload before retrying. Delete requires the profile to be
disabled and not the default profile ([ADR 0027](decisions/0027-admin-delete.md)); running sessions keep their snapshot. Ingest returns its delete receipt (lastVersion), not a new revision. No other admin writes
are exposed. Only enable this mode for trusted clients: a shell-capable agent can read its environment.
