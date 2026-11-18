# 0040: MCP traffic stays orchestrator to OneCLI with a per-session agent; the catalog derives egress rules; a reconciler keeps OneCLI's host rules

Status: accepted, 2026-11-18 (slice 8 of epic #50, issue #258; completes #42). Builds on [0007](0007-native-remote-mcp.md)
(MCP is called from the orchestrator), [0009](0009-mcp-catalog-in-postgres.md) (the catalog), [0010](0010-session-profiles.md)
(profiles name servers), [0034](0034-egress-rules.md) (rule sets), [0036](0036-egress-principals.md) and
[0037](0037-egress-onecli-route.md) (principals, the OneCLI route, bindings), [0039](0039-egress-revocation.md) (tunnels) and
[0022](0022-bundled-onecli.md) (bundled OneCLI). Amends the epic's line "MCP catalog rows derive rules for an
`orchestrator-mcp` principal".

## Context

The epic planned that the orchestrator's MCP calls would reach servers as an `orchestrator-mcp` principal of the egress
proxy, and that host rules in OneCLI would follow `route=onecli` rules automatically. Issue #42 asks that a session's
credentialed MCP calls carry only that session's grants. Today the orchestrator calls every MCP server through the OneCLI
gateway with one orchestrator-wide agent token (0007), so any credential it can use serves every session, and an MCP host
must also be opened by hand in OneCLI's host rules (`hack/onecli-host-rules.sh`, 0009).

## Decision

### 1. Where MCP traffic flows: direct to OneCLI, as the session's own agent

**The orchestrator's MCP calls do not go through the egress proxy.** They keep the path of ADR 0007, orchestrator to the
OneCLI gateway to the server, and a credentialed server's calls use the session's own OneCLI agent instead of the orchestrator's
token. Servers without a secret keep the orchestrator-wide token: nothing about them is session-specific.

Why not the proxy as an `orchestrator-mcp` principal:

- The proxy exists to judge **untrusted sandbox code** (0034, 0036). Its principals are bound to a Pod address (0036); the
  orchestrator is trusted platform code that has no such address to bind, and several orchestrator replicas and shards call
  from changing addresses. An `orchestrator-mcp` principal would need a new kind of principal, source binding by
  NetworkPolicy alone, an orchestrator-side proxy client and a new orchestrator-to-proxy policy, to put one more hop in front
  of the gateway the orchestrator already reaches for every model call.
- Per-session credential isolation does not need the proxy. It needs one OneCLI agent per session with the right grants,
  which is what 0037 already does for repo sessions. The gateway enforces it where the credential is injected.
- It would give a second reason to widen the proxy (a principal that may reach private MCP hosts, a binding for a process
  that is not a session). The proxy stays a sandbox-only control.

Why not a shared agent: one token that holds every session's MCP secrets is the problem #42 describes.

MCP hosts stay under egress rules in two ways. The catalog **derives rules** (section 2), and the **OneCLI host rules**, the
gateway's allowlist that gates the orchestrator's own calls, are **reconciled from them** (section 3). The sandbox cannot use
an MCP route: the derived set applies to no session and no profile may name it, so a sandbox's own connection to an MCP host
is judged by its own rule sets and is denied unless an admin gave it one.

### 2. Derived rules: the system set `mcp-catalog`

Migration `029_egress_system_sets.sql` adds `egress.rule_sets.system` (a check keeps a system set from applying to all) and
seeds the set `mcp-catalog`.

- **Contents.** One `allow` rule per host of an **enabled** catalog server, on the URL's port (443 by default): `route=onecli`
  when any server on that host names a `onecliSecret`, `direct` otherwise, with the servers named in the note. One rule per
  host so two servers on one host never name two routes (two routes for a host are a deny, 0034). A server whose URL names an
  IP address, or a host the rule validator refuses, gets no rule (skipped, with the reason, by `deriveMcpRules`). A disabled or
  deleted server has none.
- **Same transaction.** `putMcpServer` and `deleteMcpServer` take a `within(client)` hook that runs after the row and its
  history are written and before the commit. Ingest passes `syncMcpRulesFromCatalog`, which reads the catalog as the
  transaction sees it and rewrites the set: it creates, changes or removes only the rules that differ, each with a history entry
  under **one** new revision and one `NOTIFY egress_rules`. A failure in either step rolls both back; a catalog write that
  changes nothing writes no rule. Lock order is the catalog lock, then the egress lock, as in every other writer.
- **System-owned, read-only.** The admin API answers `409` ("derived from the MCP server catalog") to every edit or delete of
  the set and to adding, changing or deleting its rules; a profile naming it is a `400`. It has `applies_to_all = false` and no
  profile can name it, so the proxy's evaluation never uses it (the Go loader reads the extra column and ignores it: the parity
  vectors are unchanged).
- **Who it scopes.** Reachability is scoped by the identity (section 4), not by these rules: only a session whose profile names
  the server is given its extension (0010), and a credentialed server's calls carry only that session's grants. The set says
  which hosts the orchestrator reaches and with what route, for the reconciler and for `explain`.
- **Admin.** `POST /admin/egress/explain` adds `mcp: { ruleSet, servers: [{ name, enabled, credentialed, route,
namedByProfile? }] }`, the catalog's servers on that host. The console's Egress page shows the set read-only with a "Derived
  from the MCP catalog" badge and a link to the MCP servers page; the profile editor does not offer it; the MCP page links
  back.

### 3. The host-rule reconciler

OneCLI's org rules (`/v1/org/policy/rules`, seen live on v2.20) have a `priority` that is creation order and cannot be set.
The first matching rule wins, so an `allow` created after `block *` never takes effect (tested live: 403).

`HostRuleReconciler` (orchestrator, `PI_ONECLI_HOST_RULES=reconcile`, chart `onecli.hostRules.reconcile`, on in
`hack/kind-up.sh --onecli --egress-proxy`) keeps one allow rule per wanted host:

- **Wanted** = hosts of every `allow` rule with `route=onecli` (rule sets, a repo session's rules, an admin's, not expired) plus
  every host of `mcp-catalog` whatever its route (the orchestrator reaches even a credential-less MCP server through the
  gateway). A leading-dot suffix becomes `*.suffix`; `*` and cidrs are never sent.
- **Ownership.** Only rules named `pi-egress-allow-<host>` are created or deleted. A hand-made rule is never changed. A host
  that a hand-made allow in front of the terminal block already covers (the exact pattern, or `*.suffix`) gets no rule of ours,
  and one behind the block counts for nothing (it is ineffective).
- **The terminal block.** Its position is its meaning. When owned allows would sit behind it, it is **recreated** (same name,
  same body) behind them, **copy first, original second**, so the gateway is never without a block; an interrupted move leaves two
  blocks, not none, and the next pass drops the leftover. This is the one hand-made rule the reconciler touches, and it does
  what the bootstrap and `hack/onecli-host-rules.sh` already do. Nothing creates a block that is not there: the posture of the
  gate stays the operator's choice.
- **Idempotent.** A pass lists the rules and applies `planHostRules`, which is empty when nothing differs (a second look 35 s
  later changed nothing, priorities included, live). Passes are serialised across shards by an advisory lock
  (`pg_try_advisory_lock`); a shard that does not get it skips the pass.
- **Triggers.** `LISTEN egress_rules` (a catalog PUT, a rule write and the session rules of a repo session all notify), a 30 s
  poll for drift (a rule deleted behind our back), and a catalog notification. After a pass changed the gateway, every MCP server
  **retries its discovery at once** (`McpTools.nudge`) instead of waiting for its backoff, so a PUT is reachable and its tools
  listed within seconds.
- **Temporary home.** The reconciler needs OneCLI's admin key, which the orchestrator holds today for repo sessions. Epic #65
  moves provisioning out of the orchestrator; this moves with it.
- **Not a replacement of the baseline.** The model hosts and the package hosts that `hack/onecli-host-rules.sh` or the bootstrap
  made stay hand-made (the reconciler never deletes them); the script is still the way to open a host that no egress rule names.

### 4. Per-session MCP identity (#42)

`McpAccess` (orchestrator) gives a session's credentialed MCP calls the session's own OneCLI agent:

- **Agent.** `<prefix><session id>-m`. Its only grants are the secrets (referenced by name in the catalog's `onecliSecret`;
  the operator creates the secret in OneCLI, the catalog never holds a value) of the **credentialed servers that the session's
  profile snapshot names** (`mcpServers`), intersected with the enabled catalog. The grants are narrowed to exactly that set and
  read back before the agent is used (`narrowAgent`, shared with `RepoAccess`, which fails closed on an answer it cannot read).
  A secret that does not exist, or whose host pattern is not the server's host, is refused. A profile that does not name the
  server gets no agent, no grant and no way to ask for one: `forConversation` checks the snapshot, not the catalog alone.
- **Names.** OneCLI refuses an agent identifier longer than 50 characters (seen live: `400` at 51). `pi-session-<uuid>` is 47, so
  the suffix is two characters (`-m`), the discovery agent is `<prefix>d-<server>`, and an agent whose name would exceed 50 is
  refused with a message naming `PI_ONECLI_NAME_PREFIX` (at most 12 characters for MCP agents; the repo agent allows 14).
- **A separate agent from the repo agent.** `pi-session-<id>` holds the GitHub secrets and its token is sealed for the proxy
  (0037). Folding the MCP secrets into it would let the sandbox's proxy chain act with them wherever an admin allowed the host.
  A second agent costs one more OneCLI object and keeps the sandbox's route from ever carrying an MCP credential. (#42 suggests
  one combined agent; this is the reason it is not.)
- **Isolation in the client.** `McpServer` keeps **one connection per conversation** for a credentialed server, each on its
  session's `fetch` (an undici dispatcher with the agent's token), instead of the one shared client of 0007. A request of one
  session cannot travel on another's identity by construction, and a server that keeps session state no longer mixes
  conversations for the credentialed case. Servers without a secret keep the shared client. At most 256 per-conversation
  connections per server; the least recently used is closed. A credentialed server with no identity configured is never
  called on the orchestrator's token: it fails closed.
- **Provisioning.** Before a session's first input (`SessionService.prepare`), best effort: a failure is logged and the first
  call tries again. A call re-provisions when the catalog's credentialed set for the profile changed.
- **Discovery** has no session. A credentialed server's `tools/list` uses a **discovery agent** `<prefix>d-<server>`
  granted that one secret and used for nothing else (calls never use it). After a catalog change an agent of a server that is gone,
  disabled or no longer credentialed is deleted.
- **Revocation.** `SessionService.#delete` revokes the session's MCP agent (its token fails at once, its dispatcher is closed)
  right after the repo agent. The orphan sweep's agent pattern now also matches `<prefix><uuid>-m`, and `revokeSession`
  removes it by name for a session with no row. A session whose profile names no MCP server makes no OneCLI call.
- **What stays.** The gateway enforces hosts, not MCP tools (0007): prefer upstream tokens that are read-only and narrowly
  scoped. The orchestrator process still holds an agent token for model calls; MCP secrets are no longer reachable with it.

### Not done

- The proxy is not in the MCP path. A tunnel of an orchestrator MCP call is not a proxy tunnel, so slice 7's tunnel close does
  not apply to it: a removed or disabled server's in-flight calls finish, the client is then closed, and a new call settles
  `tool_unavailable` (0009). Sandboxes' own tunnels to MCP hosts follow the rules of their sets as before.
- A private MCP server (in the cluster) cannot be reached through OneCLI, which refuses private targets; it needs a different
  design (a private rule for the sandbox is a separate matter).
- The `*.suffix` form is sent to OneCLI as it is; whether it matches the bare domain there is not verified (we never send one).

## Consequences

- A catalog PUT makes a server reachable (host rule, discovery, tools) in seconds with no GitOps change; live numbers are below.
- With the reconciler on, the OneCLI admin key is used for one more recurring task, and the gateway's rule list has `pi-egress-allow-*`
  rules that nobody should edit. A hand-made allow for the same host keeps working and means the reconciler adds nothing.
- Each credentialed session adds one OneCLI agent. Discovery adds one per credentialed server.
- A credentialed MCP server that is not real MCP (a dummy URL) provisions the session's agent but never lists a tool: the
  smoke test uses that to check identities without a protocol server.
- Tests: derivation and rule/set protection (session-core), the catalog transaction and rollback (session-core, ingest), the
  reconciler plan, ownership, idempotency, the block copy-first move and the lock (orchestrator), per-session isolation, revocation
  and discovery (orchestrator), the chart value.

## Live verification (2026-11-18)

`hack/egress-mcp-smoke.sh`, throwaway kind cluster `pi-egress` (Cilium, bundled OneCLI v2, the egress proxy, runc sandboxes), against
the real DeepWiki MCP server and `httpbingo.org` (which echoes request headers) with dummy OneCLI secrets: all checks passed (the
last run in full; two earlier runs found the 50-character identifier limit below and script mistakes).

| Check | Result |
|---|---|
| PUT of a new server, until the gateway lets its host through | 1.0 to 1.6 s (bar: 10 s); includes the probe's own 0.4 s |
| the orchestrator learning of it to `mcp-tools-ready` (real DeepWiki tools) | 0.8 to 1.3 s |
| derived rule in `mcp-catalog`, read-only | `system: true`; hand edits of the set and of a rule are `409`; a profile naming it is `400` |
| hand-made host rule | unchanged (same priority, action, name, host) before, after the PUT, 35 s later and after the deletes |
| terminal block | one, last, behind the owned allow (copy first); recreated by the reconciler, same name |
| session whose profile names the server | `tool_search` then `mcp__<server>__read_wiki_structure`: a real, non-error DeepWiki result |
| session whose profile does not | `tool_unavailable`; explain denies the host for its sandbox; its sandbox's CONNECT through the proxy is refused (407), and so is the naming session's |
| per-session identity (two credentialed servers on one host, dummy secrets) | session A's agent holds exactly `smoke-key-a`, B's exactly `smoke-key-b`; through the real gateway the origin saw only `X-Smoke-A` on A's request and only `X-Smoke-B` on B's; B's agent sent none of A's credential to A's URL; a session with no credentialed server has no agent |
| revocation | deleting session A removed its MCP agent 0.7 s later; B's was untouched |
| idempotency | the rule list (priorities included) was identical 35 s later: nothing was recreated |
| DELETE of the servers | the gateway blocked the host again 0.9 to 1.1 s later; the owned rules and derived rules were gone; a new call of a session that had the tool is `tool_unavailable` |

Found live: OneCLI refuses an agent identifier over 50 characters (`400`), which sized the names above; and a catalog PUT that
changes nothing writes nothing, so a hand-removed owned rule comes back with the next 30 s poll, not at once.

**Not verified:** a credentialed server that speaks real MCP behind OneCLI (no third-party credential was used; the dummy servers
provision the identities and prove injection per agent, but never list a tool); two shards racing for the reconciler's lock
(unit-tested with a fake); an orchestrator MCP call that was in flight when its server was deleted (the design lets it finish).
