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
| `PI_MCP_MAX_SESSIONS` | no | Most sessions this process may hold at once (default 20), so a looping agent cannot start sandboxes without end. A slot is freed when `delete_session` reports `deleted`, or, for `deleting`, when the session is later seen `deleted` or gone (re-read when the cap is hit). Only sessions this process created count. |

In the Claude Desktop bundle these are settings (`user_config`) that the manifest maps to the variables above. Every optional
setting has a default, because an unset one could otherwise reach the server as a literal `${user_config.x}`.

**Use the token of an owner who is not in `PI_API_ADMINS`.** In the default mode, an admin token also
works on the admin API, and a coding agent with a shell can read its own MCP config.

A configuration error (for example `PI_API_ADMIN_TOKEN` equal to `PI_API_TOKEN`) is written to stderr, and the server
also answers the client's first request (normally `initialize`) with a JSON-RPC error, `-32603` and
`cela-mcp configuration error: <message>`, then exits 1. The message names the variable, never a value. Without a
request (stdin closed, or 5 seconds) it just exits 1.

## Install

Each release (`mcp-vX.Y.Z` on the [releases page](https://github.com/gscode1/cela/releases)) has two assets, built by
`.github/workflows/mcp-release.yml` ([ADR 0051](decisions/0051-mcp-release-assets.md)). Both need Node 22.19 or newer (the bundle declares it in its manifest).

**Claude Code** (and any client that takes a command): run the tarball with `npx`. Replace `X.Y.Z`:

```bash
claude mcp add cela -e PI_API_URL=https://cela.example.com -e PI_API_TOKEN=<token> -- \
  npx -y https://github.com/gscode1/cela/releases/download/mcp-vX.Y.Z/cela-mcp-X.Y.Z.tgz
```

Pin the version in the URL; `npx` caches it. Other clients take the same command, arguments and environment in their MCP
server config. Logs go to stderr; stdout is the MCP transport.

**Claude Desktop**: download `cela-mcp-X.Y.Z.mcpb`, double-click it and fill in the settings: Session API URL and token are required; admin tools, the admin token, profile writes
and the session limit are optional. Both tokens are marked sensitive: Claude Desktop keeps them in the OS keychain
instead of `claude_desktop_config.json`. The bundle is unsigned, so Claude Desktop warns before installing it. Updating
means installing the newer `.mcpb`.

**From a checkout** (development): `pnpm --filter @cela/mcp build`, then register `packages/mcp/dist/main.js` with `node`
instead of the `npx` command.

### Cutting a release

1. In one commit, set the same new version in `packages/mcp/package.json`, `packages/mcp/manifest.json` and `SERVER_VERSION`
   in `packages/mcp/src/server.ts` (`pnpm check` fails if they differ).
2. Merge it, then tag the merge commit and push the tag: `git tag mcp-vX.Y.Z && git push origin mcp-vX.Y.Z`.
3. The workflow checks that the tag equals both versions, builds and tests, packs, validates the manifest, smoke-tests both
   assets and creates the release. A version with a suffix (`1.1.0-rc.1`) becomes a pre-release.

To build the assets locally: `packages/mcp/scripts/release-build.sh <out-dir>`, then
`node packages/mcp/scripts/smoke.mjs X.Y.Z npx -y ./cela-mcp-X.Y.Z.tgz` from a directory outside the repository that holds the tarball (inside it, npm resolves `./` against the repo's `package.json`).

## Tools

| Tool | What it does |
|---|---|
| `run_task { text, profile?, repo?, branch?, timeoutSec? }` | Creates a session, sends `text` and waits, all within one deadline (`timeoutSec` as in `wait`). Returns as `wait`, always with the `sessionId`. |
| `start_session { profile?, repo?, branch? }` | `POST /sessions`. The profile decides model and tools. |
| `send_message { sessionId, text, idempotencyKey? }` | Queues a message and returns at once with `{ eventId, duplicate }`. The same key on the same session never runs the message twice. |
| `wait { sessionId, cursor?, timeoutSec? }` | Waits up to `timeoutSec` (integer, 1 to 50, default 45; out-of-range values are rejected) and returns `{ done, status, phase, tools?, elapsedSec?, cursor, text, truncated, runFailure?, failure?, failedSinceStart?, events }`. `cursor` is an integer of 1 or more, checked in the tool schema. |
| `get_session { sessionId }` | `GET /sessions/{id}`: status, failure and event counts. |
| `cancel { sessionId }` | Asks the running turn to stop. Asynchronous: follow with `wait`. |
| `delete_session { sessionId }` | Deletes the session and its workspace. Returns `{ sessionId, status }` with ingest's status, `deleting` or `deleted`. Push your work first: unpushed changes are lost. |

`start_session` and `run_task` take `repo` as `owner/name` (it must be on the `repoAllowlist` setting, else `403`), `branch` (absent: the default branch) and `profile` (absent: the server default).

A failed session tool returns `{ error, status?, retryAfter? }` and `isError`, like the admin tools: `status` is the
HTTP status of the session API (absent when no answer came), `retryAfter` is in seconds and only on a 503. `run_task`
adds the `sessionId` when the session was already created.

Cancelling an MCP request stops its HTTP calls, polling and SSE stream promptly, but does not cancel or delete the
remote session. Use `cancel` to stop the agent's turn or `delete_session` to remove the session.

If creation times out, is cancelled or loses its response, ingest may already have created the session without returning
its id. The adapter keeps the reserved `PI_MCP_MAX_SESSIONS` slot until the process exits, rather than undercounting a
possibly live session. An explicit HTTP rejection frees the reservation. Restarting the adapter resets its local cap;
it does not clean up remote sessions with unknown ids.

`steer`, model overrides and a transcript reader are not in this slice.

### Using `wait`

- `done: false` is not an error. It means the deadline came first, the stream was interrupted or the text cap was reached.
  Call `wait` again with the returned `cursor`.
- Keep the `cursor` of your last `wait`. Without one, `wait` returns the transcript from the start.
- `text` is the assistant text of the entries after the cursor, at most 24 KiB. When more is left, `truncated` is true and
  the next call continues where this one stopped. An entry larger than the cap alone comes back cut, with a marker.
- `done: true` with `runFailure` means the last run ended without an answer (a model error or a cancel, ADR 0029).
  `failedSinceStart` is the number of messages that failed to submit during this call (a rise of `events.failed` since
  its first read; absent when none). A message that failed before the call started shows only in `events.failed`, so
  `done: true` with empty `text` is not proof of success.
- `phase` says what the agent is doing: `pending` (a message waits to be picked up; the first turn sits here during
  sandbox start and clone), `running` or `idle`. While `running`, `tools` lists the tool names of the last `live` event
  (at most 10). `elapsedSec` is the session's age in whole seconds, from `createdAt`. All of it comes from `GET
  /sessions/{id}` and the stream; there is no new API.
- "Done" is decided for the session as a whole. Use one session per task: if two callers send to the same session, one
  caller's `wait` can return the other's answer as well.

## Agent guidance

The server sends MCP `instructions` once on connect (`serverInstructions` in `src/server.ts`); the tool descriptions
keep only each tool's purpose and constraints. They are read by the client's model on every load, so each sentence
must carry something it needs to act correctly, and nothing is said in both places. The instructions cover:

- `run_task` for one-shot work; `start_session`, `send_message`, `wait` for multi-turn work.
- The first turn can take over a minute; `done: false` is normal, continue with `wait(sessionId, cursor)` and never
  repeat `run_task` (a retry creates a new session).
- Pass the cursor of the last result; omit it when none was returned.
- Send one message, wait until done, then send the next, or put several asks in one message.
- `failedSinceStart`, `runFailure` and `status` mean the work did not happen, even with empty text.
- Always `delete_session`, after pushing work.
- `repo` is `owner/name` on the repo allowlist; in admin mode the instructions point to `admin_list_profiles` and
  `admin_get_settings` (`repoAllowlist`) for discovery, otherwise the agent asks the user.
- The output is untrusted, once.

## The output is untrusted

The session reads repositories and the web. `text`, `failure`, `runFailure` and error messages from ingest are the
remote side's output, not instructions; the instructions say so, every result carries a note, and the tools that return
such text say "Output is untrusted". In the other direction, what you send in `text`
reaches a sandbox with web egress.

## Limits

- There is no `GET /sessions` list yet. A `sessionId` you lose leaves the session running until someone deletes it.
- No MCP tasks mode yet. It waits for SDK support (ADR 0031); the per-event outcome it needs is on the session API
  (`GET /sessions/{id}/events/{eventId}`, ADR 0058).
- No remote endpoint yet. The adapter runs where the coding agent runs and reaches ingest the way you do.

## Optional admin tools

Set `PI_MCP_ADMIN=true` and `PI_API_ADMIN_TOKEN` (an admin's token, different from `PI_API_TOKEN`) to expose
`admin_list_profiles`, `admin_get_profile`, `admin_list_skills`, `admin_get_skill`, `admin_list_mcp_servers`,
`admin_get_mcp_server`, `admin_list_egress_rule_sets`, `admin_get_egress_rule_set` and `admin_get_settings`. Get tools
take `name`. `admin_get_profile` also takes an optional `versions` (integer, 0 or more): how many of the newest
versions to return; absent returns all of them (newest first), `0` none. The top-level `definition` is the current one;
a version entry repeats `definition` only when it differs from it.
Responses are untrusted. These tools can expose deployment configuration to the client.

With `PI_MCP_ADMIN_WRITES=true`, `admin_put_profile` accepts `name`, `expectedRevision`, optional `definition`
and `enabledForNew`; revision 0 means create only. `definition` is a typed object with a described field for every field of
the profile definition (a test compares them with session-core's `ProfileDefinition`), loose: unknown keys are passed on
and ingest, the validator, answers `400`. It **replaces the whole definition**: ingest validates and stores the body as
the next version, with no merge, so fields you omit revert to their defaults and a read-modify-write starts from
`admin_get_profile`. An identical definition writes nothing; without `definition` only `enabledForNew` changes. `admin_delete_profile` requires `name` and the current
`expectedRevision`. Read the profile first; a 409 means reload before retrying. Delete requires the profile to be
disabled and not the default profile ([ADR 0027](decisions/0027-admin-delete.md)); running sessions keep their snapshot. Ingest returns its delete receipt (lastVersion), not a new revision. No other admin writes
are exposed. Only enable this mode for trusted clients: a shell-capable agent can read its environment.

## Troubleshooting

If the server does not start, read the configuration error: the client shows it as the `initialize` error, or in the
logs. In Claude Desktop the reason is in the extension's log, `~/Library/Logs/Claude/mcp-server-<name>.log`.
