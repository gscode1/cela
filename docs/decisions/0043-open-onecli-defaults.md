# 0043: Open OneCLI defaults, hardening as tools

Status: accepted, 2026-11-19 (issue #288). Amends [0022](0022-bundled-onecli.md) (the bundled OneCLI's defaults) and
[0040](0040-mcp-egress-flow.md) (private MCP servers). Related: [0007](0007-native-remote-mcp.md) (the orchestrator calls MCP
servers), [0034](0034-egress-rules.md) and [0037](0037-egress-onecli-route.md) (the egress rules and the OneCLI route),
[0038](0038-network-modes.md) (sandbox network modes), [0042](0042-onecli-admin-key-in-orchestrator.md).

## Context

The bundled OneCLI shipped restrictive: the bootstrap created an allow rule per known host and a terminal `block *`
(`pi-block-all`), OneCLI itself refuses private destinations, and the OneCLI Pod's network policy denied every private range.
That blocks legitimate use. A LAN MCP server (`https://mcp-searxng.gskode.com/`) resolves to a private address and needs its API
key injected by OneCLI. It failed for three independent reasons: the block, OneCLI's private-destination guard, and our
private-range egress denies on the OneCLI Pod.

Who can make OneCLI connect somewhere decides how much those defaults protect:

- **The orchestrator runs no model code.** The MCP URLs it calls are set by trusted admins (`/admin/mcp-servers`), not by a model
  or a session. Its calls through OneCLI are the admin's choice.
- **Sandboxes do not reach OneCLI's private reach.** With the egress proxy on (the chart default, [0038](0038-network-modes.md)) a
  sandbox's only way out is the proxy, which judges the **resolved address** and never routes a private address via
  `route=onecli` (`decider.Decide`, `packages/egress-proxy/internal/egress/proxy.go`). A sandbox therefore cannot ask OneCLI for a
  private address, whatever OneCLI would allow.

## Decision

**The defaults become open. Hardening is opt-in, offered as tools.**

| Layer | Open default | Hardening tool |
|---|---|---|
| Host rules | `ONECLI_HOSTS` empty: the bootstrap makes no allow rules and no `block *` | set `ONECLI_HOSTS`, or run `hack/onecli-host-rules.sh --apply` ([host rules](../onecli-host-rules.md)) |
| OneCLI's private guard | upstream `gateway.allowPrivateDestinations=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16` (`charts/pi-onecli/upstream-values.yaml`) | empty it: `--set gateway.allowPrivateDestinations=` |
| Network policy of the OneCLI gateway | the public rule as before, plus a SEPARATE rule for RFC 1918 on **TCP 443 only** (`gateway.privateHttps`) | `gateway.privateHttps.enabled=false`, or `gateway.privateHttps.except` to carve out the kube API and pod CIDRs |
| Cilium example for an external OneCLI | `hack/onecli-policies/egress.yaml`: TCP 443 to `toEntities: [world]` | `egress-strict.yaml`: the FQDN list and the full private deny |

**What is kept, open or not:**

- 100.64.0.0/10 (CGNAT), 169.254.0.0/16 (cloud metadata), loopback and the IPv6 ULA and link-local ranges stay blocked in every
  variant, by OneCLI and by the policy.
- Private ranges are reachable on 443 only. 10256 (kubelet healthz), 5432 (Postgres), 6443 (kube API), 8080 and 9090 (sandboxd,
  metrics) and 3128 (the proxy) stay closed on CNIs where an `ipBlock` matches Pods. The private rule is separate from the public
  one so the public rule is unchanged.
- **The proxy coupling.** Open OneCLI is safe only while sandboxes reach it through the proxy. With `egressProxy.enabled=false`
  sandboxes reach the gateway directly (`sandbox-allow-onecli-egress`) and a repository session's sandbox holds a OneCLI token,
  so open OneCLI would let it reach private networks. `hack/install.sh` reads the proxy state from the rendered chart and passes
  `--egress-proxy off` to `hack/onecli.sh`, which then installs the HARDENED values (empty `allowPrivateDestinations`, no private
  443 rule) unless `--onecli-allow-open-without-proxy` (install.sh, kind-up.sh) or `--allow-open-without-proxy` (onecli.sh)
  acknowledges it. `hack/kind-up.sh --no-egress-proxy --onecli` is therefore hardened. A standalone `hack/onecli.sh` defaults to
  `--egress-proxy on`, the chart's default.
- **MCP calls refuse redirects.** The orchestrator's MCP transport (and only it; model calls share the gateway fetch and keep its
  default) sets `redirect: "error"`, so a 30x from an MCP server fails the call instead of carrying the request, and the key the
  gateway injects, to a host the admin did not name.

## Residual risks

- **An admin-set MCP URL may reach any LAN host on :443.** The admin is trusted to name the server. A typo or a hostile admin can
  aim an MCP call, with its injected credential, at any private HTTPS endpoint, including a LAN management console. The credential
  is injected only for the secret's own `hostPattern`.
- **DNS rebinding of an admin-named host.** The orchestrator hands OneCLI a name and OneCLI resolves it again itself, so the address
  it connects to is not the one anybody checked. Whoever controls the DNS of an admin-named host can point it at any private
  address that is open on 443. Hardening: the strict Cilium policy and
  an allowlist stay available, and `privateHttps.except` removes ranges that must never be reachable.
- **An existing `pi-block-all` stays.** The new default only changes what a fresh bootstrap creates. An install that has the block
  keeps it, and so does a later run of `hack/onecli-host-rules.sh` or an old bootstrap, which recreates it. Delete it to open
  OneCLI ([host rules](../onecli-host-rules.md)).
- Whether an `ipBlock` matches Pod and Service addresses depends on the CNI. Where it does, the private rule admits TCP 443 of
  in-cluster Pods and the kube API Service too; list those CIDRs (`gateway.privateHttps.except`) to close them.

## Consequences

- A LAN MCP server with an injected key works with a fresh `hack/kind-up.sh --onecli` and with `charts/pi-onecli` defaults.
- An operator who wants the old behaviour sets `ONECLI_HOSTS` (and applies `egress-strict.yaml`, an empty
  `allowPrivateDestinations` and `privateHttps.enabled=false`). The three are independent, so a partial hardening is possible.
- An external OneCLI (GitOps) takes two changes: the env var `GATEWAY_ALLOW_PRIVATE_DESTINATIONS` on the gateway and the
  egress policy copied from `hack/onecli-policies/egress.yaml`.
- Tests: the chart renders (the public rule unchanged, the separate 443-only rule, extra excepts, no CGNAT or metadata anywhere),
  the install scripts (open with the proxy, hardened without it, the acknowledgement), the bootstrap (no rules by default, rules
  and an idempotent rerun with `ONECLI_HOSTS`, a warning for an existing block), the MCP redirect refusal, and the host list shared
  by the strict policy, the script and the docs.

## Not verified

A real LAN MCP server through the open gateway; the 443-only rule on a CNI whose `ipBlock` matches Pods; `egress.yaml` on Cilium; DNS rebinding by a hostile name server.
