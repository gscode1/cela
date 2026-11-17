# Admin UI plan

Draft for scope agreement, 2026-11-17. This is a follow-on to the [PoC](../plan.md#7-out-of-scope-for-the-poc).

## Scope

An internal operator can configure what a new session receives, review the impact of a change, and see recent
settings and MCP changes and the history of profile definitions. Ingest remains the authority for validation,
authorization, and writes. The [Session API](session-api.md) is the contract.

| Option | Workflow |
| --- | --- |
| A. Defaults and profiles | Manage global settings and publish profile versions. Browse MCP servers and available skill versions. |
| B. Runtime configuration (proposed) | Also register, edit, enable, and disable MCP servers. Include read-only shard status. Choose this scope if operators need to register and attach MCP endpoints from the console. |
| C. Session operations | Add cross-owner session search, diagnostics, and actions such as cancel or delete. This requires a separate API and permission design because sessions are owner-scoped today. |

Use B as the planning baseline, with skill publishing through the existing API. Deployment and credential tooling
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
| MCP servers | Register an HTTPS endpoint, edit its `url`, `timeoutMs` and `maxOutputBytes`, and enable or disable it. Transport is fixed to Streamable HTTP. `onecliSecret` is shown read-only until #42. Show recent changes and current profile references. Reachability is `unknown`. |
| Skills | Browse available versions and file manifests and fetch a version's file contents on demand. Pin exact versions from the profile editor. Mark versions with model invocation disabled, which can be pinned but are omitted from the model's skill catalog. |
| Shard status | Show the last reports from shards: configured runtime, observed sandbox runtime, network policy state, and publish time. An empty list means no reports yet. Distinguish an unobserved runtime (`null`) from the node default (empty string), and show `unknown` policy explicitly. Reports persist through downtime. Offer to run the isolation probe again (`POST /admin/status/probe`). |

Settings and MCP history show at most the newest 500 entries returned by their APIs. Profile diffs compare stored
definitions. An effective preview of an older definition uses current settings. V1 defers MCP deletion
(`DELETE /admin/mcp-servers/{name}` stays API-only), browser skill publishing, connectivity probes, credential
management, and cross-owner session operations.

### Review before saving

| Rule | Enforced by |
| --- | --- |
| Clearing a global `reasoning` or `maxReasoning` sends `null`. Clearing a profile override omits the field from the new definition. Explicit `off` and the difference between omitted and empty tool lists survive a round trip. | API |
| The preview applies the session-creation rules: the allowlist (the default model is always included), then request, profile and settings for model and reasoning. It assumes no caller overrides. Provider availability, credentials and reasoning support are only known at the first turn. | Console (preview), API (at session creation) |
| A save that makes the selected default profile fail admission needs a correction first. Other enabled profiles that would fail get a warning. | Console |
| A new profile version must reference installed tools and existing MCP servers. A reference to a deleted server or a removed tool blocks any change to the definition until the operator removes or replaces it. The editor marks such references and offers to remove them. A disabled server is still in the catalog: references to it save, and its tools are unavailable until it is enabled. | API |
| Pinned skills and repository skills need `read` in both tool lists when those lists are explicit. The editor explains the dependency and leaves tool access to the operator. | API |
| `readOnly` must be declared on create. The console also asks for it again when the URL changes, and before enabling a server without it. | API on create, console otherwise |
| To disable the current default profile, select another enabled one first. A missing, invalid or disabled default is flagged with the same fix. | Console now, API after slice 2 |

Impact of a save:
- Profile versions and skill pins apply to new sessions.
- Repository instructions and skills come from the session's checkout and can refresh during the session.
- A `turnBudget` change applies to sessions that inherit it, from their next input. A session already over the new
  budget fails.
- MCP changes affect existing sessions whose snapshots reference the server.

### Concurrent edits

Today `PUT /admin/settings` checks `defaultProfile` before its write transaction, and disabling a profile does not
check whether it is the default. Two admins can therefore leave a disabled default. Writes to one profile or one MCP
server already serialise per name, and an unknown body key is `400`.

For v1:
- Ingest checks the default-profile selection and the disable of the default inside the write transaction, under one
  lock. This changes API behaviour, so the implementing PR records it in `docs/decisions/` and the Session API.
- Settings, profiles and MCP servers return a revision. A write may send `expectedRevision`. A mismatch is `409` and
  changes nothing. The console always sends it, keeps the draft on a conflict, and offers to reload and compare. API
  clients may omit it.

Out of scope: contract versioning between console and ingest, pausing admin access during rollouts, and revisions
that survive delete-and-recreate. The console ships in the ingest image, so a page and its API come from the same
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
  Add one read, `GET /admin/tools`, that returns the tool names the profile validator accepts (from the orchestrator's
  last publication or the built-in fallback).

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
   disposable e2e deployment, with two admins and one non-admin: sign-in, direct navigation, assets, sign-out, reload,
   distinct `401` and `403`, HTML-like test data rendered as text, and `/console/` 404 when disabled. The existing API
   and probe checks keep passing.
2. **Settings and profiles.** The default-profile guard and `expectedRevision` in ingest, with an ADR. Changes show the
   right actor in history and diffs. Round trips for cleared overrides, explicit `off`, omitted and empty tool lists,
   and skills that need `read`. The admission preview matches real session creation, accepted and rejected. A stale
   draft gets `409` and keeps its contents. Concurrent default selection and disable leave an enabled default.
3. **Catalogs and status.** Browse and pin skills. A profile that references a deleted MCP server shows it and offers
   to remove it. For B, register and attach an MCP endpoint and re-confirm `readOnly` on a URL change. Truthful states
   for disabled MCP servers, unknown reachability and policy, and empty shard reports. For A, catalogs are read-only
   and the status screen is omitted.
4. **Release check.** `pnpm check` and the browser suite. An upgrade and a rollback on a populated disposable database
   keep ordinary session clients working.

## Decisions to confirm

- **MCP registration.** Choose B if operators need to register pre-provisioned endpoints in the console. Choose A if
  they only need to select from an existing catalog.
- **Access.** Start with named tokens on a private route, or require SSO for a shared rollout.
- **Skills.** Keep publication in the API workflow unless operators need to upload new bundles from the console.
