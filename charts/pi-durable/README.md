# pi-durable

The Pi Durable app on Kubernetes ([install plan](../../docs/install-plan.md), D1, [ADR 0020](../../docs/decisions/0020-helm-install.md)):
the orchestrator (one Deployment per shard), ingest (the session API), the sandbox template and warm pool, namespace-scoped
RBAC and the network policies.

It does **not** contain the database, OneCLI or agent-sandbox. They are separate and only referenced, so uninstalling
the app never removes a database, a credential gateway or cluster-wide CRDs. This slice supports:

| Part          | Mode                                | You provide                                                                                                                                                                                                                   |
| ------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres      | external                            | a Secret with the connection URI, and the pods that serve it (for the network policy)                                                                                                                                         |
| OneCLI        | `bundled`, `external` or `disabled` | `bundled`: nothing (`hack/onecli.sh` installs the upstream chart, its policies and the bootstrap, see below). `external`: gateway and API URLs, optional CA ConfigMap and token Secrets. `disabled` runs scripted models only |
| agent-sandbox | external                            | the controller and CRDs, v1.0.11 or newer (`hack/agent-sandbox.sh external` checks them)                                                                                                                                      |
| gVisor        | `RuntimeClass gvisor`               | on the nodes, or `security.allowInsecureRuntime=true`                                                                                                                                                                         |

Bundled Postgres (`charts/pi-postgres`) and bundled OneCLI (`charts/pi-onecli` plus the upstream chart, slice 10) are
separate releases; bundled agent-sandbox comes in a later slice, and the schema rejects `agentSandbox.mode=bundled` until
then.

The chart creates no CRD, no CloudNativePG resource, nothing cluster-scoped and nothing outside the release namespace. It
never generates a Secret and uses no `lookup`, so `helm template`, render tests and GitOps work.

## Install

Use [`hack/install.sh`](../../hack/install.sh): it renders the chart, creates the namespace with the restricted Pod
Security labels, creates the missing `sandboxd-auth` and `api-auth` Secrets once, checks agent-sandbox, installs the chart
and prints `GET /admin/status`.

```sh
cat >local/values.yaml <<'YAML'                 # local/ is git-ignored
images:
  orchestrator: { repository: registry.example.com/team/pi-orchestrator, digest: sha256:... }
  ingest:       { repository: registry.example.com/team/pi-ingest,       digest: sha256:... }
  sandbox:      { repository: registry.example.com/team/pi-sandbox,      digest: sha256:... }
database:
  external:
    existingSecret: pi-database             # key uri: postgres://... (or DATABASE_URL=... for install.sh to create it once)
    egress: { namespace: databases, podSelector: { app.kubernetes.io/name: postgres } }
YAML
KUBE_CONTEXT=my-cluster hack/install.sh --namespace pi-durable --values local/values.yaml
```

With Helm directly (create the namespace and the Secrets yourself first):
`helm upgrade --install pi-durable charts/pi-durable -n pi-durable -f local/values.yaml`.

One release per namespace: object names are fixed (`pi-orchestrator`, `pi-ingest`, `pi-env-template`, `pi-env-pool`, their `-<size>` variants,
`sandboxd-auth`, `api-auth`) because the policies, ingest's shard routing and the e2e suites select on them. One install
per database: the schema `inbox` is fixed.

## Values

[`values.yaml`](values.yaml) is commented; [`values.schema.json`](values.schema.json) rejects unknown keys and bad values.

| Value                                                      | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `images.{orchestrator,ingest,sandbox}`                     | `repository` plus `tag` and/or `digest`; one of them is required. Prefer digests                                                                                                                                                                                                                                                                                                                                                                            |
| `database.external.existingSecret`, `uriKey`               | Secret holding the Postgres URI (direct or session mode, never a transaction pooler)                                                                                                                                                                                                                                                                                                                                                                        |
| `database.tls.*`                                           | TLS towards the database, verified: `mode` (`disable`, `verify-ca`, `verify-full`), `existingSecret`, `caKey`, optional `certKey`/`keyKey`. See [docs/database-tls.md](../../docs/database-tls.md)                                                                                                                                                                                                                                                          |
| `database.external.egress`                                 | where the orchestrator and ingest may connect: `podSelector` (in `namespace`, default the release namespace) and/or `cidrs`, `port`. Required, or `default-deny-all` makes the database unreachable                                                                                                                                                                                                                                                         |
| `onecli.mode`                                              | `bundled` (the release `hack/onecli.sh` installed in this namespace), `external` or `disabled` (scripted models only; the model allowlist may name no other provider)                                                                                                                                                                                                                                                                                       |
| `onecli.bundled.*`                                         | `release` (default `onecli`), `caConfigMap` (`pi-onecli-ca`), `agentTokenSecret` (`pi-onecli`), `adminKeySecret` (`pi-onecli-admin`): the names the bootstrap writes. In bundled mode the references are required: no bootstrap, no orchestrator                                                                                                                                                                                                            |
| `onecli.external.*`                                        | `apiUrl`, `gatewayUrl` (required for external); optional `caConfigMap` (key `ca.pem`), `agentTokenSecret` (key `agent-token`), `adminKeySecret` (key `api-key`); `namespace` and `podSelector` for the policies. Policy ports come from the URLs                                                                                                                                                                                                            |
| `onecli.namePrefix`                                        | prefix of the agents and secrets this install creates in OneCLI; distinct per install on a shared OneCLI (ADR 0013)                                                                                                                                                                                                                                                                                                                                         |
| `sandbox.runtimeClassName`                                 | default `gvisor`. Anything else, including empty (the node default), needs `security.allowInsecureRuntime`                                                                                                                                                                                                                                                                                                                                                  |
| `security.allowInsecureRuntime`                            | acknowledges a runtime that is not gVisor; also sets `PI_ALLOW_INSECURE_RUNTIME=1`, which the orchestrator checks at start                                                                                                                                                                                                                                                                                                                                  |
| `sandbox.storageClass`, `masterSecret`                     | workspace PVCs (use a class that reclaims with `Delete`), the sandboxd master Secret (key `master`)                                                                                                                                                                                                                                                                                                                                                         |
| `sandbox.sizes`, `sandbox.defaultSize`                     | named sandbox sizes (default `s`, `m`, `l`, `xl`), each with `resources`, `workspaceSize`, `ephemeralStorage` and `warmPoolReplicas`; one SandboxTemplate `pi-env-template-<size>` and SandboxWarmPool `pi-env-pool-<size>` each, plus the unsized `pi-env-template`/`pi-env-pool` on the default size. Profiles and `POST /sessions` pick among them ([ADR 0030](../../docs/decisions/0030-sandbox-sizes.md)); a changed size applies to new sessions only |
| `networkPolicy.provider`                                   | `cilium` (plus CiliumNetworkPolicies) or `standard` (plain policies; adds the orchestrator's API-server egress rule)                                                                                                                                                                                                                                                                                                                                        |
| `networkPolicy.kubeApiCidrs`                               | `standard` only: the API server's addresses. Empty: TCP 443 and 6443 to any destination                                                                                                                                                                                                                                                                                                                                                                     |
| `networkPolicy.ingest.clients`                             | who may reach ingest :8080, as raw `from` entries (an ingress controller). Empty: no policy                                                                                                                                                                                                                                                                                                                                                                 |
| `networkPolicy.orchestrator.extraEgress`                   | extra raw egress rules (for example `api.github.com:443` with `standard`)                                                                                                                                                                                                                                                                                                                                                                                   |
| `networkPolicy.sandbox.extraEgressExcept`                  | CIDRs (IPv4 or IPv6) sandboxes must not reach, added to the built-in `except` lists of `sandbox-allow-internet-egress` by address family: a public Kubernetes API endpoint, global IPv6 node and pod ranges, an external database or OneCLI on a public IP, NAT64 `64:ff9b::/96`. Default `[]`                                                                                                                                                              |
| `images.egressProxy.*`                                     | Image of the egress proxy (`repository`, `tag`, `digest`, `pullPolicy`); needed only with `egressProxy.enabled`                                                                                                                                                                                                                                              |
| `egressProxy.enabled`                                      | Deploy the egress proxy (ADR 0035): 2 replicas, PodDisruptionBudget, Service `pi-egress-proxy:3128`, restricted Pods without an API token. Default `false`; no sandbox uses it yet                                                                                                                                                                         |
| `egressProxy.database.existingSecret`, `.uriKey`           | Required with the proxy: a Secret with the URI of its **read-only** role (`pi_egress`: select on the egress tables, write on `egress.proxy_status` only; `select egress.grant_proxy_reader('<role>')`, or `auth.egressReader` of charts/pi-postgres)                                                                                                       |
| `egressProxy.rules.pollInterval`, `.staleAfter`            | Read interval (default `5s`, plus LISTEN) and the age after which the proxy denies everything (default `2m`)                                                                                                                                                                                                                                              |
| `egressProxy.platform.hosts`, `.cidrs`                     | Extra names and cidrs no rule can open, on top of ingest, the orchestrators, OneCLI, `kubernetes.default.svc`, the database host, `networkPolicy.kubeApiCidrs` and `database.external.egress.cidrs`. Add the namespace's pod range when approving a wide private range                                                                                       |
| `egressProxy.clients`, `.publicPorts`, `.resources`        | Extra `from` entries for the proxy port (besides sandboxes); public ports it may open (default `[80, 443]`); resources                                                                                                                                                                                                                                      |
| `egressProxy.privateEgress`                                | Operator-approved private destinations: entries with a `cidr` or `namespaceSelector` (+ `podSelector`) and `ports`. A private rule in the database is still needed. Default `[]`                                                                                                                                                                          |
| `orchestrator.shards`                                      | number of orchestrator Deployments (can only grow, see below); `resources`, `noProxy`, `extraEnv`                                                                                                                                                                                                                                                                                                                                                           |
| `console.enabled`                                          | serve the admin console under `/console/` from the ingest image (default `false`: `/console/` is a 404). See [Admin console](#admin-console)                                                                                                                                                                                                                                                                                                                |
| `console.catalogs`                                         | `manage` (default) or `readOnly`: whether the console's Skills and MCP servers screens offer writes. UI only, see [Admin console](#admin-console)                                                                                                                                                                                                                                                                                                           |
| `ingest.httpRoute.*`                                       | optional Gateway API HTTPRoute to ingest: `enabled`, `parentRefs`, `hostnames`, `paths` (prefixes, default `/`), `annotations`. See [Routes](#routes)                                                                                                                                                                                                                                                                                                       |
| `ingest.ingress.*`                                         | optional Ingress to ingest: `enabled`, `className`, `hosts`, `paths`, `tls`, `annotations`. See [Routes](#routes)                                                                                                                                                                                                                                                                                                                                           |
| `ingest.replicas`, `resources`                             | ingest scale                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `api.admins`, `api.existingSecret`                         | owners who may call `/admin/*`; Secret with key `tokens`, one `owner:token` line per owner                                                                                                                                                                                                                                                                                                                                                                  |
| `models.default`, `allowlist`, `turnBudget`, `tokenBudget` | seeds Postgres once (ADR 0008); change later with `PUT /admin/settings`                                                                                                                                                                                                                                                                                                                                                                                     |
| `github.app.existingSecret`                                | optional GitHub App key and ids; repo sessions are off without it                                                                                                                                                                                                                                                                                                                                                                                           |
| `github.repoAllowlist`                                     | seeds the repositories a session may clone (`owner/name`, `owner/*`, `*`; ADR 0032); empty refuses every repo session. Seed only: change later on the console or with `PUT /admin/settings`                                                                                                                                                                                                                                                                 |
| `imagePullSecrets`                                         | for private registries                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Admin console

`console.enabled: true` makes ingest serve the console (a React app, [docs/admin-ui-plan.md](../../docs/admin-ui-plan.md))
at `/console/`. The page and its assets are static and need no token; an operator types their owner token into it (an
`api.admins` owner with a line in `api.existingSecret`), and the browser sends it as `Authorization: Bearer` to
`/admin/*` of the same origin. A wrong token is `401`, an owner that is not in `api.admins` is `403`. Console and `/admin/*`
responses carry `Cache-Control: no-store`, a CSP of `default-src 'self'; frame-ancestors 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

Access:

- Prefer a localhost port-forward: `kubectl -n pi-durable port-forward svc/pi-ingest 8080:8080`, then open
  `http://localhost:8080/console/`.
- `ingest.httpRoute` or `ingest.ingress` publishes ingest on a hostname (see [Routes](#routes)). A NetworkPolicy cannot filter by path: if ingest is also reachable by ordinary
  clients through your ingress, that ingress must route `/console` and `/admin` only through operator access (a
  restricted HTTPS route, VPN or an authenticating proxy), and must rate-limit failed sign-ins: ingest does not.
- Tokens are the existing named bearer tokens; a change takes effect after the ingest pods restart.

`console.catalogs: readOnly` removes the publish, register, edit, enable, disable and delete controls from the Skills and
MCP servers screens (browsing, history and the skill zip download stay). Ingest tells the page through
`GET /console/config.json` (`{"catalogs":"readOnly"}`, no token needed). This hides controls only: `/admin/*` still accepts
writes from every admin, so it is not an access control. Use it when a catalog repository is meant to be the one writer.

### Routes

Off by default; `kubectl port-forward` needs no route. `ingest.httpRoute` renders a Gateway API `HTTPRoute` and
`ingest.ingress` an `Ingress`, both named `pi-ingest` and pointing at the `pi-ingest` Service, port 8080
([ADR 0026](../../docs/decisions/0026-ingest-routes.md)). Either one also needs `networkPolicy.ingest.clients` to admit
the gateway's pods, because `default-deny-all` drops its traffic otherwise; the chart refuses to render a route without
it. For an Envoy Gateway named `main`:

```yaml
networkPolicy:
  ingest:
    clients:
      - namespaceSelector: { matchLabels: { kubernetes.io/metadata.name: envoy-gateway-system } }
        podSelector:
          {
            matchLabels:
              { app.kubernetes.io/name: envoy, gateway.envoyproxy.io/owning-gateway-name: main },
          }
ingest:
  httpRoute:
    enabled: true
    parentRefs: [{ name: main, namespace: envoy-gateway-system, sectionName: https }]
    hostnames: [pi.example.lan]
```

`timeouts.stream` (default `0s`, no total limit) applies to `GET /sessions/{id}/stream`, which gets its own rule when
`paths` reach `/sessions/`: a session may run for days, and a gateway default (Envoy Gateway: 15 s) would cut the stream.
Dead connections go by the gateway's idle timeout (ingest sends a keepalive every 15 s); a client that loses the stream
resumes with `Last-Event-ID`. `timeouts.request` (default: the gateway's) applies to every other path. With an Ingress,
raise the controller's read timeout for the stream with its annotations.

`paths: ["/"]` (the default) serves the session API, `/admin` and the console; `["/console", "/admin"]` serves only the
operator screens. Ingest does not rate-limit failed sign-ins: keep the route on a trusted network, or rate-limit and
authenticate on the gateway.

### Models and OneCLI

The defaults are scripted models and `onecli.mode: disabled`. For real models, point at your OneCLI and name the provider:

```yaml
onecli:
  mode: external
  external:
    apiUrl: http://onecli.onecli:10256
    gatewayUrl: http://onecli.onecli:10255
    caConfigMap: onecli-ca
    agentTokenSecret: pi-onecli
models:
  default: { provider: openai-codex, id: gpt-6.1-terra, reasoning: medium }
  allowlist: [openai-codex/gpt-6.1-terra, scripted/scripted-1]
```

Or let `hack/install.sh` bring OneCLI with `--set onecli.mode=bundled` (`hack/kind-up.sh --onecli` does that on kind). Before
the chart is installed, `hack/onecli.sh` installs `charts/pi-onecli` (network policies: the management API is reachable only
from the orchestrator and a bootstrap Pod), the upstream chart `oci://ghcr.io/onecli/charts/onecli` 2.20.0 as release
`onecli` (runner off, one replica, no Redis, the `onecli` database of `charts/pi-postgres`, or `ONECLI_DATABASE_URL`), and
the bootstrap. OneCLI cannot close sign-up, so keep the API and dashboard off every Ingress
([ADR 0022](../../docs/decisions/0022-bundled-onecli.md), sign-in: [model credentials](../../docs/model-credentials.md#bundled-onecli-sign-in-and-credentials)).

Model credentials stay in the orchestrator; they are never mounted into a sandbox.

## Shards

`orchestrator.shards: N` renders Deployments `pi-orchestrator` (shard 0, the name of a single-shard stack) and
`pi-orchestrator-1` ... `pi-orchestrator-<N-1>`, each with one replica and strategy `Recreate` (one owner per schema,
[ADR 0017](../../docs/decisions/0017-schema-sharding.md)), a Service per shard (`pi-orchestrator-<k>`, and
`pi-orchestrator` for shard 0), and points ingest at them (`PI_ORCH_SHARDS`, `PI_ORCH_URL` with `{shard}`). Raise the
value with `helm upgrade`. **Never lower it**: a session stays on its shard, and ingest refuses to start when it finds
sessions on a shard without a route. Never put an HPA on a shard.

## Isolation

- **Runtime.** Only the operator picks it. A runtime other than `gvisor` without `security.allowInsecureRuntime` makes the
  chart refuse to render (schema and template). NOTES.txt warns when it is allowed, and `GET /admin/status` reports the
  configured and the observed runtime per shard.
- **Network policy.** `default-deny-all` plus explicit allows, always rendered. A sandbox can reach DNS, the OneCLI
  gateway port and the public internet (not the private, link-local or loopback ranges); it cannot reach the
  orchestrator, ingest, the database, the Kubernetes API, the OneCLI management API or another sandbox. Policies only work on
  a CNI that enforces them: the chart cannot tell, so the orchestrator (shard 0) runs an **isolation probe** at start and
  on `POST /admin/status/probe`: a short-lived Pod with the sandbox's labels tries the denied targets, with positive
  controls, and the result (`enforced | not-enforced | inconclusive`) is in `GET /admin/status`. It only warns; it needs
  `create`/`list` on pods and `get` on pods/log, which the chart's Role grants in the namespace. Read the state, never
  assume it. See [network policy](../../docs/network-policy.md#isolation-probe).
- Changing the runtime or security settings later does not reach existing Sandboxes (ADR 0019): the template is copied
  into each Sandbox. Recycle them.

Read the state:

```sh
kubectl -n pi-durable port-forward svc/pi-ingest 8080:8080 &
TOKEN=$(kubectl -n pi-durable get secret api-auth -o jsonpath='{.data.tokens}' | base64 -d | sed -n 's/^admin://p')
curl -s -H "Authorization: Bearer $TOKEN" localhost:8080/admin/status
curl -s -X POST -H "Authorization: Bearer $TOKEN" localhost:8080/admin/status/probe   # run the isolation probe again
```

## Tests

`packages/orchestrator/test/pi-durable-chart.test.ts` renders every mode (cilium/standard, OneCLI bundled/external/disabled,
insecure runtime, one and three shards), checks the runtime guard, the kinds, the network-policy invariants and the
schema. `pod-security.test.ts` checks the rendered pods against the restricted profile. `tests/e2e/run.sh` installs this
chart for every run.
