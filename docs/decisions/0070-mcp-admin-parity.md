# 0070: MCP admin parity: the admin API as typed tools, in three tiers

Status: accepted, 2026-11-25 (issue #511). Amends [0050](0050-mcp-admin-mode.md), which exposed reads and two profile writes and
left the other admin writes for later. Relates to [0023](0023-admin-revisions.md) (revisions), [0027](0027-admin-delete.md)
(deletes), [0034](0034-egress-rules.md) (egress rules), [0039](0039-egress-revocation.md) (no tunnel-closing route),
[0042](0042-onecli-admin-key-in-orchestrator.md) (the OneCLI admin key) and [0059](0059-remote-mcp-endpoint.md) (a remote
endpoint).

## Context

The goal: an agent that holds the admin token can do through the MCP adapter what an admin does in the console, without
curl. 0050 deferred that for skills, MCP servers, egress, settings and anything about the deployment as a whole, and
named no way to grow: one flag for all writes would put a profile edit and an egress allow rule behind the same switch.

Route inventory (checked against `packages/ingest`, 2026-11-25):

- **Exists, no tool yet:** `GET /admin/models` (`?all=true`), `/tools`, `/network-modes`, `/sandbox-flavours`,
  `/sandbox-sizes`, `/sandbox-runtimes`, `/status`, `POST /status/probe` (202); the settings, MCP server and egress
  histories (`limit`, plus `name` for MCP servers and `kind` and `ref` for egress); `GET /skills/{name}/versions/{v}`
  (`?content=true` for the file contents) and `POST /skills/{name}/versions`; `PUT /settings`; `PUT` and `DELETE` of MCP
  servers and skills; the egress rule set and rule writes, `POST /egress/sessions/{id}/rules`, `GET /egress/status` and
  `POST /egress/explain`.
- **Did not exist, added with this decision (PR #512):** `GET /sessions` (the owner's sessions, newest first, paged) and
  `GET /admin/sessions` (every owner, with an optional `owner` filter), both metadata only. Migration 041
  (`041_session_list.sql`) adds `sessions_owner_created_idx` on `(owner_subject, created_at desc, id desc)`, which the
  keyset paging and the `status` filter scan use. `GET /events` already was the caller's own feed (0058), keyed by the
  token's owner.
- **Does not exist:** `POST /admin/sessions/{id}/close-tunnels` (0039 removed it), so no tool.

## Decision

- **Three tiers, three flags, all off by default.** The new `PI_MCP_ADMIN_DANGEROUS` needs `PI_MCP_ADMIN_WRITES`, which
  needs `PI_MCP_ADMIN` (a configuration error names the missing one, as it does for writes). `config.admin` is
  `{ token, writes, dangerous }`; the manifest maps `admin_dangerous` to it. The split is by blast radius, not by HTTP
  method:

  | Flag | Covers |
  |---|---|
  | `PI_MCP_ADMIN` | every read, `admin_explain_egress` included (a `POST`, but it changes nothing) |
  | `PI_MCP_ADMIN_WRITES` | catalog writes that affect only sessions created afterwards: profile put and delete (as in 0050), skill publish, MCP server put, the network status probe |
  | `PI_MCP_ADMIN_DANGEROUS` | every other delete, the settings put and all egress writes |

  Profile delete stays in the writes tier: 0050 shipped it there, and it needs a disabled, non-default profile that no
  new session can pick (0027). A skill or MCP server delete has no such guard in the tool, and a deployment's settings
  and egress rules decide what every running session may reach, so they are one tier up.
- **Reads, aggregated.** `admin_get_catalog` fans out to the six small catalog routes and returns them in one object;
  `admin_get_history` covers the three histories behind one `kind`; `admin_get_status`, `admin_get_egress_status`,
  `admin_get_skill_version` and `admin_list_session_egress_rules` are one route each. The tool list stays short because
  every tool costs the client's context.
- **Skill publish is inline only.** `admin_publish_skill` takes the files in the call (`content` or `contentBase64`),
  never a local path: a tool that reads a path the model names is an exfiltration primitive. It refuses a body over
  ingest's limit before sending and uses a 120 s timeout for that one call. Large or binary skills go through the console
  or curl. There is no tool for `/zip`: the client parses JSON only with a 30 s timeout, so the version read uses
  `?content=true` (UTF-8 files decoded, binary left as base64, about 200 KB in total with `truncated: true`).
- **Writes keep 0023 and 0027.** Every write carries `expectedRevision`; the stale one is ingest's 409. Egress revisions
  are schema-wide and 0 is allowed. `admin_put_mcp_server` binds a OneCLI secret by name only.
- **Session listing.** The routes and the index above are part of this decision, with `docs/session-api.md`. The tools
  `list_sessions` and `list_events` (the existing `GET /events` feed) use the session token and shipped with them;
  `admin_list_sessions` is a read-tier tool on the admin token (the session tools never hold admin rights, 0050). Both
  leave deleted sessions out unless `status` is `deleted`. A test pins that a caller who is not an admin never sees another owner's session id, and no answer
  carries a transcript.
- **Refusals keep their details.** A failed admin call is `{ error, status, details? }`: `details` is the rest of ingest's
  error body (a refused delete's `blockedBy`), scrubbed of both tokens, labelled untrusted and dropped when it is over
  4 KiB. An agent needs it to see what blocks a delete without a second call.
- **Excluded on purpose.**
  - *API tokens.* Ingest reads `PI_API_TOKENS` from its environment and has no Kubernetes API access. Managing them
    would need Secret RBAC or a token table, and would let a prompt-injected admin agent mint durable credentials.
  - *OneCLI secret values and grants.* The values would pass through the model's context, and 0042 keeps the OneCLI admin
    key in the orchestrator. `admin_list_mcp_servers` already returns the secret names, and the put binds by name.
  - *Helm configuration.* Read through `admin_get_catalog`; changed by whoever deploys.
- **One module per domain.** `packages/mcp/src/admin/` has `context.ts` (the shared call, scrub, result, name rules and
  annotations) and one file per domain (`profiles`, `skills`, `mcp-servers`, `egress`, `settings`, `deployment`), each
  registering its tools on an `AdminContext` that carries the three tiers. The client (`SessionApi.admin`) takes `POST`
  and a per-call timeout.

## Security

What each flag lets an agent do, on top of the one before:

| Flag | Capability | Cannot |
|---|---|---|
| `PI_MCP_ADMIN` | read the deployment's configuration, skill contents, histories and every egress decision | read secret values or tokens, or another owner's transcript |
| `PI_MCP_ADMIN_WRITES` | change what new sessions are (profiles, skills that run in sandboxes, credentialed MCP servers), start the status probe | change what an existing session may reach |
| `PI_MCP_ADMIN_DANGEROUS` | allow egress, including private addresses and rules for all sessions; widen the repo and model allowlists; delete catalogs | change Helm values, RBAC or the OneCLI key |

A shell-capable agent can read its own admin token from its MCP config, so the tools add no power beyond the token. They
make misuse by an injected instruction one call away, which is what the tiers and the following limit:

- off by default, tier by tier; the admin token must differ from the session token;
- `destructiveHint` on the dangerous tier (and on profile delete), so clients that ask before destructive calls do;
- `expectedRevision` on every write, and the history tables as the audit trail;
- output scrubbed of both tokens and labelled untrusted, as in 0050; attacker-influenced text is capped;
- no field of any tool carries a secret value (a test walks the input schemas);
- the server instructions stay within their 250-word test.

Use a dedicated admin owner (for example `mcp-admin`) in `PI_API_ADMINS` for the token, so history shows who changed what.

## Consequences

- The adapter stays a client of ingest: no database access, and no new admin route (the session routes above aside).
- Schema-parity tests (like `PROFILE_DEFINITION_SHAPE` for profiles) keep the typed inputs equal to session-core's types.
- A larger tool list costs client context; the aggregated reads and the tiers keep what a given client sees small.
- The manifest, `docs/mcp-adapter.md` (the tool table with its "Since" column) and the tests are one contract.

## Revisit when

- A remote endpoint (0059) needs admin rights per caller instead of one token per process.
- OneCLI scoped keys (0042) make secret handling safe to expose.
