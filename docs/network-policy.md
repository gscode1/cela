# Network policy for pi-durable-poc

Status: plan.md records these policies as enforced on c2 since 2026-11-16 (Cilium v1.20.4, audit mode off, all pi-durable-poc
endpoints enforced in both directions; "Enforcement result"). The repo applies them too: every e2e run applies `deploy/` and
`deploy/cilium` into its namespace (`tests/e2e/run.sh`). The sections below were written before that run: the apply order and
rollback still describe the procedure, and "UNVERIFIED" marks what the run did not record separately.

Files:

| Path | What | Applied by |
|---|---|---|
| `deploy/networkpolicy.yaml` | default-deny both ways, DNS, sandbox policies | `kubectl apply -k deploy` |
| `deploy/networkpolicy-{ingest,orchestrator,postgres,e2e}.yaml` | per-workload allows | `kubectl apply -k deploy` |
| `deploy/cilium/` | kube-apiserver entity egress, DNS to kube-dns, orchestrator FQDN egress to `api.github.com` | `kubectl apply -k deploy/cilium` (needs Cilium CRDs, so it is not in `deploy/kustomization.yaml`) |
| `tests/e2e/run.sh` | the same policies, in every e2e run namespace `pi-e2e-<id>` (label `pi-durable-e2e=true`), see `docs/e2e.md` | the run applies `deploy/` and `deploy/cilium` with the namespace set |
| `deploy/onecli-policies/` | `onecli` namespace ingress and egress (FQDN allowlist) | your Argo repo, see its README |
| `deploy/onecli-host-rules.sh`, `docs/onecli-host-rules.md` | OneCLI v2 `allow ...` then `block *` | by hand, operator machine |

## Pod labels used (from the manifests, and checked read-only on c2)

| Workload | Selector | Source |
|---|---|---|
| orchestrator (also every shard Deployment `pi-orchestrator-<k>`, `e2e-runner`, `pi-orchestrator-b`) | `app.kubernetes.io/name=pi-orchestrator` | `deploy/orchestrator.yaml`, `tests/e2e/runner-pod.yaml` |
| ingest | `app.kubernetes.io/name=pi-ingest` | `deploy/ingest.yaml` |
| sandboxes (incl. warm pool) | `app.kubernetes.io/name=pi-sandbox` | `deploy/sandbox-template.yaml` |
| Postgres pi-pg | `cnpg.io/cluster=pi-pg` | set by CNPG on instance and job pods |
| e2e driver Job | `app.kubernetes.io/name=e2e-driver` | `tests/e2e/job.yaml.tpl` |
| CNPG operator | ns `postgres-system`, `app.kubernetes.io/name=cloudnative-pg` | live, read-only |
| OneCLI | ns `onecli`, `app=onecli` (one pod: web 10254, gateway 10255, api 10256) | live, read-only |
| Envoy Gateway data plane | ns `envoy-gateway-system`, `app.kubernetes.io/name=envoy` + `app.kubernetes.io/component=proxy` | live, read-only |
| CoreDNS | ns `kube-system`, `k8s-app=kube-dns` | live, read-only |

Namespaces are matched with `kubernetes.io/metadata.name`.

## Traffic matrix

Everything not listed is denied (`default-deny-all`, both directions). "S" = standard NetworkPolicy, "C" = CiliumNetworkPolicy.

| Source | Destination | Port | Why | Policy |
|---|---|---|---|---|
| clients via Envoy Gateway (and the e2e driver) | ingest | 8080 | session API. Clients arrive through the Gateway `main`, where every HTTPRoute on c2 terminates; no HTTPRoute exists yet | S ingest-allow-clients-ingress |
| ingest | Postgres (-rw) | 5432 | session and inbox state | S ingest-allow-egress |
| ingest | orchestrator | 8081 | stream proxy | S ingest-allow-egress |
| ingest, e2e driver | orchestrator | 8081 | only these two may call it | S orchestrator-allow-ingress |
| orchestrator | Postgres (-rw) | 5432 | durable state, advisory lock | S orchestrator-allow-egress |
| orchestrator | sandbox pods | 8080, 9090 | sandboxd REST and gRPC | S orchestrator-allow-egress |
| orchestrator | OneCLI | 10255, 10256 | model calls and remote MCP calls through the gateway; agent and secret management | S orchestrator-allow-egress |
| orchestrator, e2e driver, Postgres | kube-apiserver | 443, 6443 | claims, pods, PVCs; suites; CNPG instance manager | C orchestrator/e2e-driver/postgres-egress-kube-apiserver |
| orchestrator | `api.github.com` | 443 (+ DNS lookup of that name) | direct call that mints the repo-scoped GitHub App installation token (the App key never leaves the orchestrator); the only public host it may reach | C orchestrator-egress-github-api |
| e2e driver | orchestrator, ingest | 8081, 8080 | direct calls, if a suite makes any | S e2e-driver-allow-egress |
| orchestrator | sandboxes | (ingress side) | only the orchestrator may reach sandboxd | S sandbox-allow-orchestrator-ingress |
| sandbox | OneCLI gateway | 10255 | credentialed traffic (repo sessions): credentials injected | S sandbox-allow-onecli-egress |
| sandbox | public internet (not 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16, 127/8) | any | package installs for every session (decision 2026-11-15) | S sandbox-allow-internet-egress |
| orchestrator, ingest, Postgres in this ns | CoreDNS | 53 UDP/TCP | name resolution | S allow-dns-egress, C dns-egress-kube-dns-only |
| orchestrator, ingest, sandboxes, e2e driver | CoreDNS | 53 | same, for every pod | same |
| orchestrator, ingest | Postgres | 5432 | (ingress side) | S postgres-allow-ingress |
| CNPG operator (`postgres-system`) | Postgres | 5432, 8000 | status polling (8000, HTTPS) and SQL | S postgres-allow-ingress |
| Postgres instances | each other | 5432, 8000 | replication and status; unused at `instances: 1` | S postgres-allow-* |
| pi-durable-poc orchestrator | OneCLI gateway, API | 10255, 10256 | (ingress side, `onecli` ns) | C onecli-ingress |
| pi-durable-poc sandboxes | OneCLI gateway | 10255 only | (ingress side) | C onecli-ingress |
| Envoy Gateway proxies | OneCLI web, gateway, API | 10254, 10255, 10256 | HTTPRoute `onecli.example.com`: the dashboard, `/v1`, `/gw` | C onecli-ingress |
| OneCLI pod | CoreDNS | 53 (with DNS proxy rule) | FQDN allowlist needs Cilium to see lookups | C onecli-egress |
| OneCLI pod | `postgres-clusters/pg-db-cluster` | 5432 | OneCLI database | C onecli-egress |
| OneCLI pod | chatgpt.com, `*.chatgpt.com`, auth.openai.com, api.openai.com, openrouter.ai, github.com, api.github.com, codeload.github.com, objects.githubusercontent.com, registry.npmjs.org, pypi.org, files.pythonhosted.org | 443 | model providers, GitHub, package registries | C onecli-egress |
| OneCLI pod | 10/8, 172.16/12, 192.168/16, 100.64/10, 169.254/16 | any | explicit deny: a public name resolving to a private address | C onecli-egress (egressDeny) |
| kubelet, `kubectl port-forward` | any pod | any | host traffic; Cilium admits the local node by default, so probes keep working | (default) |

Rows marked "(ingress side)" repeat a flow from the receiving end and add no rules. Postgres has no egress except to its own
instances, DNS and the Kubernetes API.

## Assumptions to check before applying

- **CNPG operator reachability.** CNPG's operator talks to each instance on 8000 (instance manager status, HTTPS) and
  also opens SQL connections on 5432; both are allowed from `postgres-system/cloudnative-pg`. The operator pod labels are
  read live; the port list follows CNPG's documented networking requirements (UNVERIFIED against the installed operator
  version: if the Cluster shows `Not ready` after enforcement, `hubble observe --to-pod pi-durable-poc/pi-pg-1` shows
  the missing port). The instance manager also calls the Kubernetes API (covered by `postgres-egress-kube-apiserver`), and
  initdb/join job pods carry the same `cnpg.io/cluster` label, so they get the same policy.
- **Postgres -rw**: the Service selects the primary; the policy selects all pi-pg instance pods (it must survive a failover).
- **Ingest clients.** Chosen: the Envoy Gateway proxies. If clients will come from the LAN directly (a LoadBalancer
  Service) or another namespace, add a `from` entry to `ingest-allow-clients-ingress`.
- **Kube API.** Both 443 (the Service port) and 6443 (the node endpoint) are allowed; which one Cilium evaluates depends on
  socket-level service translation. UNVERIFIED until Cilium runs on c2.
- **GitHub App token mint (Phase 4c).** The orchestrator calls `api.github.com` directly, not through the OneCLI gateway
  (`callApi` in `main.ts` is a plain `fetch`; `mintInstallationToken` in `github-app.ts`), so `deploy/cilium/orchestrator-github.yaml`
  gives it a `toFQDNs` rule for `api.github.com:443` plus a DNS rule limited to that name.
- **Envoy labels** are from the running proxy pod; if Envoy Gateway is reinstalled with other labels, update
  `ingest-allow-clients-ingress` and `deploy/onecli-policies/ingress.yaml`.
- **OneCLI pod's other egress** (update checks, calls to its own external URL) is unknown: use audit mode first.

## Apply order

Enforcement starts per pod the moment any policy selects it, so the safe route is audit mode, then everything, then enforce.

1. Preconditions: Cilium is the CNI on every node, `kubectl get crd ciliumnetworkpolicies.cilium.io` works, DNS and the
   CNPG cluster are healthy, and a baseline `tests/e2e/run.sh phase3` passes (isolation KNOWN-FAIL on flannel).
2. Put the pi-durable-poc endpoints in policy audit mode (Cilium agent: `cilium-dbg endpoint config <id>
   PolicyAuditMode=Enabled`, for each pod in the namespace, or Cilium's cluster-wide `policy-audit-mode` during the window).
3. `kubectl apply -k deploy/cilium` then `kubectl apply -k deploy`. (Dry checks: `kubectl kustomize deploy`,
   `kubectl apply --dry-run=client -k deploy`.)
4. Run the e2e suites (phase3, phase4, phase4b with `REAL_MODEL=1` once) and watch `hubble observe -n pi-durable-poc
   --verdict AUDIT`. Every AUDIT entry is a missing allow: fix the policy first.
5. Disable audit mode (enforce). Re-run phase3 with `NETPOL_ENFORCED=1`: isolation must PASS.
6. In the Argo repo, add `deploy/onecli-policies/` (audit first, as its README says). Check the orchestrator still gets model
   answers and the dashboard still loads.
7. Last: `deploy/onecli-host-rules.sh --apply` (see `docs/onecli-host-rules.md`), then its verify probes.

## Rollback

Fast, per layer, in reverse order:

- Host rules: delete `pi-block-all` through the API (restores relaying of public hosts).
- OneCLI policies: remove them from the Argo repo (or `kubectl -n onecli delete cnp onecli-ingress onecli-egress` for a
  moment; Argo will put them back until the repo changes).
- pi-durable-poc, whole set (does not touch Pods or data):
  ```sh
  kubectl delete -k deploy/cilium
  kubectl -n pi-durable-poc delete networkpolicy default-deny-all allow-dns-egress sandbox-default-deny \
    sandbox-allow-orchestrator-ingress sandbox-allow-onecli-egress sandbox-allow-internet-egress ingest-allow-clients-ingress ingest-allow-egress \
    orchestrator-allow-ingress orchestrator-allow-egress postgres-allow-ingress postgres-allow-egress e2e-driver-allow-egress
  ```
  A pod with no policy selecting it is open again at once. Deleting only `default-deny-all` is **not** a rollback:
  the per-workload policies still select their pods and keep them default-deny.
- One workload only (for example Postgres misbehaving): delete that workload's two policies (`postgres-allow-ingress`,
  `postgres-allow-egress`) and its CNP; the other workloads keep their rules.
- Revert the commits to restore the previous sandbox-only policy set.

Note: `sandbox-allow-dns-egress` from the first version is replaced by `allow-dns-egress`; applying this set does not
delete it from the cluster (no prune), it is harmless and can be deleted.

## Verification status

- `kubectl kustomize deploy` and `kubectl apply --dry-run=client` pass for the standard policies (13 NetworkPolicies).
- The CiliumNetworkPolicies were checked against the upstream CRD schema (cilium v1.17.0
  `ciliumnetworkpolicies.yaml`) with a field-and-enum validator: no unknown fields, `kube-apiserver` is a valid entity. The
  CRDs are not installed on c2, so `kubectl apply --dry-run` for them cannot run yet.
- Enforcement itself is verified (plan.md, "Enforcement result": the sandbox isolation test passes and phases 1, 3, 4, 4b are green). UNVERIFIED here: FQDN behaviour, the `egressDeny` and endpoint-identity interaction, the CNPG port list,
  the host-rule API's delete and list shapes, and rule evaluation order in OneCLI.
