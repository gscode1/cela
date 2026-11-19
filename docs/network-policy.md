# Network policy for pi-durable-poc

Status: plan.md records these policies as enforced on the example test cluster since 2026-11-16 (Cilium v1.20.4, audit mode off, all pi-durable-poc
endpoints enforced in both directions; "Enforcement result"). The repo applies them too: every e2e run installs the chart (`networkPolicy.provider: cilium`) into its namespace
(`tests/e2e/run.sh`). The sections below were written before that run: the apply order and
rollback still describe the procedure, and "UNVERIFIED" marks what the run did not record separately.

The Helm chart [`charts/pi-durable`](../charts/pi-durable/README.md) renders the same policy set from
`templates/networkpolicy/` (`networkPolicy.provider: cilium` adds the Cilium policies; `standard` replaces the
`kube-apiserver` entity with an orchestrator egress rule to the API server, `networkPolicy.kubeApiCidrs` or TCP 443/6443 to any;
the database and OneCLI selectors are values; `packages/orchestrator/test/pi-durable-chart.test.ts` checks the invariants below on the rendered
output). The kustomize form in `deploy/` that this document first described is gone (install slice 11b).
The Postgres is the bundled `charts/pi-postgres` (or a database you run): CNPG is no longer part of the install
([install-plan D3](install-plan.md)) and no CNPG policy is rendered. The bundled database has one policy, named after its
release (the Helm fullname): ingress to TCP 5432 only from the pods in `networkPolicy.clientSelectors` of its own namespace,
and no egress rule (it needs none).

Files:

| Path | What | Applied by |
|---|---|---|
| `charts/pi-durable/templates/networkpolicy/` | default-deny both ways, DNS, per-workload allows, sandbox policies; with `provider: cilium` also kube-apiserver entity egress, DNS to kube-dns, orchestrator FQDN egress to `api.github.com` | `helm install` / `hack/install.sh` (the Cilium policies need the Cilium CRDs) |
| `charts/pi-postgres/templates/networkpolicy.yaml` | the bundled database: ingress from the `clientSelectors` only | the `pi-postgres` release |
| `tests/e2e/deploy/` | test-only policies of the e2e driver (and the CiliumNetworkPolicies in `tests/e2e/deploy/cilium`), see `docs/e2e.md` | `tests/e2e/run.sh`, next to the chart, in every run namespace `pi-e2e-<id>` (label `pi-durable-e2e=true`) |
| `hack/onecli-policies/` | `onecli` namespace ingress and egress (FQDN allowlist) of an external OneCLI; the bundled one has its own in `charts/pi-onecli` | your OneCLI deployment manager, see its README |
| `hack/onecli-host-rules.sh`, `docs/onecli-host-rules.md` | OneCLI v2 `allow ...` then `block *` | by hand, operator machine |

## Example pod labels (adapt to your installed components)

| Workload | Selector | Source |
|---|---|---|
| orchestrator (also every shard Deployment `pi-orchestrator-<k>`, `e2e-runner`, `pi-orchestrator-b`) | `app.kubernetes.io/name=pi-orchestrator` | `charts/pi-durable/templates/orchestrator/`, `tests/e2e/runner-pod.yaml` |
| ingest | `app.kubernetes.io/name=pi-ingest` | `charts/pi-durable/templates/ingest/` |
| sandboxes (incl. warm pool) | `app.kubernetes.io/name=pi-sandbox` | `charts/pi-durable/templates/sandbox/template.yaml` |
| Postgres (bundled) | `app.kubernetes.io/name=pi-postgres` (the chart's selector labels) | `charts/pi-postgres/templates/` |
| e2e driver Job | `app.kubernetes.io/name=e2e-driver` | `tests/e2e/job.yaml.tpl` |
| OneCLI | ns `onecli`, `app=onecli` (one pod: web 10254, gateway 10255, api 10256) | example selector; verify locally |
| Envoy Gateway data plane | ns `envoy-gateway-system`, `app.kubernetes.io/name=envoy` + `app.kubernetes.io/component=proxy` | example selector; verify locally |
| CoreDNS | ns `kube-system`, `k8s-app=kube-dns` | example selector; verify locally |

These selectors are configuration, not required installation names. Set them in your values file
(see the [chart README](../charts/pi-durable/README.md)); Envoy is optional. Private CIDRs below are standard reserved ranges,
not one cluster's LAN. Add any other non-public cluster/node ranges used in your environment with `networkPolicy.sandbox.extraEgressExcept` (IPv4 and IPv6 CIDRs, appended to the `except` lists of `sandbox-allow-internet-egress` or, with the proxy on, `sandbox-direct-allow-egress`): a public Kubernetes API endpoint, global IPv6 node and pod ranges, an external Postgres or OneCLI on a public IP, NAT64 `64:ff9b::/96`.

Namespaces are matched with `kubernetes.io/metadata.name`.

## Traffic matrix

Everything not listed is denied (`default-deny-all`, both directions). "S" = standard NetworkPolicy, "C" = CiliumNetworkPolicy.

| Source | Destination | Port | Why | Policy |
|---|---|---|---|---|
| clients via Envoy Gateway (and the e2e driver) | ingest | 8080 | session API; optional ingress-controller example, no HTTPRoute supplied | S ingest-allow-clients-ingress |
| ingest | Postgres | 5432 | session and inbox state | S ingest-allow-egress |
| ingest | orchestrator | 8081 | stream proxy | S ingest-allow-egress |
| ingest, e2e driver | orchestrator | 8081 | only these two may call it | S orchestrator-allow-ingress |
| orchestrator | Postgres | 5432 | durable state, advisory lock | S orchestrator-allow-egress |
| orchestrator | sandbox pods | 8080, 9090 | sandboxd REST and gRPC | S orchestrator-allow-egress |
| orchestrator | OneCLI | 10255, 10256 | model calls and remote MCP calls through the gateway (a credentialed MCP server as the session's own OneCLI agent, [ADR 0040](decisions/0040-mcp-egress-flow.md)); agent, secret and host-rule management | S orchestrator-allow-egress |
| orchestrator, e2e driver | kube-apiserver | 443, 6443 | claims, pods, PVCs; suites | C orchestrator-egress-kube-apiserver (chart), e2e-driver-egress-kube-apiserver (`tests/e2e/deploy/cilium`) |
| orchestrator | `api.github.com` | 443 (+ DNS lookup of that name) | direct call that mints the repo-scoped GitHub App installation token (the App key never leaves the orchestrator); the only public host it may reach | C orchestrator-egress-github-api |
| e2e driver | orchestrator, ingest | 8081, 8080 | direct calls, if a suite makes any | S e2e-driver-allow-egress |
| orchestrator | sandboxes | (ingress side) | only the orchestrator may reach sandboxd | S sandbox-allow-orchestrator-ingress |
| sandbox | OneCLI gateway | 10255 | credentialed traffic of repo sessions **only when the egress proxy is off**; with the proxy on the rule is not rendered (ADR 0038) | S sandbox-allow-onecli-egress (proxy off) |
| sandbox | public internet (not 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8, plus `networkPolicy.sandbox.extraEgressExcept`) | any | package installs, **only when the egress proxy is off** (decision 2026-11-15, reversed by ADR 0038 for the proxy on) | S sandbox-allow-internet-egress (proxy off) |
| sandbox | egress proxy | 3128 | the whole egress of a proxied sandbox: every session's tool traffic with a per-session token (ADR 0036, 0037, 0038), see below | S sandbox-allow-egress-proxy-egress (with `egressProxy.enabled`) |
| direct sandbox (`pi-durable.dev/network-mode=direct`) | CoreDNS; public internet (same exceptions as above) | 53; any | opt-in per profile, behind `security.allowDirectSandboxEgress`: no rules, no audit (ADR 0038) | S sandbox-direct-allow-egress |
| egress proxy | OneCLI gateway | 10255 (gateway port only) | the proxy's one upstream: `route=onecli` tunnels carry the session's OneCLI token (ADR 0037); the management API port stays closed | S egress-proxy-allow-onecli-egress (proxy and OneCLI on) |
| egress proxy (ingress side) | | | OneCLI's gateway admits `app.kubernetes.io/name=pi-egress-proxy` on 10255 | S onecli-gateway-allow-ingress (`charts/pi-onecli`, `clients.egressProxy`) |
| every pod but a sandbox (with the proxy on; all pods with it off) | CoreDNS | 53 UDP/TCP | name resolution | S allow-dns-egress, C dns-egress-kube-dns-only |
| `networkPolicy.clientSelectors` pods of the `pi-postgres` release (orchestrator, ingest, OneCLI) | Postgres | 5432 | (ingress side) | S `<pi-postgres fullname>` (`charts/pi-postgres`) |
| pi-durable-poc orchestrator | OneCLI gateway, API | 10255, 10256 | (ingress side, `onecli` ns) | C onecli-ingress |
| pi-durable-poc sandboxes | OneCLI gateway | 10255 only | (ingress side) | C onecli-ingress |
| Envoy Gateway proxies | OneCLI web, gateway, API | 10254, 10255, 10256 | optional ingress-controller example; replace selectors or use port-forward | C onecli-ingress |
| OneCLI pod | CoreDNS | 53 (with DNS proxy rule) | FQDN allowlist needs Cilium to see lookups | C onecli-egress |
| OneCLI pod | `onecli/onecli-db` (example; patch for your database) | 5432 | OneCLI database | C onecli-egress |
| OneCLI pod | chatgpt.com, `*.chatgpt.com`, auth.openai.com, api.openai.com, openrouter.ai, github.com, api.github.com, codeload.github.com, objects.githubusercontent.com, registry.npmjs.org, pypi.org, files.pythonhosted.org | 443 | model providers, GitHub, package registries | C onecli-egress |
| OneCLI pod | 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 | any | explicit deny: a public name resolving to a private address | C onecli-egress (egressDeny) |
| kubelet, `kubectl port-forward` | any pod | any | host traffic; Cilium admits the local node by default, so probes keep working | (default) |

Rows marked "(ingress side)" repeat a flow from the receiving end and add no rules. The bundled Postgres has no egress rule of its own; in the same namespace `default-deny-all` also covers it.

## Sandboxes: network modes and the cutover

[ADR 0038](decisions/0038-network-modes.md), epic #50 slice 6; it reverses the 2026-11-15 "open internet for every session".
What a sandbox may reach depends on `egressProxy.enabled` (the cutover) and on the Pod's `pi-durable.dev/network-mode` label,
which its SandboxTemplate bakes in (one template and warm pool per size and mode: `pi-env-pool-<size>` proxied,
`pi-env-direct-pool-<size>` direct).

| | Proxy on, mode `proxied` (default) | Proxy on, mode `direct` (needs `security.allowDirectSandboxEgress`) | Proxy off |
|---|---|---|---|
| egress proxy :3128 | yes | yes (unused: no proxy environment) | n/a |
| DNS | no (the proxy resolves) | yes, CoreDNS only | yes |
| public internet, any port, TCP and UDP | no: only through CONNECT, to `egressProxy.publicPorts` | yes | yes |
| private, CGNAT, link-local, metadata, loopback, `extraEgressExcept` | no | no | no |
| OneCLI gateway | only through the proxy (`route=onecli`) | no | direct, port 10255 |
| cluster, platform, other sandboxes | no | no | no |
| rules and audit | yes | none | none |

Fail closed. With the proxy on, the base policy `sandbox-allow-egress-proxy-egress` selects every sandbox Pod whatever its
labels, so a Pod without the label, or with an unknown mode, has the proxy port and nothing else. The additive policy
`sandbox-direct-allow-egress` selects `pi-durable.dev/network-mode=direct` and adds DNS and the public internet with the same
`except` ranges as before. `allow-dns-egress` and the Cilium `dns-egress-kube-dns-only` exclude sandboxes
(`app.kubernetes.io/name NotIn [pi-sandbox]`), and `sandbox-allow-onecli-egress` is not rendered. With the proxy off the
chart renders today's policies unchanged (so an upgrade does not cut the internet), `security.allowDirectSandboxEgress` is
refused, and every sandbox is effectively direct. `egressProxy.requireAuth` defaults to `true`.

```yaml
# the whole egress of a proxied sandbox
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: sandbox-allow-egress-proxy-egress }
spec:
  podSelector: { matchLabels: { app.kubernetes.io/name: pi-sandbox } }
  policyTypes: [Egress]
  egress:
    - to: [{ podSelector: { matchLabels: { app.kubernetes.io/name: pi-egress-proxy } } }]
      ports: [{ protocol: TCP, port: 3128 }]
```

A proxied sandbox cannot resolve names, so its `HTTPS_PROXY` holds the proxy Service's address (ClusterIP), not its name. The proxy accepts a session's token only from that sandbox's Pod address, so a token read inside one sandbox is useless in
another. A repo session's credentialed hosts (`github.com`, `api.github.com`) go through the proxy to the OneCLI gateway: the
proxy's own egress to the gateway port is `egress-proxy-allow-onecli-egress`, and OneCLI's gateway ingress admits the proxy
(`charts/pi-onecli` `clients.egressProxy`). With an **external OneCLI** (`onecli.mode=external`) the operator admits the proxy
pods on its side: allow ingress to the gateway port (default 10255) from pods labelled `app.kubernetes.io/name=pi-egress-proxy`
in the proxy's namespace, and nothing for the management API.

**Direct and credentials.** A direct session has no proxy environment, principal, token or binding, and the API refuses
direct together with a repo, a credentialed MCP server, or an allow rule with `route=onecli` in a rule set that applies to
the profile.

**Odd ports.** A CONNECT to a public host is limited to `egressProxy.publicPorts` (80 and 443): a rule for another port has
no effect at the network. Widen the list per deployment, or use `direct`.

**DNS in a proxied sandbox.** There is none, so `getent hosts` and `dig example.org` fail by design. To troubleshoot name
resolution, use DNS over HTTPS through the proxy (a rule must allow the resolver host on 443):
`curl --doh-url https://cloudflare-dns.com/dns-query https://example.org` or `dig +https @cloudflare-dns.com example.org`
(the sandbox needs the proxy variables, which its tool commands have). The proxy's own error says which rule denied a host
(`hack/egress-cutover-smoke.sh` runs these checks, and the bypass probes below, on a throwaway kind cluster).

**Bypass probes.** `hack/egress-cutover-smoke.sh` runs, from real sessions' sandboxes of each mode: a direct IP, another
port, IPv6, UDP/53, DNS, `curl --noproxy '*'`, `NO_PROXY=*` and the OneCLI gateway directly. In `proxied` all of them fail;
in `direct` the internet works (the IP, the port, IPv6 where the node has it, DNS, UDP) and the private, cluster, metadata
and platform addresses and the OneCLI gateway still fail.

**Browser sandboxes** ([ADR 0041](decisions/0041-browser-sandbox.md)) add no policy. A browser Pod wears the same
`app.kubernetes.io/name=pi-sandbox` and `pi-durable.dev/network-mode` labels as any sandbox (plus
`pi-durable.dev/sandbox-flavour=browser`, which no policy selects on), so a proxied browser reaches the egress proxy on 3128 and
nothing else: Chromium sends everything to a forwarder on 127.0.0.1 inside the Pod, which tunnels through the proxy. No DNS, no
UDP. `hack/browser-smoke.sh` shows the cluster, platform, OneCLI, metadata and LAN addresses refused.

## Assumptions to check before applying

- **Postgres client selectors.** `charts/pi-postgres` admits only the pods named in its `networkPolicy.clientSelectors`
  (the pi-durable pods and, for the bundled OneCLI, `app.kubernetes.io/name=onecli`); a client that is missing there is
  refused at the database, not by a pi-durable policy.
- **Ingest clients.** The example allows Envoy Gateway proxies; replace selectors for your ingress controller. If clients will come from the LAN directly (a LoadBalancer
  Service) or another namespace, add a `from` entry to `ingest-allow-clients-ingress`.
- **Kube API.** Both 443 (the Service port) and 6443 (the node endpoint) are allowed; which one Cilium evaluates depends on
  socket-level service translation. Verify which applies on your cluster.
- **GitHub App token mint (Phase 4c).** The orchestrator calls `api.github.com` directly, not through the OneCLI gateway
  (`callApi` in `main.ts` is a plain `fetch`; `mintInstallationToken` in `github-app.ts`), so the chart's `templates/networkpolicy/cilium.yaml`
  (`orchestrator-egress-github-api`) gives it a `toFQDNs` rule for `api.github.com:443` plus a DNS rule limited to that name.
- **Ingress-controller labels** must match your installed controller; update
  `ingest-allow-clients-ingress` (`networkPolicy.ingest.clients`) and `hack/onecli-policies/ingress.yaml`.
- **OneCLI pod's other egress** (update checks, calls to its own external URL) is unknown: use audit mode first.

## Apply order

Enforcement starts per pod the moment any policy selects it, so the safe route is audit mode, then everything, then enforce.

1. Preconditions: Cilium is the CNI on every node, `kubectl get crd ciliumnetworkpolicies.cilium.io` works, DNS and
   the database are healthy, and a baseline `tests/e2e/run.sh phase3` passes (isolation KNOWN-FAIL on flannel).
2. Put the pi-durable-poc endpoints in policy audit mode (Cilium agent: `cilium-dbg endpoint config <id>
   PolicyAuditMode=Enabled`, for each pod in the namespace, or Cilium's cluster-wide `policy-audit-mode` during the window).
3. `hack/install.sh` with `networkPolicy.provider: cilium` (the chart applies the Cilium policies with the rest). Dry check:
   `helm template pi-durable charts/pi-durable -f <values> | kubectl apply --dry-run=client -f -`.
4. Run the e2e suites (phase3, phase4, phase4b with `REAL_MODEL=1` once) and watch `hubble observe -n pi-durable-poc
   --verdict AUDIT`. Every AUDIT entry is a missing allow: fix the policy first.
5. Disable audit mode (enforce). Re-run phase3: isolation must PASS. `NETPOL_ENFORCED=1` (makes absent enforcement a FAIL,
   not KNOWN-FAIL) is read only by `run-phase3.sh`; `tests/e2e/run.sh` and `job.yaml.tpl` do not forward it to the driver Job,
   so through the runner phase3 stays on `auto`. Read the isolation line yourself: it must say PASS, not KNOWN-FAIL.
6. With your OneCLI deployment manager, apply adapted `hack/onecli-policies/` (audit first, as its README says). Check the orchestrator still gets model
   answers and the dashboard still loads.
7. Last: `hack/onecli-host-rules.sh --apply` (see `docs/onecli-host-rules.md`), then its verify probes.

## Rollback

Fast, per layer, in reverse order:

- Host rules: delete `pi-block-all` through the API (restores relaying of public hosts).
- OneCLI policies: remove them with your OneCLI deployment manager (for plain kubectl:
  `kubectl -n onecli delete cnp onecli-ingress onecli-egress`).
- pi-durable-poc, whole set (does not touch Pods or data):
  ```sh
  kubectl -n <ns> delete ciliumnetworkpolicy orchestrator-egress-kube-apiserver dns-egress-kube-dns-only orchestrator-egress-github-api
  kubectl -n <ns> delete networkpolicy default-deny-all allow-dns-egress sandbox-default-deny \
    sandbox-allow-orchestrator-ingress sandbox-allow-onecli-egress sandbox-allow-internet-egress ingest-allow-clients-ingress \
    ingest-allow-expose-ingress ingest-allow-egress orchestrator-allow-ingress orchestrator-allow-egress
  ```
  A pod with no policy selecting it is open again at once. Deleting only `default-deny-all` is **not** a rollback:
  the per-workload policies still select their pods and keep them default-deny.
- One workload only (for example Postgres misbehaving): deleting its own policies does not help, because
  `default-deny-all` and the DNS-only policies (`allow-dns-egress`, `dns-egress-kube-dns-only`) select every pod. Policies
  only add, so apply a temporary allow-all for that workload instead (for Postgres: `podSelector` `app.kubernetes.io/name: pi-postgres`,
  `policyTypes: [Ingress, Egress]`, `ingress: [{}]`, `egress: [{}]`), and delete it once the policy is fixed. Audit mode on
  that pod's endpoint is the other option.
- Revert the commits to restore the previous sandbox-only policy set.

Note: `sandbox-allow-dns-egress` from the first version is replaced by `allow-dns-egress`; applying this set does not
delete it from the cluster (no prune), it is harmless and can be deleted.

## Verification status

- `helm template` and `kubectl apply --dry-run=client` pass for the standard policies; the render tests check the invariants.
- The CiliumNetworkPolicies were checked against the upstream CRD schema (cilium v1.17.0
  `ciliumnetworkpolicies.yaml`) with a field-and-enum validator: no unknown fields, `kube-apiserver` is a valid entity. Client dry-run on your cluster requires the Cilium CRDs.
- Enforcement itself is verified (plan.md, "Enforcement result": the sandbox isolation test passes and phases 1, 3, 4, 4b are green). UNVERIFIED here: FQDN behaviour, the `egressDeny` and endpoint-identity interaction, 
  the host-rule API's delete and list shapes, and rule evaluation order in OneCLI.

### Honest e2e verdicts

`NETPOL_ENFORCED` is forwarded by `tests/e2e/run.sh` into the driver Job (unset keeps today's automatic behavior;
`1` fails missing enforcement, `0` forces KNOWN-FAIL only after positive controls succeed). Each denied target in
phase3 now has a TCP reachability control from the driver or orchestrator before it is tested from a sandbox.
Postgres, orchestrator, ingest and sandboxd use Service DNS and ready endpoint Pod IPs. Kubernetes and external
OneCLI APIs use Service DNS because the driver cannot read endpoints outside its run namespace. A dead target,
failed DNS lookup or failed control is FAIL, never a successful block or KNOWN-FAIL. Public internet is allowed,
not a denied target. The production `/admin/status` never infers enforcement from policy objects being present: it
reports what the isolation probe below measured. With `NETPOL_ENFORCED=1`, `tests/e2e/run-phase3.sh` also fails
before any test when the probe says `not-enforced` (`inconclusive` and `enforced` never fail it; without the variable the
verdict is only printed).

## Isolation probe

The orchestrator measures whether the policies block what they claim (docs/install-plan.md section 6, D7). It reports;
it never gates readiness, sessions or tools.

- **Who runs it.** Only shard 0's orchestrator, and only the process that holds the shard's schema lock (a standby holds no
  status row and runs nothing). The policies select sandboxes by label and are namespace-wide, so one measurement covers
  every shard; N shards would start N identical Pods. Shards above 0 show shard 0's verdict in their rows.
- **When.** In the background right after the lock is acquired (the orchestrator is already serving), and on
  `POST /admin/status/probe`. Ingest cannot reach Kubernetes, so that route only sets `probe_requested_at` on shard 0's
  row; the orchestrator polls it every 5 s, claims it atomically, and runs at most one probe at a time. A request while a
  probe runs is answered `202 {"requested": false, "state": "running"}`.
- **How.** A short-lived Pod (`pi-netprobe-<shard>-<id>`, label `pi-durable-k8s/netprobe`) with the label
  `app.kubernetes.io/name=pi-sandbox`, so every policy that selects sandboxes applies to it. It runs the orchestrator's own
  image (`node`, already pullable), the sandbox runtime class, the restricted Pod Security profile, no service account
  token, no volume, a 120 s `activeDeadlineSeconds`, and is deleted when the probe ends. Leftovers are deleted at the
  next start. It is a plain Pod, not a SandboxClaim: no PVC, no per-sandbox token and no warm-pool slot, and the
  network position is the same (same label, namespace and runtime). With the egress proxy on it also wears
  `pi-durable.dev/network-mode=proxied`, the strictest position (ADR 0038): whatever it cannot reach, a direct sandbox cannot
  reach either, so one probe covers both modes.
- **Denied targets** (IP addresses, resolved by the orchestrator, so DNS is not a variable): Postgres, the orchestrator's
  Service IP and its Pod IP, the Kubernetes API (`KUBERNETES_SERVICE_HOST`), the OneCLI management API (when OneCLI is
  not disabled), with the proxy on the OneCLI gateway (sandboxes no longer reach it directly) and, when one exists,
  another sandbox's sandboxd (:8080). Not covered: ingest, node, private and
  metadata addresses (no allowed source can show that they are up; the CIDR exceptions are asserted on the rendered chart).
- **Positive controls.** For every denied target the orchestrator, an allowed source, first connects to it; only a target
  that is up from there can count as blocked. From the Pod the allowed controls are a DNS lookup and a TCP connection to
  the OneCLI gateway (without OneCLI: `1.1.1.1:443`, which sandboxes may reach, so an air-gapped cluster reports
  `inconclusive`). With the egress proxy on, the only control is a TCP connection to the proxy port (a proxied sandbox
  has no DNS: `controls.dns` is `null`, not a failure).
- **Verdict.** `not-enforced`: any denied target accepted a connection from the Pod. `inconclusive`: no report (Pod failed,
  no RBAC, image not pullable), or an allowed control failed, or no denied target was up from the orchestrator.
  `enforced`: the controls work, at least one verified target was blocked and none got through. A refusal, a timeout
  or an unreachable error all count as blocked. `unknown` until the first run, `running` during one. Targets nobody
  could reach are listed as `unverified` and ignored.
- **Where it shows.** `networkPolicy` per shard (shard 0's value on all rows), and `networkPolicy` at the top level
  with `state`, `checkedAt` and `detail` (reason, controls, one row per target) in `GET /admin/status`
  ([session API](session-api.md)). The orchestrator logs `network-policy-not-verified` at `warn` level, with the reason, on
  every run that is not `enforced`; NOTES.txt tells the installer and `hack/install.sh` waits up to two minutes for the
  first result and prints it.
- **RBAC.** The orchestrator's Role gets `create` and `list` on `pods` (it already had `get` and `delete`) and `get` on
  `pods/log`, in the release namespace only (chart `rbac.yaml`).
- **Live-verified:** not yet. To see `not-enforced`, remove the policies in a scratch namespace (`kubectl -n <ns> delete
  networkpolicy --all`) or install on a CNI that ignores them (flannel alone), then `POST /admin/status/probe`.

## Bundled OneCLI

With `onecli.mode: bundled` the OneCLI pods run in the app's namespace and `charts/pi-onecli` (release `pi-onecli`,
installed by `hack/onecli.sh` before the upstream chart) supplies their policies ([ADR 0022](decisions/0022-bundled-onecli.md)).
They hold from the first minute, before `pi-durable` and its namespace-wide `default-deny-all` exist. Pods are selected by
the upstream chart's labels (`app.kubernetes.io/name=onecli`, `instance=<release>`, `component`).

| From | To | Port | Why |
| --- | --- | --- | --- |
| orchestrator | OneCLI api | 10256 | per-session agents, grants, secrets |
| a pod labelled `app.kubernetes.io/name=pi-onecli-bootstrap` | api, gateway | 10256, 10255 | the bootstrap as a Job (the script from a laptop uses `kubectl port-forward`, which no policy filters) |
| OneCLI web, gateway | api | 10256 | the dashboard and the gateway read config |
| orchestrator, sandboxes | OneCLI gateway | 10255 | model and MCP calls, sandbox traffic |
| OneCLI api, web | gateway | 10255 | the dashboard's and the API's own calls |
| nobody | OneCLI web (dashboard) | 10254 | port-forward only; `web.allowFrom` opens it to chosen peers |
| the Docker gateway of the kind network, one /32 (`expose.enabled`, kind only) | OneCLI web, api | 10254, 10256 | the host's `localhost:10254` and `:10256` ([below](#kind-localhost-ports-kind-only)) |
| OneCLI pods | `pi-postgres` | 5432 | the `onecli` database (pi-postgres admits `app.kubernetes.io/name=onecli`) |
| OneCLI pods | CoreDNS | 53 | |
| OneCLI gateway | public internet (not private, CGNAT, link-local, loopback) | any | model, GitHub and package hosts, as for sandboxes |
| the CA Job | any address | 443, 6443 | the Kubernetes API cannot be named in a plain policy |

Everything else is denied (`<release>-default-deny`). **Why it matters more than for other services:** OneCLI's
management API accepts a sign-up from anyone who can reach it, there is no switch to stop that, and the organization such
an account creates is not covered by our host rules; its agent tokens work on the gateway (the spike measured an
`example.com` fetch that the first organization's rules blocked). Reaching `:10256` is the whole attack, so this table is the
control, and it only works on a CNI that enforces NetworkPolicy. `hack/kind-smoke.sh --onecli` checks it live: the
orchestrator gets HTTP 200 from the API, the ingest pod and a sandbox do not connect, and a sandbox does reach the gateway.

## kind: localhost ports (kind only)

`hack/kind-up.sh` (default; `--no-expose` turns it off) publishes the session API on the host's `localhost:8080` and, with
`--onecli`, the OneCLI dashboard and API on `localhost:10254` and `:10256`, so nothing needs `kubectl port-forward`
([ADR 0022 addendum](decisions/0022-bundled-onecli.md#addendum-kind-publishes-the-dashboard-and-api-on-localhost-issue-138)).
Real clusters render none of this (`ingest.expose.enabled` and `expose.enabled` are false).

The path: the host's `127.0.0.1:<port>` (a kind `extraPortMapping`, loopback only) to the node container, to a NodePort
Service with `externalTrafficPolicy: Local` (`pi-ingest-nodeport` 30080, `onecli-web-nodeport` 30254,
`onecli-api-nodeport` 30256), to the pod. `Local` keeps the client's source address. Connections made on the host arrive
from the **IPv4 gateway of the Docker network `kind`** (measured on Docker Desktop for Mac: `172.20.0.1`; read by
`hack/kind-up.sh` from `docker network inspect kind`, where the first entry can be IPv6). One policy per exposed component
admits exactly that address as an `ipBlock` `/32` (the chart schema rejects anything wider or empty):
`ingest-allow-expose-ingress` and `<release>-{web,api}-allow-expose-ingress`.

| From | To | Port | Note |
| --- | --- | --- | --- |
| the Docker gateway, one /32 | ingest | 8080 | the host's `localhost:8080` |
| the Docker gateway, one /32 | OneCLI web, api | 10254, 10256 | the host's `localhost:10254`, `:10256` |
| a sandbox | the node IP on a NodePort, or any exposed ClusterIP | those ports | **blocked** (not the /32); `hack/kind-smoke.sh` checks it from a real sandbox |

The node IP and the Pod network are not admitted: a sandbox can reach the node, so admitting either would open ingest and
OneCLI's sign-up-open API to it.

**Residual risk on kindnet only.** kindnet does not filter traffic to the node itself (hostNetwork Pods: the
Kubernetes API server, kubelet, etcd), so a sandbox on a default kind cluster can still reach those ports, as the isolation
probe's `kube-api` target shows. It has no credentials for them (`automountServiceAccountToken` is false), so what it reaches
is unauthenticated endpoints. `hack/kind-up.sh --cni cilium` (issue #139) closes it: Cilium's CIDR rules do not select the
node, so the sandbox policy's internet `ipBlock` does not open it, the probe reports `enforced`, and `hack/kind-smoke.sh`
fails if a sandbox reaches the node's :6443 or :10250. The `kind-cilium` CI job runs that lane.

## Egress proxy (`egressProxy.enabled`)

ADR [0035](decisions/0035-egress-proxy-runtime.md). On by default since 2026-11-19: it is the network cutover for sandboxes ([ADR 0038](decisions/0038-network-modes.md), above, and its amendment). `egressProxy.enabled: false` opts out and keeps the sandbox policies of before the cutover. With it on,
the pods `app.kubernetes.io/name=pi-egress-proxy` get these policies on top of `default-deny-all` and the DNS rule:

| Policy | Direction | Allows |
| --- | --- | --- |
| `egress-proxy-allow-clients-ingress` | ingress | TCP 3128 from sandboxes (`app.kubernetes.io/name=pi-sandbox`) and `egressProxy.clients` |
| `egress-proxy-allow-database-egress` | egress | the database of `database.external.egress`, TCP 5432 (the read-only role) |
| `egress-proxy-allow-internet-egress` | egress | `0.0.0.0/0` and `::/0` on `egressProxy.publicPorts` (80, 443), minus private, CGNAT, link-local, loopback and `networkPolicy.sandbox.extraEgressExcept` |
| `egress-proxy-allow-private-egress-<i>` | egress | one per `egressProxy.privateEgress` entry: its cidr or namespace/pod selector, on its ports |

Two layers decide a private destination: the **network** (`privateEgress`, operator, chart) and the **proxy** (a `private: true`
rule in the database, admin). Either alone connects nothing. The platform itself (Postgres, ingest, the orchestrators, the
OneCLI API, the Kubernetes API) is blocked by the proxy whatever the rules say. Kubelet probes use :3130 from the node. Cilium
does not match Pod or Service addresses with a `cidr` rule, so use selectors for in-cluster destinations there.

The proxy needs two Secrets and a role. The database Secret (`egressProxy.database.existingSecret`; `hack/install.sh` names
it `pi-egress-database` and creates it from `EGRESS_DATABASE_URL`) holds the URI of the read-only role `pi_egress`, which
only a database admin can create: `auth.egressReader.enabled=true` with charts/pi-postgres, otherwise once by hand (the
statements are in `egressProxy.database` of [values.yaml](../charts/pi-durable/values.yaml)). With OneCLI the binding key
(`egressProxy.binding.existingSecret`, `pi-egress-binding`) seals the OneCLI tokens; `hack/install.sh` creates it once.
The chart refuses to render with the proxy on and either name empty. The database must admit the proxy's pods on 5432
(charts/pi-postgres does, `networkPolicy.clientSelectors`).

Live check: `hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build` (the proxy is on by default), then
`hack/egress-smoke.sh --name pi-egress`. `hack/kind-smoke.sh` checks on every kind run that a sandbox has no direct
internet and that the proxy answers it.
