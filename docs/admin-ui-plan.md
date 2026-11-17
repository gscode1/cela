# Admin UI plan

Draft for scope agreement, 2026-11-17. This is a follow-on to the [PoC](../plan.md#7-out-of-scope-for-the-poc).

## Scope

An internal operator can configure what a new session receives, review the impact of a change, and see recent
settings and MCP changes and the history of profile definitions. Ingest remains the authority for validation,
authorization, and writes. The [Session API](session-api.md) is the contract.

| Option | Workflow |
| --- | --- |
| A. Defaults and profiles | Manage global settings and publish profile versions. Browse MCP servers and available skill versions. |
| B. Runtime configuration (proposed) | Also manage the catalogs: register, edit, enable, disable, and delete MCP servers, and publish skill versions. Attach both to profiles. Include read-only shard status. |
| C. Session operations | Add cross-owner session search, diagnostics, and actions such as cancel or delete. This requires a separate API and permission design because sessions are owner-scoped today. |

Use B as the baseline. Deployment and credential tooling
manages admin access, model credentials, OneCLI egress rules, images, shard scaling, and sandbox resources. MCP
registration targets endpoints covered by existing OneCLI host rules that require no server credentials under the
[current MCP integration](decisions/0007-native-remote-mcp.md).

The console serves one install and has no tenant switcher. If installs become the tenant boundary, each tenant gets
its own console and admin list, and scope C becomes a tenant-admin scope within one install.

## Screens and controls

| Screen | Controls and information |
| --- | --- |
| Global settings | `defaultModel`, `allowlist`, `reasoning` and `maxReasoning`, `defaultProfile`, and `turnBudget`. Show previous and new values, actor, and time from recent history. |
| Session profiles | Create a profile, publish a version, and enable or disable it for new sessions. Edit instructions, `tools` and `modelTools`, model and reasoning overrides, `turnBudget`, MCP references, and exact skill pins. Toggle loading instructions and skills from the repository checkout. Show invalid profiles with their validation errors, diff stored definitions, and show the last actor and timestamp. Enable and disable update this metadata without a new version. |
| MCP servers | Register an HTTPS endpoint, edit its `url`, `timeoutMs` and `maxOutputBytes`, enable or disable it, and delete it. Transport is fixed to Streamable HTTP. `onecliSecret` is shown read-only until #42. Show recent changes and current profile references. Delete names the profiles that still reference the server and suggests disabling instead. Reachability is `unknown`. After a save, offer to add the server to a profile. |
| Skills | Publish a new version (see [Skill upload](#skill-upload)). Browse versions and file manifests and fetch a version's file contents on demand. Pin exact versions from the profile editor, and show which profiles pin each version. Mark versions with model invocation disabled, which can be pinned but are omitted from the model's skill catalog. After a publish, offer to pin the new version in a profile. |
| Shard status | Show the last reports from shards: configured runtime, observed sandbox runtime, network policy state, and publish time. An empty list means no reports yet. Distinguish an unobserved runtime (`null`) from the node default (empty string), and show `unknown` policy explicitly. Reports persist through downtime. Offer to run the isolation probe again (`POST /admin/status/probe`). |

Settings and MCP history show at most the newest 500 entries returned by their APIs. Profile diffs compare stored
definitions. An effective preview of an older definition uses current settings. V1 defers connectivity probes,
credential management, and cross-owner session operations.

Attaching a skill or an MCP server to a profile always publishes a new profile version, so it applies to new sessions
only. Skill versions are immutable: a new version reaches a profile only when someone pins it.

### Skill upload

- **Input.** A folder (directory picker) or a `.zip`, unpacked in the browser. The console sends the files to
  `POST /admin/skills/{name}/versions`: text as `content`, everything else as `contentBase64`, with the executable bit
  taken from the zip or set in the review step (a folder picker cannot read it). The API enforces the limits:
  `SKILL.md` with a `description` in its frontmatter, at most 128 files and 5 MiB, regular files only.
- **Review before publishing.** Show the parsed name and description, and per file the path, size, sha256 and
  executable flag. Text files are readable inline, binaries by digest only. Show the diff against the current version.
  Publishing deploys code that runs in every session that pins it, so the step names that and asks to confirm.
- **Scripts and binaries.** Files marked executable are `chmod 755` in the sandbox, and the model runs them with the
  bash tool. The editor warns when a profile pins such a skill without `bash` in its tool lists. Runtimes such as
  Python come from the sandbox image, not from skills. Binaries must match the nodes' architecture; the console only
  states that.
- **Identical content** returns `200` with no new version. The console says so instead of reporting a publish.

### Review before saving

| Rule | Enforced by |
| --- | --- |
| Clearing a global `reasoning` or `maxReasoning` sends `null`. Clearing a profile override omits the field from the new definition. Explicit `off` and the difference between omitted and empty tool lists survive a round trip. | API |
| The preview applies the session-creation rules: the allowlist (the default model is always included), then request, profile and settings for model and reasoning. It assumes no caller overrides. Provider availability, credentials and reasoning support are only known at the first turn. | Console (preview), API (at session creation) |
| A save that makes the selected default profile fail admission needs a correction first. Other enabled profiles that would fail get a warning. | Console |
| A new profile version must reference installed tools and existing MCP servers. A reference to a deleted server or a removed tool blocks any change to the definition until the operator removes or replaces it. The editor marks such references and offers to remove them. A disabled server is still in the catalog: references to it save, and its tools are unavailable until it is enabled. | API |
| Pinned skills and repository skills need `read` in both tool lists when those lists are explicit. The editor explains the dependency and leaves tool access to the operator. | API |
| `readOnly` must be declared on create. The console also asks for it again when the URL changes, and before enabling a server without it. | API on create, console otherwise |
| To disable the current default profile, select another enabled one first. A missing, invalid or disabled default is flagged with the same fix. | API (`409` on disable, `400` on selecting a bad default, [ADR 0023](decisions/0023-admin-revisions.md)); the console shows the fix |

Impact of a save:
- Profile versions and skill pins apply to new sessions.
- Repository instructions and skills come from the session's checkout and can refresh during the session.
- A `turnBudget` change applies to sessions that inherit it, from their next input. A session already over the new
  budget fails.
- MCP changes affect existing sessions whose snapshots reference the server.

Slice 2 as built:
- The preview lives in `packages/admin-ui/src/lib/admission.ts`, a pure module that cites the ingest and session-core
  functions it mirrors. The reasoning levels include `max`, as `THINKING_LEVELS` does.
- A profile in `invalid` has no `revision`, so the console lists it with its errors but does not edit it; publish a complete
  definition through the API.
- Creating a profile cannot send `expectedRevision`. The console refuses a name that already exists in the list it loaded,
  but a create that races another create of the same name becomes a new version.
- Enable and disable (no new version) update the open draft's revision when the draft is of the same version, so they do not
  make it stale.
- The model and reasoning pickers offer the allowlist and the levels; a stored model outside the allowlist is shown flagged.

### Concurrent edits

Before [ADR 0023](decisions/0023-admin-revisions.md), `PUT /admin/settings` checked `defaultProfile` before its write
transaction and disabling a profile did not check whether it was the default, so two admins could leave a disabled default.
Writes to one profile or one MCP server already serialised per name, and an unknown body key is `400`.

Done in the API by ADR 0023:
- Ingest checks the default-profile selection and the disable of the default inside the write transaction, under one
  lock. Disabling the default is `409`; selecting a disabled or missing default is `400`.
- Settings, profiles and MCP servers return a `revision`. A write may send `expectedRevision`. A mismatch is `409` and
  changes nothing. API clients may omit it.

For the console: always send `expectedRevision`, keep the draft on a conflict, and offer to reload and compare.

Out of scope: contract versioning between console and ingest, pausing admin access during rollouts, and revisions
that survive delete-and-recreate (a stale MCP draft can overwrite a server deleted and created again under the same
name). The console ships in the ingest image, so a page and its API come from the same
build, and a reload after an upgrade is enough.

## Stack and delivery

- **Frontend.** A pnpm workspace package at `packages/admin-ui` with React, TypeScript, and Vite. Use shadcn/ui and
  Tailwind CSS for the components and styling. Use a typed `fetch` client and TanStack Query for reads and mutations.
  Keep API types browser-safe with type-only imports or DTOs. Bundle dependencies locally.
- **Serving.** Build the console for `/console/` and ship a self-contained HTML entry point with bundled JavaScript
  and CSS in the ingest image. The [image build](../images/ingest/Dockerfile) builds only ingest and its dependency
  closure, so build and copy the console output explicitly. Serve console GET and HEAD requests before the bearer gate.
  Limit navigation fallback to console routes and return 404 for unknown files.
- **Headers.** On console and admin responses: `Cache-Control: no-store`,
  `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and
  `Referrer-Policy: no-referrer`.
- **Switch.** The chart gets `console.enabled`, default `false`. When it is off, `/console/` is 404.
- **API.** Reuse `/admin/settings`, `/admin/profiles`, `/admin/mcp-servers`, `/admin/skills`, and `/admin/status`.
  `GET /admin/tools` returns the tool names the profile validator accepts (from the orchestrator's last publication or
  the built-in fallback), and `GET /admin/skills/{name}/versions/{v}/zip` downloads a version (both added by ADR 0023).

## Admin credentials and login

V1 uses the existing named bearer tokens. In the [Helm chart](../charts/pi-durable/README.md), `api.admins` lists the
owners allowed to call `/admin/*`, and `api.existingSecret` (default `api-auth`) holds one `owner:token` line per
owner. `hack/install.sh` creates that Secret with a token for each `api.admins` name, and warns about an admin without
a token when the Secret already exists. Use one name per operator. The token also carries that owner's session API
access. Token changes take effect after the ingest pods restart.

Access goes through a localhost port-forward or a restricted HTTPS route. The chart ships no Ingress, and a
NetworkPolicy cannot filter by path. Where ingest also serves ordinary clients, the installer's ingress must route
`/console` and `/admin` only through operator access.

1. The operator opens `/console/`, enters their token, and the UI checks it with `GET /admin/settings`.
2. `401` means an invalid token, `403` a valid owner without admin access. Successful writes record the operator as
   `updatedBy` and in the history.
3. The token lives in browser memory only and goes in the `Authorization` header to the same origin. Sign-out clears
   the token, cache, and drafts. A reload asks for the token again. All API content (metadata, diffs, errors, file
   previews) renders as text.

Ingest already compares tokens in constant time. Rate limiting failed logins is left to the ingress in v1.

SSO is an open decision (below). It would map a verified issuer and subject to an admin grant and an actor name, and
replace `PI_API_ADMINS`.

## Implementation slices and acceptance

1. **Console shell and access.** `/console/`, token login, headers, `console.enabled`. A browser suite against a
   disposable e2e deployment, with an admin and a non-admin (the run's `api-auth` has `alice` and `bob`; a second admin
   adds nothing to this slice, see [ADR 0024](decisions/0024-admin-console-serving.md)): sign-in, direct navigation, assets, sign-out, reload,
   distinct `401` and `403`, HTML-like test data rendered as text, and `/console/` 404 when disabled. The existing API
   and probe checks keep passing.
2. **Settings and profiles.** The default-profile guard and `expectedRevision` in ingest, with an ADR (API done: ADR 0023). Changes show the
   right actor in history and diffs. Round trips for cleared overrides, explicit `off`, omitted and empty tool lists,
   and skills that need `read`. The admission preview matches real session creation, accepted and rejected. A stale
   draft gets `409` and keeps its contents. Concurrent default selection and disable leave an enabled default.
3. **Catalogs and status.**
   - Skills: upload a folder and a zip with a script and a small binary, review, publish, pin to a profile; a new
     session finds the files under `/workspace/.skills/` with the executable bit set and runs the script. Identical
     content creates no version. A bad frontmatter or an oversized bundle shows the API error and publishes nothing.
   - MCP: register, attach to a profile, re-confirm `readOnly` on a URL change, disable, and delete with the
     referencing profiles named. A profile that references a deleted server shows it and offers to remove it.
   - Truthful states for disabled MCP servers, unknown reachability and policy, and empty shard reports. For A,
     catalogs are read-only and the status screen is omitted.
4. **Release check.** `pnpm check` and the browser suite. An upgrade and a rollback on a populated disposable database
   keep ordinary session clients working.

## Decisions to confirm

- **Scope.** B, with skill upload and MCP management in the console (owner's choice, 2026-11-17).
- **Access.** Start with named tokens on a private route, or require SSO for a shared rollout.
- **Catalog repository.** Decided 2026-11-17: console management now, a catalog repository later (below).

## Later: a catalog repository

An install could name a Git repository as the source of its skills and MCP servers:

```text
skills/<name>/SKILL.md, scripts, binaries
mcp-servers.yaml        # every field: name, url, transport, readOnly, timeoutMs, maxOutputBytes, onecliSecret, enabled
```

Git gives versioning, review by pull request, history, and rollback for free. The database still keeps the published
copies:
- A session must get the same bytes on every reopen (after a suspend, a Pod recycle or a restart), for its whole life.
  A commit can disappear after a force-push, and GitHub can be down or rate-limited when a sandbox opens.
- Profiles pin by digest, and the orchestrator already writes skills from the database without network access.

So the repository is the source and the database the published store. A sync step reads the repository at a commit,
publishes each changed skill through `POST /admin/skills/{name}/versions` (an unchanged skill creates no version), and
applies `mcp-servers.yaml` through `PUT /admin/mcp-servers/{name}`. The commit SHA goes in the optional `source` field of a skill version or
MCP server (reserved by ADR 0023).

| Sync runs in | Pros | Cons |
| --- | --- | --- |
| The repository's CI, with an admin token | No new code in the stack; works with any Git host | The admin token lives in CI |
| An ingest job or button, using the GitHub App | One place to configure; the console shows the synced commit | New code and egress to GitHub from ingest |

With a catalog repository, the console shows skills and MCP servers read-only with their commit, and still pins them
in profiles. One writer per catalog avoids the console and the repository overwriting each other. This is separate
from repo skills ([ADR 0014](decisions/0014-repo-skills.md)), which come from the session's own repository.

**Decision:** console management ships first. The catalog repository comes later as a per-install switch, starting
with CI sync, which needs no GitHub access in ingest. Publishing and unchanged MCP writes are already idempotent, so a
sync is a thin client of the admin API.

**Commitments now**, so the repository stays cheap to add:
1. The console writes skills and MCP servers only through the public admin API.
2. Each skill version can be downloaded as a zip that keeps the executable bit (done: `GET /admin/skills/{name}/versions/{v}/zip`).
3. The skill and MCP screens have a read-only mode from the start.
4. Skill versions and MCP servers reserve an optional `source` (repository and commit), kept out of the digest (done in the
   API, ADR 0023; identical files with another `source` create no version).
5. Retiring a skill is defined before the repository lands: versions cannot be deleted and skills have no disable flag
   today, so a skill removed from the repository would stay published and pinnable.
6. A publish never moves profile pins. Pinning in the console stays the gate for what sessions get.
7. A sync sends complete MCP bodies, because `PUT` lays the body over the stored row.

**Risks to design for then:**
- Merge rights on the catalog repository equal deploying code into sandboxes.
- The GitHub App mints `contents: write` tokens for session repositories. A catalog repository needs a separate
  read-only token and must never be usable as a session repository.
- An MCP server missing from the YAML is disabled, not deleted: deletion breaks profile edits and live sessions. This
  needs a full-set reconcile that per-name `PUT` does not give.
- A sync is a series of calls without one transaction. It must be re-runnable and report the last fully applied
  commit.
- Line-ending conversion or a lost executable bit in the checkout creates spurious versions. A revert creates a new
  version with an old digest, because the no-op check compares with the current version only.
- One writer per install is enforced by ingest (a "managed by" setting), not only by the console.
- A webhook needs inbound access to the stack; CI push or polling does not.
