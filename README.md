# pi-durable-k8s

Run [Pi Durable](https://github.com/earendil-works/pi) coding agents on your own Kubernetes cluster.

Each session gets an agent that keeps its state in PostgreSQL and resumes after a crash, plus a private gVisor
sandbox with a persistent workspace where its tools run. Model and GitHub credentials never reach the agent or the
sandbox: [OneCLI](https://github.com/onecli/onecli) injects them at its gateway.

**Status: proof of concept.** It has been tested end to end in one small arm64 example environment. It is not hardened for production;
see the open items in [plan.md](plan.md).

![Architecture](docs/architecture.svg)

## How it works

1. A client creates a session and posts messages to the **session API** (`packages/ingest`).
2. Messages land in an inbox in **PostgreSQL** first, so nothing is lost while the agent is busy or restarting.
3. The **orchestrator** (`packages/orchestrator`) runs one durable Pi agent loop per session and takes inbox
   messages in order. It scales out by Postgres schema: one orchestrator Deployment per shard, and a new session goes to
   the shard with the fewest active sessions ([scaling](docs/scaling.md)).
4. Model calls go through the **OneCLI gateway**, which adds the subscription or API key on the way out.
5. Tool calls (bash, read, write, edit) run in the session's **sandbox**: a pod from
   [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) under gVisor, with the `pi-env` daemon inside.
   It is created on the first tool call (a repository session's is provisioned and cloned before its first input) and
   keeps its workspace on a PVC. The orchestrator reaches it through an
   in-process broker and a thin relay per session ([ADR 0016](docs/decisions/0016-in-process-broker.md)); an idle
   sandbox is suspended and resumed by the next tool call.
6. Progress and answers stream back to the client over SSE.

Optionally a session works on one GitHub repository: the orchestrator mints a token scoped to that repository,
stores it in OneCLI for that session only, and the sandbox clones and pushes through the gateway.

Operators change the default model, the allowlist, session profiles (tools, instructions, MCP servers, skills) and the
MCP server catalog at runtime through the admin API; they live in Postgres, not in manifests
([session API](docs/session-api.md)).

## Security model

- Sandboxes run under gVisor. Network policies (written for Cilium) block sandboxes from the orchestrator, the
  database, the Kubernetes API, OneCLI's management API and each other.
- Each sandbox's daemon accepts only its own token, derived from a master key the orchestrator holds
  ([ADR 0001](docs/decisions/0001-per-sandbox-sandboxd-token.md)).
- No upstream credentials (model keys, GitHub tokens) in sandboxes or in the agent: OneCLI holds them and only relays to
  allowlisted hosts ([host rules](docs/onecli-host-rules.md)). A repository session's sandbox can read its own per-session
  OneCLI proxy token, which is only usable through the gateway ([repo workspace](docs/repo-workspace.md)).

## Repository layout

| Path                                   | What                                                                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/ingest`                      | Session API: auth, owner checks, inbox writes, SSE proxy                                                                   |
| `packages/orchestrator`                | Pi Durable harness, sandbox lifecycle, model and OneCLI wiring                                                             |
| `packages/sandbox-env`                 | Bridge from Pi's `RemoteExecutionEnv` to an agent-sandbox pod (the only SDK user)                                          |
| `packages/session-core`                | Shared schema, migrations, settings, profiles, skills, MCP catalog and auth helpers                                        |
| `packages/egress-proxy`                | Go module: Smokescreen chained to OneCLI, a spike not yet deployed ([ADR 0012](docs/decisions/0012-egress-proxy-spike.md)) |
| `packages/vendor/agent-sandbox-client` | Vendored, pinned agent-sandbox TypeScript SDK (Apache-2.0)                                                                 |
| `vendor/`                              | Packed `@netzlabor/pi-durable-postgres` adapter, ported to Pi Durable 1.5.2                                                |
| `images/`                              | Multi-arch app, sandbox and e2e driver builds; egress proxy spike                                                          |
| `deploy/`                              | Kubernetes manifests (namespace, Postgres, orchestrator, ingest, sandbox template, network policies)                       |
| `tests/e2e`                            | End-to-end suites that run as in-cluster Jobs                                                                              |
| `examples/`                            | Load-test and bug-hunt scripts; historical results in [lab notes](docs/lab-notes.md)                                       |
| `docs/`                                | API, credentials, networking, scaling, metrics, decisions (`docs/decisions/`) and research notes                           |

## Docs

- [Session API](docs/session-api.md)
- [Model credentials through OneCLI](docs/model-credentials.md)
- [Repository workspaces](docs/repo-workspace.md)
- [Scaling: one orchestrator per schema shard](docs/scaling.md)
- [Timing and memory metrics](docs/metrics.md)
- [End-to-end suites, one namespace per run](docs/e2e.md)
- [Pod Security: the restricted level](docs/decisions/0019-restricted-pod-security.md)
- [Network policy](docs/network-policy.md) and [OneCLI host rules](docs/onecli-host-rules.md)
- [Installation plan: Helm, bundled dependencies, kind](docs/install-plan.md)
- [Architecture decision records](docs/decisions/)
- [Plan, decisions and phase results](plan.md)

## Quick start on kind

One command gives you the whole stack on a laptop, with no cluster, credentials or model account: a kind cluster, the
agent-sandbox controller, a bundled Postgres, and `pi-durable` on the scripted model (the message text is the script, see
the [session API](docs/session-api.md)). It needs docker, kind 0.24 or newer, helm 4, kubectl and openssl.

```sh
hack/kind-up.sh                 # published images for this commit (IMAGE_TAG=<tag> picks another)
hack/kind-up.sh --build         # or build the images here (native architecture) and load them into the node
hack/kind-smoke.sh              # a session, a message, a tool call in the sandbox, a replaced Pod, deletion
hack/kind-up.sh --build --onecli  # the same plus the bundled OneCLI (credential gateway), for real models
hack/kind-smoke.sh --onecli     # also: the orchestrator's way through the gateway, and the OneCLI API closed to everyone else
hack/kind-down.sh               # delete the cluster
```

`--onecli` adds three to five minutes (it pulls the OneCLI images, several hundred MB). It installs the upstream OneCLI chart, a bootstrap
(account, orchestrator agent token, host allowlist, public CA) and network policies that keep OneCLI's API open only to the
orchestrator. The dashboard has no Ingress; sign in over `kubectl port-forward`, with the login from a Secret
([how, and what works that way](docs/model-credentials.md#bundled-onecli-sign-in-and-credentials)). OneCLI cannot close its
sign-up, so never put its API or dashboard behind an Ingress without blocking `/auth/signup` and `/auth/sign-up*`
([ADR 0022](docs/decisions/0022-bundled-onecli.md)).

It takes about five minutes (the first run pulls the node image and the application images). It prints where the API token
is (it never prints the token) and how to port-forward, and shows the isolation probe from `GET /admin/status`. The
cluster is named `pi-durable` (`--name` or `KIND_CLUSTER_NAME`) and every command uses its own `kind-<name>` context, never
your current one. **Not for real use:** the sandboxes run under runc, not gVisor
([values-kind.yaml](charts/pi-durable/values-kind.yaml)). kindnet blocks the sandbox's access to Postgres and the
orchestrator, but not to hostNetwork Pods (the Kubernetes API server, kubelet, etcd), so the probe reports `not-enforced`
on kind because the `kube-api` target is reachable; the smoke test accepts that one finding and fails on any other.
CI runs this on every pull request ([workflow](.github/workflows/kind.yml)).

## Deploy on your cluster

The app is the Helm chart [`charts/pi-durable`](charts/pi-durable/README.md), installed with `hack/install.sh`
([install plan](docs/install-plan.md); the `deploy/` manifests are being replaced by it).

Prerequisites (separate from the chart): the **agent-sandbox controller with extensions** (v1.0.11; `hack/agent-sandbox.sh
external` checks it), a gVisor RuntimeClass named `gvisor` (or `security.allowInsecureRuntime` for evaluation), a Postgres 17
reachable by URI (CloudNativePG or any other), OneCLI (tested with v2.20.0) unless you only use scripted models, a
NetworkPolicy-enforcing CNI such as Cilium (or `networkPolicy.provider: standard`), and a dynamically provisioned
StorageClass. Do not use real credentials until the isolation suite passes. Build the application and sandbox images
for your nodes (amd64 and arm64 are supported, [build instructions](deploy/README.md#build-images)).

```sh
# values.yaml: your image digests, database.external (Secret with the URI + egress selector), onecli, models
KUBE_CONTEXT=your-context hack/install.sh --namespace pi-durable --values local/values.yaml
```

It creates the namespace with the restricted Pod Security labels and the missing `sandboxd-auth` and `api-auth` Secrets,
installs the chart and prints the runtime and network-policy state from `GET /admin/status`. Read the
[chart README](charts/pi-durable/README.md) for the values, [credentials](docs/model-credentials.md) for OneCLI and
[network policy](docs/network-policy.md) for the isolation rules. The older kustomize base in [deploy settings](deploy/README.md)
still works until the chart replaces it.

Test in a disposable namespace: `KUBE_CONTEXT=your-context STORAGE_CLASS=your-storage-class tests/e2e/run.sh smoke`. Omit
`STORAGE_CLASS` for the cluster default; set `ORCH_IMAGE`, `INGEST_IMAGE`, `DRIVER_IMAGE` and `SANDBOX_IMAGE` to your pushed
image digests. Every run installs the chart. See [e2e](docs/e2e.md) for OneCLI ingress rules, secret-store access,
prerequisites and the isolation suite (`phase3`). Never test against production.

## Development

Requires Node 22.19+, pnpm and Go (`pnpm check` also builds, vets and tests `packages/egress-proxy`; the toolchain is pinned in its `go.mod`).

```sh
pnpm install
pnpm check        # build, lint, format, typecheck, unit tests
tests/e2e/run.sh smoke   # needs a cluster with agent-sandbox, gVisor, CNPG; deploys its own namespace pi-e2e-<id> and deletes it
```

## License

MIT, see [LICENSE](LICENSE). The vendored agent-sandbox SDK in `packages/vendor/agent-sandbox-client` keeps its Apache-2.0 license.
