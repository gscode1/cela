# 0037: The OneCLI route: per-session bindings, repo sessions behind the proxy

Status: accepted, 2026-11-18 (slice 5 of epic #50, issue #253; implements the proxy side of #42). Builds on
[0012](0012-egress-proxy-spike.md) (the chained CONNECT to OneCLI), [0034](0034-egress-rules.md) (`route=onecli`, session
rules), [0035](0035-egress-proxy-runtime.md) (the proxy runtime), [0036](0036-egress-principals.md) (principals) and
[0022](0022-bundled-onecli.md) (bundled OneCLI).

## Context

Slice 4 put plain sessions behind the proxy and left repo sessions on the OneCLI gateway, because the gateway is where the
repo-scoped GitHub token is injected and the proxy could not yet chain to it. The proxy code for the chain exists since the
spike (0012): for a decision with `route=onecli` it dials the one configured upstream with a CONNECT that carries the
session's OneCLI token. What was missing is where that token comes from, and moving repo sessions over.

## Decision

### Bindings: `egress.bindings`, sealed with AES-256-GCM

Migration `027_egress_bindings.sql` adds `egress.bindings`: `session_id` (primary key), `key_id`, `nonce` (12 bytes),
`ciphertext` (the token's encryption plus the 16-byte GCM tag), `created_at`, `updated_at`. The orchestrator is the only
writer. A trigger notifies `egress_rules` after every write, so a binding reaches the proxy as fast as a rule does and its
removal ends the route at the next snapshot (1 to 2 s in the live run, 5 s poll at worst, a 10 s budget).
`grant_proxy_reader` now also grants `select` on the table; still no write besides `proxy_status`.

**Why encrypted, and with what.** The OneCLI agent token is a credential: with it, anyone who can reach the gateway acts as
that session's agent (grants for one repository's GitHub token, or an MCP server). It must not sit in plaintext in a
database that backups, replicas and `select`-only roles read, and it must not reach the sandbox. The orchestrator
and the proxy both need it, in different processes, so it is stored for the proxy to read, sealed:

- Key: 32 random bytes in a Secret (`egressProxy.binding.existingSecret`, key `key`, base64) that the chart mounts as a file
  into the proxy and into the orchestrators, and into nothing else (a chart test checks that no sandbox object mentions it).
  The key never enters the database or an environment variable, and the proxy refuses to start with only one of
  `EGRESS_UPSTREAM_ADDR` and `EGRESS_BINDING_KEY_FILE`.
- Additional data: `egress-binding:v1:<session id>`. A ciphertext copied onto another session's row does not open, so a
  database writer cannot make session B ride session A's agent by copying a row (tested in Go and live). A fresh nonce per
  write.
- `key_id` is a fingerprint of the key, so "sealed with another key" (a rotation, a wrong Secret) is told apart from a
  corrupted row. Rotating the key means writing every binding again: a new key with the orchestrator restarted rewrites each
  binding when the session next provisions; until then those sessions' onecli routes are denied, never open. The key is a
  backup asset like the sandbox master key.
- The proxy opens a binding only when a tunnel of that session needs it, and the decision stage checks that it opens
  before it allows the connection, so a missing, foreign or corrupt binding is a deny with a clear reason.

**Rejected:** storing the token in the clear with column privileges (a backup or a replica leaks it); deriving it from the
master key like the egress token (the OneCLI agent token is minted by OneCLI, not derived); a Kubernetes Secret per session
(the proxy would need Secret read access and watch RBAC, and a kube API dependency it has avoided on purpose); handing
the proxy the OneCLI admin key (it would be able to mint tokens for any agent).

### Writing and removing a binding

`RepoAccess` writes the binding right after it proved the session's OneCLI agent narrow (exactly the two GitHub secrets),
and writes the session rules after it, so the rules revision, which the proxy replicas report in `egress.proxy_status`, covers the
binding. The orchestrator then waits (at most 10 s, logging `egress-propagation-timeout`) until every serving replica reports
that revision, so the first `git clone` cannot arrive before the route is open. A replaced agent (a failed grant check on a
renewal) has a new token, and the binding is rewritten; the sandbox env does not change, because it never held that token.

Deletion (`SessionService.#delete`) revokes the principal, deletes the binding and the session rules, in that order and each
idempotent, right after the OneCLI teardown. The orphan sweep does the same for a session that is gone: the list it already
takes of "sessions that hold something at the proxy" is now live principals, bindings and owners of session rules together.
A session that was deleted while a provisioning was in flight leaves a binding that the sweep removes.

### The proxy: only the OneCLI gateway, only with the session's token

For a decision with `route=onecli` the proxy dials only the configured gateway (`EGRESS_UPSTREAM_ADDR`, from
`onecli.*.gatewayUrl`), with a chained CONNECT whose `Proxy-Authorization` is the session's OneCLI token. It strips the
client's `Proxy-Authorization` and `X-Upstream-Https-Proxy` (so a client cannot choose the next hop or inject a token), never
dials the gateway for a `direct` decision, and **never falls back to a direct dial**: no binding, a binding that does not open,
or a failed upstream handshake (10 s timeout) ends the tunnel. The origin never receives the egress token or the OneCLI token.
The upstream dial is made by the proxy itself and is not a destination a sandbox may request: the platform block list still denies every
request that names OneCLI, but the dial to the gateway is the one private address the proxy may open (and the NetworkPolicy
below is the network side of that).

### Repo sessions move onto the proxy

With `egressProxy.enabled` every session, repo sessions included, has a principal and the proxy environment
(`HTTP(S)_PROXY` with the egress token). `usesEgressProxy` is gone: there is no session that does not use the proxy when it is
enabled. The sandbox env of a repo session is the proxy env plus `buildWorkspaceEnv()` (the OneCLI CA bundle in
`SSL_CERT_FILE`, `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, git's non-interactive switches and identity). It no longer has the
OneCLI gateway address or the OneCLI token. The CA stays because OneCLI terminates TLS for credentialed hosts, and the
chained tunnel ends there. With the proxy disabled a repo session keeps the previous OneCLI environment unchanged.

Each repo session gets **session rules**, `allow` with `route=onecli` on 443 for `github.com` and `api.github.com`, the two
hosts where its OneCLI agent has secrets, so a session rule beats the `github-public` set's direct rule for `github.com`
(0034 precedence, exact host against exact host, session over set). `codeload.github.com` stays direct: OneCLI injects
nothing there. The rules are created with the binding and removed with the session; an admin sees them on the session's rules
page (author `orchestrator`) and in the history. A session without the binding key configured is refused (`RepoUnavailableError`) before
anything is created in OneCLI.

### Network

- `egress-proxy-allow-onecli-egress` (chart, rendered when the proxy and OneCLI are both on): the proxy pods to the OneCLI
  pods on the gateway port only (the management API is another port of the same pods and stays closed).
- `charts/pi-onecli` admits `app.kubernetes.io/name=pi-egress-proxy` on the gateway port (`clients.egressProxy`) and nowhere
  else. For an external OneCLI the operator admits the proxy's pods on the gateway port (docs/network-policy.md).
- The sandbox's own egress to the OneCLI gateway (`sandbox-allow-onecli-egress`) is **not changed here**: a repo session no
  longer needs it with the proxy on. Removing it is part of the network cutover (slice 6), which needs approval.

### Admin

`POST /admin/egress/explain` with a `sessionId` adds `binding` (true, false, or null without a session) next to `route`;
the console's Explain page shows it. `GET /admin/egress/status` adds `bindings: { total }`. Neither returns ciphertext,
nonce or key id.

## #42: the orchestrator's own MCP identity (not in this slice)

Issue #42 wants the orchestrator's MCP calls for a session to go through that session's OneCLI agent. The orchestrator's
own gateway fetch (`createGatewayFetch`, one orchestrator-wide token) is unchanged here and is moved in slice 8. The
building block that slice needs now exists: a per-session OneCLI agent with a sealed binding and an explicit rule. A
credentialed MCP session will get the same pair (its profile's MCP secrets granted to its agent, `route=onecli` rules for
the MCP hosts derived from the catalog) and `RepoAccess` is then the generalisation #42 describes. Until then #42 stays open.

## Live verification (2026-11-18)

`hack/egress-onecli-smoke.sh`, throwaway kind cluster with Cilium, bundled OneCLI and the proxy: all checks passed. Deleting
a binding made the proxy deny within 1 to 2 s; deleting a session removed its binding and rules and refused its route within
2 s; A's token from B's Pod, B without a binding and A's sealed row copied onto B were all denied; the origin saw the injected
credential and neither token; OneCLI's log named the session's agent on a `Mitm` CONNECT from the proxy; the proxy's pod
label reaches the gateway port and not the management API; closing a tunnel ended a live response. Not verifiable here: a real
repo clone (no GitHub App on a throwaway cluster, and the maintainer's credentials were not used), see 0012.

## Consequences

- With the proxy on, the sandbox holds one credential, the egress token, which is useless anywhere but the proxy (0012's
  bar): the OneCLI token is only in the OneCLI database, the orchestrator's memory and, sealed, in the bindings table.
- A repo session needs the proxy, the binding key and the gateway to be up for git to work. A proxy outage now stops a repo
  session's network, where before only the gateway did.
- Tunnels already open keep working when a binding is deleted until they end (slice 7 closes them on a rule change; the
  `close-tunnels` admin endpoint exists and is not reachable from outside the pod).
- The unit tests: the Go chain tests with a fake upstream and origin (the session's own token, client headers stripped, no
  binding, a foreign or tampered binding, a different key, no key, and a direct decision never dials the gateway), the
  cross-language ciphertext vector, the TypeScript round trip, session rule lifecycle, the repo-session env switch and the
  chart invariants. The live run is `hack/egress-onecli-smoke.sh` (results in [0012](0012-egress-proxy-spike.md), "Live results").
