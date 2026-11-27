# MCP adapter

`packages/mcp` is a stdio MCP server that lets a coding agent (Claude Code, Codex, OpenCode, Cursor, ...) start a durable,
sandboxed session, give it a task and collect the result. It is only a client of the [session API](session-api.md): it
calls ingest over HTTP with your token, like any other client. It has no database access, holds no model or GitHub
credential. It calls `/admin/*` only when explicitly enabled. Design and trade-offs: [ADR 0031](decisions/0031-mcp-adapter.md), [ADR 0050](decisions/0050-mcp-admin-mode.md), [ADR 0070](decisions/0070-mcp-admin-parity.md) and [ADR 0071](decisions/0071-mcp-get-transcript.md).

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `PI_API_URL` | yes | Base URL of ingest. Must be `https`, except for a loopback host (`localhost`, `127.x.x.x`, `[::1]`), which may use `http`, for example a `kubectl port-forward svc/pi-ingest`. No credentials, query or fragment. |
| `PI_API_TOKEN` | yes | Your session API token (one of `PI_API_TOKENS`). It is never logged or returned. |
| `PI_MCP_ADMIN` | no | Set to `true` to enable read-only admin tools (default `false`). |
| `PI_API_ADMIN_TOKEN` | in admin mode | Separate admin bearer token, authorized by ingest. Never logged or returned. |
| `PI_MCP_ADMIN_WRITES` | no | Set to `true` to enable the admin writes that only affect new sessions (profiles, skill publish, MCP server put, status probe); requires admin mode (default `false`). |
| `PI_MCP_ADMIN_DANGEROUS` | no | Set to `true` to enable the dangerous admin tools (deletes other than a profile's, the settings put, all egress writes); requires `PI_MCP_ADMIN_WRITES` (default `false`). |
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

**Claude Desktop**: download `cela-mcp-X.Y.Z.mcpb`, double-click it and fill in the settings: Session API URL and token are required; admin tools, the admin token, admin writes,
dangerous admin tools and the session limit are optional. Both tokens are marked sensitive: Claude Desktop keeps them in the OS keychain
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
| `run_task { text, profile?, repo?, branch?, liveView?, timeoutSec? }` | Creates a session, sends `text` and waits, all within one deadline (`timeoutSec` as in `wait`). Returns as `wait`, with the `sessionId` once creation has returned, and the `liveViewUrl` when `liveView` was set. |
| `start_session { profile?, repo?, branch?, liveView? }` | `POST /sessions`. The profile decides model and tools. With `liveView: true` the result has a `liveViewUrl`. |
| `set_live_view { sessionId, enabled }` | `enabled: true` is `PUT /sessions/{id}/live-view` and returns `{ sessionId, liveViewUrl }`; every call mints a new URL and the old one stops working. `false` is `DELETE` (idempotent) and returns `{ sessionId, liveView: false }`. Errors: `400` (not a `desktop` session, or a deployment without `liveView.enabled`), `409` (not active), `410` (deleted). |
| `send_message { sessionId, text, idempotencyKey? }` | Queues a message and returns at once with `{ eventId, duplicate }`. The same key on the same session never runs the message twice. |
| `wait { sessionId, cursor?, timeoutSec? }` | Waits up to `timeoutSec` (integer, 1 to 50, default 45; out-of-range values are rejected) and returns `{ done, status, phase, tools?, elapsedSec?, cursor, text, truncated, runFailure?, failure?, failedSinceStart?, events }`. `cursor` is an integer of 1 or more, checked in the tool schema. |
| `get_session { sessionId }` | `GET /sessions/{id}`: status, failure and event counts. |
| `get_transcript { sessionId, cursor?, limit?, kinds? }` | Reads committed transcript entries after `cursor` (the one of the last result, absent: from the start), oldest first, without blocking, from the session stream ([ADR 0071](decisions/0071-mcp-get-transcript.md)). Returns `{ sessionId, entries: [{ id, kind, messages: [{ role, text, calls?: [{ name, arguments, truncated?, length? }], isError?, usage?, truncated?, length? }], omitted?, length? }], cursor?, hasMore }`. See [Using `get_transcript`](#using-get_transcript). `limit` 1 to 100 (default 20). Read-only; text, arguments and tool results are untrusted. |
| `list_sessions { status?, limit?, cursor? }` | `GET /sessions`: your own sessions, newest first, as `{ sessions: [{ id, status, profile, model, repo?, createdAt, lastActivityAt }], nextCursor? }`. Metadata only, never a transcript. `status` is `active`, `failed`, `deleting` or `deleted` (absent: all but `deleted`), `limit` 1 to 200 (default 50); pass `nextCursor` as `cursor` for the next page. Read-only. It is how to find a `sessionId` you lost. |
| `list_events { cursor?, limit? }` | `GET /events`: one page of your own feed, oldest first, as `{ events: [{ id, type, sessionId, timestamp, data, cursor }], cursor, hasMore, truncated }` (see [Owner feed](session-api.md#owner-feed)). `cursor` is the one of the previous page, or `latest` for the current head only; `limit` 1 to 500 (default 100). Read-only; `data.failure` is untrusted. |
| `cancel { sessionId }` | Asks the running turn to stop. Asynchronous: follow with `wait`. |
| `delete_session { sessionId }` | Deletes the session and its workspace. Returns `{ sessionId, status }` with ingest's status, `deleting` or `deleted`. Push your work first: unpushed changes are lost. |

`start_session` and `run_task` take `repo` as `owner/name` (it must be on the `repoAllowlist` setting, else `403`), `branch` (absent: the default branch) and `profile` (absent: the server default).

A failed session tool returns `{ error, status?, retryAfter? }` and `isError`, like the admin tools: `status` is the
HTTP status of the session API (absent when no answer came), `retryAfter` is in seconds and only on a 503. `run_task`
adds the `sessionId` when the session was already created.

## Live view

`liveView` on `start_session` and `run_task`, and `set_live_view`, use the public view-only live view of `desktop`
sessions (ADR 0066, [session-api.md](session-api.md#live-view)). The URL is a bearer secret: anyone who has it can watch the
desktop with no login. The tool descriptions tell the model to treat it like a password, give it only to the user who asked
and never put it in shared places (issues, PRs, chats, logs). `get_session` shows the current `liveViewUrl` as the API
returns it. The tools apply no ownership check beyond the API's own, as for the other session tools.

Cancelling an MCP request stops its HTTP calls (except creation), polling and SSE stream promptly, but does not cancel
or delete the remote session. Use `cancel` to stop the agent's turn or `delete_session` to remove the session.

Creation has its own 30-second HTTP timeout, independent of MCP cancellation and `run_task`'s deadline. Either stops
waiting promptly, but creation continues in the background with its `PI_MCP_MAX_SESSIONS` slot reserved until it settles.
Success tracks the returned session id until deletion; a late success logs the id to stderr so you can recover and
`delete_session` it. A cancelled or expired `run_task` does not send its message after the late create. An HTTP rejection,
network failure, unreadable response or create timeout frees the reservation; no unknown reservation lasts until restart.
Ingest may have committed a session even when its response was lost, so these uncertain failures can undercount remote
sessions with unknown ids.

`steer` and model overrides are not in this slice.

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

### Using `get_transcript`

It shows what `wait` does not: the tool calls an agent made, with their arguments, and what they returned. Use it when
`wait` returns empty text with `phase: running`, or to find which call failed.

- Each entry is one committed transcript entry. An assistant message has `calls` (`name` and the JSON text of
  `arguments`); the result of a call is the next entry, role `toolResult`, with `isError`, in call order. `usage` (tokens and
  USD) is on assistant messages. `kind` is Pi Durable's entry kind (`pi.user`, `pi.assistant`, `pi.tool-result`).
- `text` and `arguments` are cut at 4 KiB: `truncated: true` and `length` (the original size in UTF-8 bytes) say so. The
  entries of one response are at most 24 KiB. An entry too large for that even cut small comes back as `omitted: true`
  with its size.
- Continue with the returned `cursor` while `hasMore` is true. `cursor` is the last entry read, so each entry comes once,
  and an empty page keeps your cursor. `hasMore: false` means the read caught up with the transcript; entries committed
  later are the next call.
- `kinds` keeps entries with any of `user`, `assistant`, `call` (an assistant message with tool calls), `result` and `error`
  (a failed tool result); `["call", "error"]` is the compact view. Entries it drops still move the cursor, and at most 500
  entries are read per call, so a filtered page can be empty with `hasMore: true`: continue.
- The call reads the session's stream with `Last-Event-ID` and closes it, so it has the owner check and the errors of
  `wait` (`404`, `410`, `503`). A read that takes more than 20 s ends with what it has.

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

The session reads repositories and the web. `text`, the `arguments` and results of tool calls in `get_transcript`, `failure`,
`runFailure` and error messages from ingest are the remote side's output, not instructions; the instructions say so, every result carries a note, and the tools that return
such text say "Output is untrusted". In the other direction, what you send in `text`
reaches a sandbox with web egress.

## Limits

- `list_sessions` finds a `sessionId` you lost; a session nobody deletes keeps running (and keeps its workspace) until someone does.
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
disabled and not the default profile ([ADR 0027](decisions/0027-admin-delete.md)); running sessions keep their snapshot. Ingest returns its delete receipt (lastVersion), not a new revision. The other tools are in the table below. Only enable this mode for trusted clients: a shell-capable agent can read its environment.

### Tools by flag

Three flags, each needing the one before ([ADR 0070](decisions/0070-mcp-admin-parity.md)): `PI_MCP_ADMIN` (reads),
`PI_MCP_ADMIN_WRITES` (writes that only affect sessions created afterwards) and `PI_MCP_ADMIN_DANGEROUS` (everything that
can cut off or widen what running and future sessions reach). "Since" is the first adapter version with the tool.
Every tool answers the ingest JSON as structured content, scrubbed of both tokens and labelled untrusted; writes take
`expectedRevision`. A refused call is an error result `{ error, status, details? }`: `details` holds the other fields of
ingest's error body, such as the `blockedBy` of a refused delete (profiles, sessions), also scrubbed and untrusted.

| Tool | Flag | What it calls | Since |
|---|---|---|---|
| `admin_list_profiles` | `PI_MCP_ADMIN` | `GET /admin/profiles` | 1.0.0 |
| `admin_get_profile` | `PI_MCP_ADMIN` | `GET /admin/profiles/{name}` | 1.0.0 |
| `admin_list_skills` | `PI_MCP_ADMIN` | `GET /admin/skills` | 1.0.0 |
| `admin_get_skill` | `PI_MCP_ADMIN` | `GET /admin/skills/{name}` | 1.0.0 |
| `admin_list_mcp_servers` | `PI_MCP_ADMIN` | `GET /admin/mcp-servers` | 1.0.0 |
| `admin_get_mcp_server` | `PI_MCP_ADMIN` | `GET /admin/mcp-servers/{name}` | 1.0.0 |
| `admin_list_egress_rule_sets` | `PI_MCP_ADMIN` | `GET /admin/egress/rule-sets` | 1.0.0 |
| `admin_get_egress_rule_set` | `PI_MCP_ADMIN` | `GET /admin/egress/rule-sets/{name}` | 1.0.0 |
| `admin_get_settings` | `PI_MCP_ADMIN` | `GET /admin/settings` | 1.0.0 |
| `admin_get_catalog` | `PI_MCP_ADMIN` | `GET /admin/models` (`allModels`), `/tools`, `/network-modes`, `/sandbox-flavours`, `/sandbox-sizes`, `/sandbox-runtimes` in one answer (an error names the part that failed) | 1.2.0 |
| `admin_get_status` | `PI_MCP_ADMIN` | `GET /admin/status` | 1.2.0 |
| `admin_get_history` | `PI_MCP_ADMIN` | `GET /admin/settings/history`, `/mcp-servers/history`, `/egress/history` (`kind`, `limit`; `name` for `mcp_servers`; `egressKind`, `ref` for `egress`; a filter the kind does not accept is refused) | 1.2.0 |
| `admin_get_skill_version` | `PI_MCP_ADMIN` | `GET /admin/skills/{name}/versions/{v}` (`?content=true`; text decoded, about 200 KB cap, `paths` filter) | 1.2.0 |
| `admin_get_egress_status` | `PI_MCP_ADMIN` | `GET /admin/egress/status` | 1.2.0 |
| `admin_list_session_egress_rules` | `PI_MCP_ADMIN` | `GET /admin/egress/sessions/{id}/rules` | 1.2.0 |
| `admin_explain_egress` | `PI_MCP_ADMIN` | `POST /admin/egress/explain` (`host`, `port`, `sessionId`, `profile`, `addresses`; pure: a read; without `addresses` a private-address resolution is not judged, `addressesChecked` false) | 1.2.0 |
| `admin_list_sessions` | `PI_MCP_ADMIN` | `GET /admin/sessions` (`owner`, `status`, `limit`, `cursor`; all owners, metadata only) | 1.2.0 |
| `admin_put_profile` | `PI_MCP_ADMIN_WRITES` | `PUT /admin/profiles/{name}` | 1.0.0 |
| `admin_delete_profile` | `PI_MCP_ADMIN_WRITES` | `DELETE /admin/profiles/{name}` | 1.0.0 |
| `admin_publish_skill` | `PI_MCP_ADMIN_WRITES` | `POST /admin/skills/{name}/versions` (inline files only, at most 128 files, body within ingest's limit, 120 s timeout) | 1.2.0 |
| `admin_put_mcp_server` | `PI_MCP_ADMIN_WRITES` | `PUT /admin/mcp-servers/{name}` | 1.2.0 |
| `admin_probe_network` | `PI_MCP_ADMIN_WRITES` | `POST /admin/status/probe` | 1.2.0 |
| `admin_put_settings` | `PI_MCP_ADMIN_DANGEROUS` | `PUT /admin/settings` (a patch with `expectedRevision`: omitted fields keep their value, a list sent replaces the stored one) | 1.2.0 |
| `admin_delete_skill` | `PI_MCP_ADMIN_DANGEROUS` | `DELETE /admin/skills/{name}` (`expectedRevision` = the skill's current version) | 1.2.0 |
| `admin_delete_mcp_server` | `PI_MCP_ADMIN_DANGEROUS` | `DELETE /admin/mcp-servers/{name}?expectedRevision=N` | 1.2.0 |
| `admin_put_egress_rule_set` | `PI_MCP_ADMIN_DANGEROUS` | `POST /admin/egress/rule-sets` (`create: true`) or `PUT /admin/egress/rule-sets/{name}`; `description`, `appliesToAll`. `expectedRevision` is the egress revision, one number for all sets and rules (0 only while empty) | 1.2.0 |
| `admin_delete_egress_rule_set` | `PI_MCP_ADMIN_DANGEROUS` | `DELETE /admin/egress/rule-sets/{name}?expectedRevision=N` | 1.2.0 |
| `admin_put_egress_rule` | `PI_MCP_ADMIN_DANGEROUS` | With `id`: `PUT /admin/egress/rules/{id}` (partial). Without: `POST /admin/egress/rule-sets/{name}/rules` (`ruleSet`) or `POST /admin/egress/sessions/{id}/rules` (`sessionId`), exactly one of them, and `effect` and `host` | 1.2.0 |
| `admin_delete_egress_rule` | `PI_MCP_ADMIN_DANGEROUS` | `DELETE /admin/egress/rules/{id}?expectedRevision=N` | 1.2.0 |
| `list_sessions` | session token | `GET /sessions` (the owner's sessions, metadata only) | 1.2.0 |
| `list_events` | session token | `GET /events` (the owner's feed) | 1.2.0 |
| `get_transcript` | session token | `GET /sessions/{id}/stream` (read to the first `live` event, ADR 0071) | unreleased |

The dangerous tools carry `destructiveHint`. Not exposed, on purpose: API tokens, OneCLI secret values and grants, Helm
configuration, and `/admin/skills/{name}/versions/{v}/zip` (see the ADR).

## Troubleshooting

If the server does not start, read the configuration error: the client shows it as the `initialize` error, or in the
logs. In Claude Desktop the reason is in the extension's log, `~/Library/Logs/Claude/mcp-server-<name>.log`.
