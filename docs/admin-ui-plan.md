# Admin UI plan

Draft for scope agreement, 2026-11-17. This is a follow-on to the [PoC](../plan.md#7-out-of-scope-for-the-poc).

## Scope

An internal operator can configure what a new session receives, review the impact of a change, and see recent
settings and MCP changes and the history of profile definitions. Ingest remains the authority for validation,
authorization, and writes. The [Session API](session-api.md) is the contract.

| Option | Workflow |
| --- | --- |
| A. Defaults and profiles | Manage global settings and publish profile versions. Browse MCP servers and available skill versions. |
| B. Runtime configuration (proposed) | Also register, edit, enable, and disable MCP servers. Include read-only shard observations. Choose this scope if operators need to register and attach MCP endpoints from the console. |
| C. Session operations | Add cross-owner session search, diagnostics, and actions such as cancel or delete. This requires a separate API and permission design because sessions are owner-scoped today. |

Use B as the planning baseline, with skill publishing through the existing API. Deployment and credential tooling
manages admin access, model credentials, OneCLI egress rules, images, shard scaling, and sandbox resources. MCP
registration targets endpoints covered by existing OneCLI host rules that require no server credentials under the
[current MCP integration](decisions/0007-native-remote-mcp.md).

## Screens and controls

| Screen | Controls and information |
| --- | --- |
| Global settings | Default model, model allowlist, default reasoning effort and cap, default profile, and session model-turn limit. Show previous and new values, actor, and time from recent history. |
| Session profiles | Create a profile, publish a version, and enable or disable it for new sessions. Edit instructions, enabled coding tools and the subset offered to the model, model and reasoning overrides, turn limit, MCP references, and exact skill pins. Toggle loading instructions and skills from the repository checkout. Show invalid profiles with their validation errors, diff stored definitions, and show the last actor and timestamp. Enable and disable changes update this metadata without creating a history entry. |
| MCP servers | Register an HTTPS endpoint, edit its URL, timeout and output limit, and enable or disable it. Require a stateless and read-only declaration on registration and URL replacement, and before enabling an entry without an affirmative declaration. Transport is fixed to Streamable HTTP. Show recent changes and current profile references. Reachability is unknown. |
| Skills | Browse available versions and file manifests and fetch a version's file contents on demand. Pin exact versions from the profile editor. Mark versions with model invocation disabled, which can be pinned and staged but are omitted from the model's skill catalog. |
| Shard status | Show the last reports from shards, with configured runtime, observed sandbox runtime, policy state, and publish time. An empty list means no reports have been published. Distinguish an unobserved runtime (`null`) from node-default runtime (empty string) and show unknown policy explicitly. Reports can persist through downtime. |

Settings and MCP history show at most the newest 500 entries returned by their APIs. Profile diffs compare stored
definitions. An effective preview of an older definition uses current settings. V1 defers permanent MCP deletion,
browser skill publishing, connectivity probes, credential management, and cross-owner session operations.

### Review before saving

- Show inherited values and explicit overrides side by side. Clearing a global reasoning default or cap sends `null`.
  Clearing a profile override omits the field from the replacement definition. Preserve explicit `off` and the
  difference between omitted and empty tool lists.
- Preview changes against the same allowlist and reasoning rules as session creation, including automatic inclusion
  of the global default model in the allowlist. Model and reasoning resolve from the request, profile, then global
  settings. Preview admission with no caller overrides. Provider availability, credentials, and reasoning support
  affect the actual turn at runtime. Flag enabled profiles that would fail admission. Require a correction before
  a console save that would make the selected default fail admission. For other enabled profiles, show an advisory
  warning. The API enforces policy at session creation and can return `400` after a configuration save.
- Preserve unresolved MCP and installed-tool references in existing profiles until the operator removes or replaces
  them explicitly. Distinguish a disabled MCP server from a missing one. Disabled references can be saved but their
  tools are unavailable until enabled. Changes to a profile definition must pass catalog validation. Pinned skills
  and repository skills require `read` in both tool lists when those lists are explicit. Explain the dependency in
  the editor and leave any change to tool access to the operator.
- Profile versions and skill pins apply to new sessions. Repository instructions and skills come from the session's
  checkout and can refresh during the session. A global model-turn limit change applies to sessions that inherit it
  on their next input after the shard observes the new settings. A session that has exhausted the new limit can fail
  permanently. MCP changes can affect existing sessions whose snapshots reference the server. Current profile
  references cover current definitions only.
- To disable the current default, first select a valid enabled replacement. Flag a missing, invalid, or disabled
  default and offer the same recovery. A valid disabled default can also be re-enabled. Repair an invalid profile
  definition through the existing API.

### API consistency and concurrent edits

- Ingest checks default selection and disable inside their write transactions under the same lock, acquired in a
  consistent order before validation. This applies to writes with or without a revision and changes the existing
  API behavior for attempts to disable the current default. For the console's default marker, use the authoritative
  settings read.
- For both named and implicit session creation, read the settings and selected profile from one database snapshot.
  If current settings are unreadable or invalid, preserve the documented last-known-good fallback. Take the default
  and model policy from the same fallback settings object. A missing, disabled, or invalid profile keeps its existing
  error behavior. With no usable settings, report the service as unavailable.
- Return an opaque revision for settings, profiles, and MCP servers. Add database-maintained revisions that advance
  on insert and changes made by old and new binaries. A profile revision covers definition and enable state. An MCP
  server created again under a deleted name gets a distinct revision. Keep the migration compatible with old images.
- Bind each draft to the revision it was opened with, including during background refresh. The console sends
  `expectedRevision` in the write body and uses a create-only precondition for new profiles and servers. Check it
  in the transaction and return a distinct conflict code. Preserve the signed-in operator's draft on errors and
  offer to reload and compare. The precondition is optional for API clients. The console only retries a write with its
  precondition intact.

## Stack and delivery

- **Frontend.** A pnpm workspace package at `packages/admin-ui` with React, TypeScript, and Vite. Use shadcn/ui and
  Tailwind CSS for the components and styling. Use a typed `fetch` client and TanStack Query for reads and mutations.
  Keep form drafts local to the signed-in operator. Use the validated write response for immediate feedback and
  refresh related records and history. Keep API types browser-safe with type-only imports or DTOs.
- **Serving.** Build the console for `/console/` and ship a self-contained HTML entry point with bundled JavaScript
  and CSS in the existing ingest image. This keeps a page and its assets on one build across replicas.
  The [current image build](../images/ingest/Dockerfile) builds only ingest and its dependency closure, so build and
  copy the console output explicitly. Serve console GET and HEAD requests before the API bearer gate. Limit navigation
  fallback to console page routes. Return 404 for unknown resources. Use `Cache-Control: no-store` for admin responses
  and the console entry point. Keep the API same-origin in production and use a development proxy locally.
- **Rollouts.** Enable the console once all ingest replicas support its write contract. Publish the contract version
  through an authenticated admin read and send it with the revision precondition in every console write. Ingest rejects
  incompatible versions before mutation, even for an already-open tab with a matching data revision. Older handlers
  reject the extra body fields. Disable saving when the console cannot establish compatibility and prompt the operator
  to reload after an incompatible change.
- **Incompatible updates.** Close hosted operator paths and pause direct admin access during an incompatible upgrade
  or rollback. Include localhost port-forwards and API-only admin automation such as skill publishing in that pause.
  Keep the ordinary session API available. Use additive migrations and verify old images against the upgraded database.
  Once all old writers are drained, check the selected default before reopening. A rollback to a release without the
  console resumes legacy API access after rollout while the console stays closed.
- **API.** Reuse `/admin/settings`, `/admin/profiles`, `/admin/mcp-servers`, `/admin/skills`, and `/admin/status`.
  Expose the same tools list that the write validator uses, from the orchestrator's last publication or the built-in
  fallback. Document the revision precondition, compatibility check, default-profile guard, and session read behavior
  in the Session API when implemented.

## Admin credentials and login

For a private v1, use the existing named bearer tokens through a localhost port-forward or restricted HTTPS ingress.
Where ingest already serves ordinary clients, allowlist ordinary session and probe paths at that ingress. Route
the `/console` and `/admin` trees only through operator access. Kubernetes NetworkPolicy restricts Service access at
the network level. Provision one `owner:token` entry per operator in the Secret's `tokens` key. In the
[Helm chart](../charts/pi-durable/README.md), select the Secret with `api.existingSecret` (default `api-auth`) and
set `api.admins` to the authorized names. Ingest receives the allowlist as `PI_API_ADMINS`. The existing
[bootstrap script](../deploy/gen-api-secret.sh) seeds example owners. Use actual operator names for shared deployments.
The token carries the named owner's existing API permissions, including session API access. Token changes take effect
after the pods that consume the Secret restart.

1. The operator opens `/console/`, enters their token, and the UI checks it with an authenticated admin read.
2. Ingest distinguishes an invalid token (`401`) from a valid owner without admin access (`403`). Successful writes
   retain the operator's identity in settings and MCP history, profile versions, or profile last-update metadata,
   according to the operation.
3. Hold the token in browser memory only and send it in the `Authorization` header to the same-origin API. Clear the
   token, cache, and drafts on sign-out, account switch, or rejection of the current login. Ignore completions and
   retries from the previous login, including late `401` responses. A write already received by ingest can still
   commit under the original operator. Reloading requires sign-in again. Render all API content, including metadata,
   diffs, errors, and file previews, as inert text. Bundle dependencies locally.

If day-one access requires SSO, choose it before implementing login. Map the verified issuer and subject to an admin
grant and a durable actor identity. If a proxy supplies identity, strip client-supplied identity headers and accept
identity assertions only from an authenticated proxy connection. Cookie-backed login requires secure cookies and
CSRF protection on admin writes. Include both API authorization and actor attribution in the SSO acceptance checks.

## Implementation slices and acceptance

1. **Console shell and access.** Build `/console/` and the chosen login flow. Add a browser suite against a disposable
   e2e deployment. The existing driver covers HTTP and SSE. Supply two admin identities and a valid non-admin for
   the browser tests. Verify sign-in, direct navigation, assets, sign-out, reload, and distinct `401` and `403`
   handling. Switch operators with a dirty form and delayed read and write responses. Verify that the new login
   starts with a fresh cache and draft, and retains its session after a late rejection. Render HTML-like test data
   as text. Keep the existing API and probe checks.
2. **Settings and profiles.** Verify changes appear with the correct actor in recent history and definition diffs.
   Test round trips for clearing overrides, explicit `off`, omitted and empty tool lists, and skills that require
   `read`. Compare the admission preview to successful and rejected session creation. Check actual snapshot values
   before and after a new profile version, and run one scripted model turn from a new session.
   - In the browser, refresh data while a draft is open and verify that saving still uses its original revision.
     With disposable Postgres, test stale updates and duplicate creates without extra versions or history. Use two
     connections and barriers so both default-selection and disable race orderings genuinely overlap.
   - Prime replica B with the former default and delay its cache refresh. Switch the default and policy on A, then
     disable the former default. Target B directly for the console default marker and named and implicit session
     creation. Test fallbacks for invalid settings and recovery from an invalid or disabled default.
3. **Catalogs and status.** Browse and pin skills in either scope. Test an unrelated profile edit after MCP deletion
   or a tool disappears. Preserve and surface unresolved references. For B, register and attach an MCP endpoint,
   test URL re-attestation, and verify a stale draft conflicts after API deletion and recreation under the same name.
   Show truthful states for disabled MCP entries, unknown reachability and policy, and empty shard reports. Verify
   impact messaging for live MCP edits and global turn-limit changes. For A, catalogs stay read-only and the status
   panel is omitted.
4. **Release verification.** Run `pnpm check` and the browser suite. Use the same populated disposable database to
   upgrade, write, roll back, make an unconditional legacy write, and upgrade again. Exercise old and new replicas
   directly, including an open tab carried across the rollout. Verify the old image starts and serves its API, stale
   drafts conflict, incompatible writes leave state unchanged, and ordinary session clients keep working.
   For hosted access, use a representative ingress fixture or verify the intended deployment ingress. First show
   a normal session route working, then verify both operator path trees are denied there and reachable through the
   restricted route. A port-forward-only test exercises the direct-access procedure.

## Decisions to confirm

- **MCP registration.** Choose B if operators need to register pre-provisioned endpoints in the console. Choose A if
  they only need to select from an existing catalog.
- **Access.** Start with named tokens on a private route, or require SSO for a shared rollout.
- **Skills.** Keep publication in the API workflow unless operators need to upload new bundles from the console.
