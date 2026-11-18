# MCP adapter

`packages/mcp` is a stdio MCP server that lets a coding agent (Claude Code, Codex, OpenCode, Cursor, ...) start a durable,
sandboxed session, give it a task and collect the result. It is only a client of the [session API](session-api.md): it
calls ingest over HTTP with your token, like any other client. It has no database access, holds no model or GitHub
credential and never calls `/admin/*`. Design and trade-offs: [ADR 0031](decisions/0031-mcp-adapter.md).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `PI_API_URL` | yes | Base URL of ingest. Must be `https`, except for a loopback host (`localhost`, `127.x.x.x`, `[::1]`), which may use `http`, for example a `kubectl port-forward svc/pi-ingest`. No credentials, query or fragment. |
| `PI_API_TOKEN` | yes | Your session API token (one of `PI_API_TOKENS`). It is never logged or returned. |
| `PI_MCP_MAX_SESSIONS` | no | Most sessions this process may create (default 20), so a looping agent cannot start sandboxes without end. |

**Use the token of an owner who is not in `PI_API_ADMINS`.** The adapter has no admin tools, but an admin token also
works on the admin API, and a coding agent with a shell can read its own MCP config.

Build it once with `pnpm --filter @pi-durable-k8s/mcp build`, then register `packages/mcp/dist/main.js`. For Claude Code:

```bash
claude mcp add pi-durable -e PI_API_URL=http://localhost:8080 -e PI_API_TOKEN=<token> -- node /path/to/pi-durable-k8s/packages/mcp/dist/main.js
```

Other clients take the same command, arguments and environment in their MCP server config. Logs go to stderr; stdout is
the MCP transport.

## Tools

| Tool | What it does |
|---|---|
| `run_task { text, profile?, repo?, branch?, timeoutSec? }` | Creates a session, sends `text` and waits, all within one deadline. Returns as `wait`, always with the `sessionId`. |
| `start_session { profile?, repo?, branch? }` | `POST /sessions`. The profile decides model and tools. |
| `send_message { sessionId, text, idempotencyKey? }` | Queues a message and returns at once with `{ eventId, duplicate }`. The same key on the same session never runs the message twice. |
| `wait { sessionId, cursor?, timeoutSec? }` | Waits up to `timeoutSec` (default 45, at most 50) and returns `{ done, status, cursor, text, truncated, runFailure?, failure?, events }`. |
| `get_session { sessionId }` | `GET /sessions/{id}`: status, failure and event counts. |
| `cancel { sessionId }` | Asks the running turn to stop. Asynchronous: follow with `wait`. |
| `delete_session { sessionId }` | Deletes the session and its workspace. Push your work first: unpushed changes are lost. |

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
