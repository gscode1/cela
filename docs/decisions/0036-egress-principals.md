# 0036: Egress principals: a token per session and the proxy environment of its sandbox

Status: accepted, 2026-11-18 (slice 4 of epic #50, issue #250). Builds on [0035](0035-egress-proxy-runtime.md) (the proxy
runtime, `Principals`), [0034](0034-egress-rules.md) (rule sets, session rules) and [0010](0010-session-profiles.md)
(profile snapshots).

## Context

Slice 3 judges every connection as anonymous: only rule sets with `applies_to_all` apply. To let a session's profile and
its own rules count, the proxy has to know who is asking, and a sandbox has to send its traffic to the proxy with a
credential that names the session and cannot be used by another.

## Decision

### The principal

Migration `026_egress_principals.sql` adds `egress.principals`, one row per session that uses the proxy: `session_id`
(primary key), `token_hash` (sha256 hex; the token is never stored), `token_salt`, `profile_name`, `profile_version`,
`rule_sets`, `pod_ip` (nullable), `created_at`, `updated_at`, `revoked_at`. The orchestrator is the only writer; a trigger
notifies `egress_rules` after every write, the channel the proxy already listens on, so no second listener exists and a
revocation reaches a replica at once (poll: 5 s at worst, a 10 s budget).

**Profile rule sets: a snapshot, not a reference.** `rule_sets` holds the profile's `egressRuleSets` as the session saw them
at creation (taken from the session's own profile snapshot). Profile versions are immutable and a session pins one, so a
reference (`profile_name`, `profile_version`) would resolve to the same list every time; the copy costs nothing and means
the proxy needs no access to schema `inbox` (the single owner per schema stays, and there is a migration test for it). A rule
set that was deleted later simply matches nothing. The profile name and version are kept for explain and audit.

`grant_proxy_reader` now also grants `select` on the principal columns **except `token_salt`** (a column grant), still no
write besides `proxy_status`. With `PI_EGRESS_READER_ROLE` configured, the migrator reapplies missing grants after
upgrading, including for custom reader names (issue #378; see ADR 0035). Without it, a custom reader still needs
`select egress.grant_proxy_reader('<role>')` as the owner after upgrading.

### The token

`token = base64url(HMAC-SHA256(master key, "egress:<session id>:<salt>"))`, 32 bytes, with `salt` random (32 bytes) per
principal and stored beside the hash. The master key is the orchestrator's `PI_SANDBOX_MASTER_KEY`, which already derives the
sandboxd tokens and never leaves the orchestrator. Why not a plain random token: the sandbox env is rebuilt every time the
env opens (idle eviction, orchestrator restart), and a random token would need to be stored in the clear to be handed out
again, or rotated each time, which breaks long-running processes in a sandbox that survives the restart (a dev server, a
`git` in the background). Derived, it is the same token every time and the database holds a hash and a salt only. A token
that the database does not know is unforgeable without the master key. The token is a `Redacted` in the orchestrator and is
never logged (tests check the proxy log, the admin responses and the table).

### The sandbox environment (plain sessions)

With `egressProxy.enabled` the chart sets `PI_EGRESS_PROXY_URL` on the orchestrators. For a session without a repository the
orchestrator hands the sandbox, per command (pi-env `shellEnv`): `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy` =
`http://x:<token>@pi-egress-proxy.<ns>.svc:3128`, `NO_PROXY`/`no_proxy` = `localhost,127.0.0.1,::1`,
`NODE_USE_ENV_PROXY=1` and git's `http.proxyAuthMethod=basic`. Without the value nothing changes: no principal, no variable.
The proxy answers `CONNECT` only, so a plain `http://` request through `HTTP_PROXY` is refused (405); use https. (A client that
sends plain HTTP to a proxy would otherwise be one more thing to judge.)

The orchestrator creates the principal when the sandbox attaches (`attached` hook of `Sandboxes.#open`), **before** the env is
returned to the first tool call, and writes the Pod's IP in the same step.

### Repo sessions keep OneCLI until slice 5 (superseded by [0037](0037-egress-onecli-route.md): `usesEgressProxy` is gone, repo sessions use the proxy)

A repo session sends HTTPS through the OneCLI gateway with its OneCLI agent token (`buildShellEnv`, unchanged), because
the gateway is where the repo-scoped GitHub token is injected. Putting such a session on the proxy before the proxy chains
OneCLI behind it (slice 5) would break its clone and push. So `usesEgressProxy(session)` (`orchestrator/src/egress.ts`) says
`session.repo === null`, and `main.ts` picks the env by it: slice 5 changes that one function and routes repo sessions
through the same `EgressPrincipals`. Until then a repo session has no principal.

### The proxy

- `Proxy-Authorization: Basic x:<token>` is hashed and looked up in the snapshot (principals are in the same one-statement read
  as the rules, so a request is judged on one revision; only principals that are not revoked are read). Evaluation uses the
  principal's session id and rule sets: session rules, the profile's sets and the sets that apply to all.
- **Unknown or revoked token: 407, never anonymous.** A revoked sandbox must not fall back to the open rules.
- **Source IP binding.** A known token is accepted only from the principal's `pod_ip`: "A's token from B's Pod" is a 407. The
  address is the TCP peer of the proxy (NetworkPolicy-enforced pod addresses are not rewritten inside the cluster).
- **Pod IP not recorded yet: deny** (fail closed). It cannot hit the first tool call in practice: the orchestrator writes the
  principal and the address together, before the env opens, and the notification reaches the proxy in well under a second. If
  the Pod's address could not be read, the session's proxy traffic is refused until the next attach or check, which is
  visible in `GET /admin/egress/status` (`principals.withPodIp` below `principals.active`).
- **A replaced Pod** (a crash, an eviction, a recycle after an interrupted command) has a new address. A new attach writes it;
  for a Pod replaced behind an open env, `beforeUse` re-reads the address at most every 10 s, so the token is refused for up
  to that long after a crash. A dual-stack Pod is bound by its primary address.
- **Anonymous requests** (no header) are judged by the sets that apply to all, as in slice 3. `egressProxy.requireAuth: true`
  (`EGRESS_REQUIRE_AUTH`) refuses them instead. The default stays `false` until the network cutover (slice 6): until then
  sandboxes still have direct internet and the proxy is reachable by test clients and non-session callers that have no
  token; requiring one there would only break them. Slice 6 should turn it on.

### Revocation

`SessionService.#delete` revokes the principal (sets `revoked_at`, clears `pod_ip`) right after the OneCLI teardown and
before the sandbox is destroyed, so the token is dead from the next notification whatever happens to the claim. The orphan
sweep revokes the principal of any deleted session and, on shard 0, of an unknown one (`revoke-egress`, first in the action
list so the action limit cannot starve it). A revoked row stays for audit; a deleted session never gets a new principal
(`ensurePrincipal` returns nothing for a revoked row). The principal's open tunnels are closed on the next snapshot ([0039](0039-egress-revocation.md)).

### Admin

`GET /admin/egress/status` gains `principals: { active, withPodIp, revoked }` (counts only). `POST /admin/egress/explain` with
a `sessionId` and no `profile` uses the principal's stored rule sets and says so (`profileSource: "principal"`); a named profile
wins (`"profile"`), no principal means only the sets that apply to all (`"none"`). The admin console's Explain page says it.

## Consequences

- Sandboxes still have direct internet until slice 6; this slice only makes proxy-aware tools use the proxy. With
  `egressProxy.enabled` the chart renders one additive sandbox policy, `sandbox-allow-egress-proxy-egress` (TCP 3128 to the
  proxy pods only); every other sandbox policy is unchanged, so it opens no destination. Slice 6 designs the network modes.
- Plain `http://` through the proxy variables fails (CONNECT only); package managers that use http mirrors need https.
- Tokens live in the sandbox's command environment, readable by the agent: what bounds them is the session's rules, the
  address binding and deletion.
- Slice 5 changes `usesEgressProxy` and adds the OneCLI chain; slice 6 adds the sandbox-to-proxy policy and `requireAuth`.
