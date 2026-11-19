# 0038: Network modes and the network cutover

Status: accepted, 2026-11-18 (slice 6 of epic #50, issue #47); amended 2026-11-19 (the proxy is on by default, below). Builds on [0010](0010-session-profiles.md) (profiles),
[0030](0030-sandbox-sizes.md) (one template and pool per size, the pattern reused here), [0034](0034-egress-rules.md)
(rules), [0035](0035-egress-proxy-runtime.md) (the proxy), [0036](0036-egress-principals.md) (principals) and
[0037](0037-egress-onecli-route.md) (the OneCLI route). **Reverses** the decision of 2026-11-15 that every sandbox has
open public internet egress (`sandbox-allow-internet-egress`, plan.md "Sandbox egress").

## Context

Slices 1 to 5 built the proxy, the rules, the per-session tokens and the OneCLI route, but a sandbox could still bypass
all of it: the baseline gave every sandbox DNS, the OneCLI gateway port and the whole public internet. Rules that a
`curl --noproxy '*'` ignores are advice, not policy. The 2026-11-15 decision was made so every session can install
packages; the proxy does that now, under rules and with an audit trail. Some workloads still need what a proxy cannot
carry (UDP, non-HTTP protocols, tools that ignore proxy variables), so the old behaviour cannot simply vanish; it has to be
an explicit, rare, operator-approved opt-in.

## Decision

### Two modes, per profile

`networkMode` is a profile field (`ProfileDefinition.networkMode`, absent = `proxied`):

- **`proxied`** (the default): the sandbox reaches the egress proxy (TCP 3128) and nothing else. A TCP connection to a
  host and port that the rules allow goes through CONNECT. There is no DNS (the proxy resolves, and checks the address it
  resolved to), no UDP, no direct internet and no direct OneCLI gateway.
- **`direct`**: what every sandbox had before: direct TCP and UDP to the public internet, plus DNS to CoreDNS. Private,
  CGNAT, link-local, metadata and loopback addresses, `networkPolicy.sandbox.extraEgressExcept` and the platform stay
  blocked. No rule applies and nothing is audited.

The effective mode is fixed when the session is created (from the profile version it pins) and stored in
`inbox.sessions.network_mode` (migration 028; null, from before modes, is `proxied`). `GET /sessions/{id}` and the
`POST /sessions` answer report it as `networkMode`. A profile edit therefore applies to new sessions, like every other
profile field (ADR 0010); the same session keeps its mode through suspend and resume, because the orchestrator picks the
pool from the stored mode each time it creates the sandbox.

### Chart gate: `security.allowDirectSandboxEgress` (default `false`)

Off: the chart renders no direct policy, template or pool, and ingest answers `400` to a profile write that says
`networkMode: direct` and to a session create of a stored direct profile (`PI_ALLOW_DIRECT_SANDBOX_EGRESS`). On: `NOTES.txt`
prints a warning, the policy `sandbox-direct-allow-egress` and the direct templates and pools exist, `GET /admin/status`
reports `directSessions` (the live direct sessions) and the console marks profiles and sessions with an "unfiltered,
unaudited" badge. The gate needs `egressProxy.enabled` (see below); the chart refuses to render otherwise.

### Mechanism: a template and a warm pool per size and mode

Like sizes (0030), not a pod patch. Every size keeps `pi-env-template-<size>` and `pi-env-pool-<size>` (`proxied`); with the
gate on, each size, and the unsized pair, gets a twin: `pi-env-direct-template[-<size>]` and `pi-env-direct-pool[-<size>]`.
Each template bakes `pi-durable.dev/network-mode=<mode>` into its Pod labels. The orchestrator picks the pool from the
session's size and mode (`warmPoolFor`, one pure function); it needs no RBAC to patch Pods, and a session cannot change its
own position. The prefix `pi-env-direct-` cannot collide with a size name (`pi-env-pool-<size>` always has `pool` second).
Direct pools keep no warm Pods (`replicas: 0`), so enabling the gate doubles nothing.

### Fail closed: the base policy is the proxy and nothing else

With `egressProxy.enabled` (the cutover):

- The base sandbox egress is `sandbox-allow-egress-proxy-egress`, which selects every `app.kubernetes.io/name=pi-sandbox`
  Pod, regardless of the mode label. A Pod with no mode label, or an unknown value, is therefore proxied. Nothing else
  grants a sandbox egress except the additive policy below.
- `sandbox-direct-allow-egress` selects `pi-durable.dev/network-mode=direct` and adds DNS to CoreDNS and the public
  internet with every existing `except` range (`10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `169.254/16`, `127/8`,
  `fc00::/7`, `fe80::/10`, `::1/128`) and `networkPolicy.sandbox.extraEgressExcept`, split by address family as before.
- The namespace-wide DNS policies (`allow-dns-egress` and the Cilium `dns-egress-kube-dns-only`) no longer select
  sandboxes: their selector says `app.kubernetes.io/name NotIn [pi-sandbox]`. DNS returns for direct sandboxes only, in
  their own policy.
- `sandbox-allow-onecli-egress` is removed. A proxied sandbox reaches OneCLI only through the proxy (0037, `route=onecli`);
  a direct sandbox may not use OneCLI at all (below).
- A proxied sandbox cannot resolve names, so its proxy environment carries the **address** of the proxy Service
  (`http://x:<token>@<ClusterIP>:3128`), which the orchestrator looks up from `PI_EGRESS_PROXY_URL` (kept for a minute) when
  it builds the environment. The proxy still resolves the destination names itself.
- `egressProxy.requireAuth` now defaults to `true`: nothing but a sandbox with its token reaches the proxy. The value is
  still a switch, for test pods that call the proxy anonymously.

**Proxy disabled.** The cutover needs the proxy, so `egressProxy.enabled=false` keeps today's policies exactly (DNS for all
pods, `sandbox-allow-onecli-egress`, `sandbox-allow-internet-egress`): an existing install does not lose the internet by
upgrading. Every sandbox is then effectively direct whatever its profile says, the templates and pools are the proxied
ones, and `NOTES.txt` says so. Combining `security.allowDirectSandboxEgress=true` with a disabled proxy fails the render
(there is no direct mode to allow). Turning the proxy on is the cutover.

### Credentials never go with direct

`direct` has no proxy, so nothing could inject a credential for it, and a rule that looks credentialed would be a lie.
Ingest refuses (400) a direct session that carries a repo (`repo` in `POST /sessions`), a profile whose `mcpServers` names
a server with an `onecliSecret`, and a profile for which a rule set that applies to it (appliesToAll or named) has an
allow rule with `route=onecli`. The profile write checks the same (against the catalog and the rules as they are), and
the session create checks again, because both can change afterwards. A direct session gets no proxy environment, no
principal, no token and no binding (the orchestrator skips `EgressPrincipals` for it).

### Lifecycle, observability

The mode is baked into the Pod at creation; an existing sandbox keeps its position until it is recreated (suspend and
resume creates a Pod from the same pool, so it keeps the session's mode). The orchestrator logs `direct-egress-sandbox`
(warn) at each attach of a direct sandbox (the log-line metrics of docs/metrics.md), `GET /admin/status` carries
`directSessions`, and the isolation probe Pod wears the `proxied` label: the strictest position, so the probe's targets
(database, orchestrator, ingest, other sandboxes, Kubernetes API, OneCLI API and now the OneCLI gateway) are judged against
the policies that every sandbox gets. Its allowed control is a TCP connection to the proxy; it has no DNS control (a
proxied sandbox has no DNS), reported as `controls.dns: null`.

### Odd ports, DNS

A CONNECT to a public host is limited to `egressProxy.publicPorts` (80 and 443 by default); a rule for another port has no
effect at the network. Widening that is per deployment. DNS troubleshooting in `proxied` mode works over DoH through the
proxy, when a rule allows the resolver: `curl --doh-url https://<resolver>/dns-query https://example.org`, `dig +https`.

## Consequences

- A proxied sandbox that runs a tool which ignores the proxy variables fails to connect. That is the point; the operator
  adds a rule, or opts the profile into `direct`.
- Anything that needs UDP, ICMP or a raw TCP port other than `publicPorts` needs `direct`.
- `direct` is as open as every sandbox was; the gate, the badge, the log line and `directSessions` exist so it is rare and
  visible. Anyone who can write a profile can opt sessions into it once the gate is on: gate it by who gets the admin
  token.
- A sandbox that was running before the upgrade keeps its Pod, whose labels are unchanged; it falls under the proxy-only
  policy at once (the base policy does not need a label), which is the intended cutover, and its tool commands get the proxy
  environment at the next attach.
- The bundled OneCLI chart still admits sandboxes on the gateway (`clients.sandbox`); the sandbox side no longer has an
  egress rule to it, so the path is closed from both ends only with the proxy on.

## Deferred and rejected

- **A filtered DNS resolver** for proxied sandboxes (they have none), and **a third mode with proxied plus DNS**: DoH
  through the proxy covers troubleshooting.
- **Transparent proxying** (iptables or Cilium redirect): the proxy environment is explicit, as in 0036.
- **Per-rule direct TCP through Cilium `toFQDNs`**: it needs Cilium and DNS visibility for sandboxes, and splits the
  decision over two engines.
- **Patching the mode label onto the Pod** after creation: needs Pod patch RBAC, and a session that can relabel itself
  escapes the policy.
- **Mode as a per-request field of `POST /sessions`**: a caller must not choose its own network position; it chooses a
  profile.

## Amendment: the proxy is on by default (2026-11-19, issue #273)

`egressProxy.enabled` now defaults to `true`, so a default install is the cutover: proxied sandboxes, no direct internet.
Every live check of the proxy since this decision ran with it on, and a secure default should not depend on the operator
finding a flag. Nothing else changes: the policies, the modes and the direct gate are as above.

- **Opt-out.** `egressProxy.enabled: false` stays and does exactly what "Proxy disabled" above says (the sandbox policies of
  before the cutover, a notice in `NOTES.txt`, no direct gate). `hack/kind-up.sh --no-egress-proxy` passes it; the e2e
  suites other than `browser` pass it too (`tests/e2e/chart-values.py`), because they test direct sandbox egress.
- **Fails closed at render.** The proxy needs `egressProxy.database.existingSecret` (the read-only role `pi_egress`, ADR 0035),
  with OneCLI `egressProxy.binding.existingSecret` (ADR 0037), and an image tag or digest, like the other images. The chart
  keeps these names empty and refuses to render without them, with a message that names the opt-out. An existing install
  that upgrades without setting them therefore fails the upgrade instead of losing the internet silently or starting a proxy
  that cannot read its rules: its operator chooses the proxy (create the role and Secret) or the opt-out.
- **Install path.** `hack/install.sh` defaults the names to `pi-egress-database` and `pi-egress-binding` (in a values file
  passed before the user's). It creates the binding key once, like `sandboxd-auth`. It cannot create the role (`CREATE ROLE`
  needs a database admin, and the app's user is not one), so it creates the database Secret from `EGRESS_DATABASE_URL` or
  stops before installing with what to do, including the opt-out. `hack/kind-up.sh` turns on `auth.egressReader` of the
  bundled Postgres and hands the role's URI to `install.sh`; `hack/kind-smoke.sh` checks that a sandbox has no direct
  internet and that the proxy answers it.
- **Not changed.** charts/pi-postgres keeps `auth.egressReader.enabled: false` by default: turning it on needs the key
  `egress-password` in its Secret, which an existing install may not have.
