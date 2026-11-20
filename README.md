# cela: sandboxed, durable Pi agents on Kubernetes

_cela_ — Polish for _cell_; every session runs in its own.

Run [Pi Durable](https://github.com/earendil-works/pi) coding agents on your own Kubernetes cluster.

Each session gets an agent that keeps its state in PostgreSQL and resumes after a crash, plus a private gVisor
sandbox with a persistent workspace where its tools run. Model and GitHub credentials never reach the agent or the
sandbox: [OneCLI](https://github.com/onecli/onecli) injects them at its gateway. Sessions are started over HTTP or, from
a coding agent such as Claude Code or Codex, through the bundled MCP adapter.

**Status: proof of concept.** It has been tested end to end in one small arm64 example environment. It is not hardened for production;
see the open items in [plan.md](plan.md).

![Architecture](docs/architecture.svg)

## How it works

1. A client creates a session and posts messages to the **session API** (`packages/ingest`). A coding agent can do the
   same through the stdio **MCP adapter** (`packages/mcp`, [docs](docs/mcp-adapter.md)); operators use the admin console
   that ingest serves under `/console/`.
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
   sandbox is suspended and resumed by the next tool call. A profile picks the sandbox size
   ([ADR 0030](docs/decisions/0030-sandbox-sizes.md)) and flavour: `default`, or `browser` with Chromium, Patchright
   and agent-browser ([ADR 0041](docs/decisions/0041-browser-sandbox.md)).
6. Through the **egress proxy** (`packages/egress-proxy`, on by default) the sandbox's only way out is the proxy: each
   connection is checked against the profile's rules and audited, git goes on to OneCLI, allowed sites to the internet
   ([ADR 0038](docs/decisions/0038-network-modes.md)).
7. Progress and answers stream back to the client over SSE.

Optionally a session works on one GitHub repository: the orchestrator mints a token scoped to that repository,
stores it in OneCLI for that session only, and the sandbox clones and pushes through the gateway.

Operators change the default model, the allowlist, session profiles (tools, instructions, MCP servers, skills) and the
MCP server catalog at runtime through the admin API; they live in Postgres, not in manifests
([session API](docs/session-api.md)).

## Security model

- Sandboxes run under gVisor. Kubernetes network policies block sandboxes from the orchestrator, the database, the
  Kubernetes API, OneCLI's management API and each other. Any CNI that enforces NetworkPolicy works
  (`networkPolicy.provider: standard`); with `cilium` (the chart default) it adds Cilium policies (API server entity, FQDN egress),
  and Cilium is what the e2e suites run on ([network policy](docs/network-policy.md)).
- With the egress proxy on, a sandbox has no DNS and no direct internet: every connection goes through the proxy, under
  the profile's rules, and is logged. `networkMode: direct` is an operator opt-in ([ADR 0038](docs/decisions/0038-network-modes.md)).
- Each sandbox's daemon accepts only its own token, derived from a master key the orchestrator holds
  ([ADR 0001](docs/decisions/0001-per-sandbox-sandboxd-token.md)).
- No upstream credentials (model keys, GitHub tokens) in sandboxes or in the agent: OneCLI holds them. It relays any host by default and an allowlist is opt-in hardening
  ([ADR 0043](docs/decisions/0043-open-onecli-defaults.md), [host rules](docs/onecli-host-rules.md)). A repository session's sandbox can read its own per-session
  OneCLI proxy token, which is only usable through the gateway ([repo workspace](docs/repo-workspace.md)).
- Accepted risk for the proof of concept: the orchestrator holds the OneCLI admin key and the GitHub App private key
  ([ADR 0042](docs/decisions/0042-onecli-admin-key-in-orchestrator.md)).

## Repository layout

| Path                                   | What                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/ingest`                      | Session API: auth, owner checks, inbox writes, SSE proxy                                                                                               |
| `packages/mcp`                         | Stdio MCP adapter: coding agents start and follow sessions through the session API ([docs](docs/mcp-adapter.md))                                       |
| `packages/admin-ui`                    | Admin console (React, Vite, Tailwind, shadcn/ui), served by ingest under `/console/` ([plan](docs/admin-ui-plan.md))                                   |
| `packages/orchestrator`                | Pi Durable harness, sandbox lifecycle, model and OneCLI wiring                                                                                         |
| `packages/sandbox-env`                 | Bridge from Pi's `RemoteExecutionEnv` to an agent-sandbox pod (the only SDK user)                                                                      |
| `packages/session-core`                | Shared schema, migrations, settings, profiles, skills, MCP catalog and auth helpers                                                                    |
| `packages/egress-proxy`                | Go module: the egress proxy, Smokescreen with rules from Postgres and a OneCLI route ([ADR 0035](docs/decisions/0035-egress-proxy-runtime.md))         |
| `packages/browser-proxy`               | Loopback forwarder in the browser sandbox: adds the session's egress token to Chromium's CONNECTs ([ADR 0041](docs/decisions/0041-browser-sandbox.md)) |
| `packages/vendor/agent-sandbox-client` | Vendored, pinned agent-sandbox TypeScript SDK (Apache-2.0)                                                                                             |
| `images/`                              | Multi-arch builds: app, egress proxy, sandbox, browser sandbox and e2e driver                                                                          |
| `charts/`                              | Helm charts: `cela` (the app), `pi-postgres` (bundled database), `pi-onecli` (bundled credential gateway)                                              |
| `hack/`                                | `install.sh`, the kind scripts and the operator scripts (secrets, OneCLI CA and host rules)                                                            |
| `tests/e2e`                            | End-to-end suites that run as in-cluster Jobs                                                                                                          |
| `examples/`                            | Load-test and bug-hunt scripts; historical results in [lab notes](docs/lab-notes.md)                                                                   |
| `docs/`                                | API, credentials, networking, scaling, metrics, decisions (`docs/decisions/`) and research notes                                                       |

## Docs

- [Session API](docs/session-api.md)
- [MCP adapter for coding agents](docs/mcp-adapter.md)
- [Model credentials through OneCLI](docs/model-credentials.md)
- [Repository workspaces](docs/repo-workspace.md)
- [Scaling: one orchestrator per schema shard](docs/scaling.md)
- [Timing and memory metrics](docs/metrics.md)
- [End-to-end suites, one namespace per run](docs/e2e.md)
- [Pod Security: the restricted level](docs/decisions/0019-restricted-pod-security.md)
- [Network policy](docs/network-policy.md) and [OneCLI host rules](docs/onecli-host-rules.md)
- Egress: [rules](docs/decisions/0034-egress-rules.md), [proxy](docs/decisions/0035-egress-proxy-runtime.md),
  [network modes](docs/decisions/0038-network-modes.md)
- [Sandbox sizes](docs/decisions/0030-sandbox-sizes.md) and the [browser sandbox](docs/decisions/0041-browser-sandbox.md)
- [Installation plan: Helm, bundled dependencies, kind](docs/install-plan.md)
- [Architecture decision records](docs/decisions/)
- [Plan, decisions and phase results](plan.md)

## Quick start on kind

One command gives you the whole stack on a laptop, with no cluster, credentials or model account: a kind cluster, the
agent-sandbox controller, a bundled Postgres, and `cela` on the scripted model (the message text is the script, see
the [session API](docs/session-api.md)). It needs docker, kind 0.24 or newer, helm 4, kubectl and openssl.

```sh
hack/kind-up.sh                 # published images for this commit (IMAGE_TAG=<tag> picks another)
hack/kind-up.sh --build         # or build the images here (native architecture) and load them into the node
hack/kind-smoke.sh              # a session, a message, a tool call in the sandbox, a replaced Pod, deletion
hack/kind-up.sh --build --onecli  # the same plus the bundled OneCLI (credential gateway), for real models
hack/kind-up.sh --build --no-expose  # no localhost ports (8080, 10254, 10256): use kubectl port-forward
hack/kind-up.sh --build --no-egress-proxy  # opt out of the egress proxy: sandboxes get direct internet
hack/kind-smoke.sh --onecli     # also: the orchestrator's way through the gateway, and the OneCLI API closed to everyone else
hack/kind-down.sh               # delete the cluster
```

`--onecli` adds three to five minutes (it pulls the OneCLI images, several hundred MB). It installs the upstream OneCLI chart, a bootstrap
(account, orchestrator agent token, host allowlist, public CA) and network policies that keep OneCLI's API open only to the
orchestrator. The dashboard has no Ingress; on kind it is on `http://localhost:10254` (see below), and the login is in a
Secret ([how, and what works that way](docs/model-credentials.md#bundled-onecli-sign-in-and-credentials)). OneCLI cannot close its
sign-up, so never put its API or dashboard behind an Ingress without blocking `/auth/signup` and `/auth/sign-up*`
([ADR 0022](docs/decisions/0022-bundled-onecli.md)).

It takes about five minutes (the first run pulls the node image and the application images). It prints one line per step
and keeps what kind, helm and kubectl print in a log file, shown only when a step fails (`--verbose`, or `CI` set, streams
it). It then checks that each endpoint answers and ends with a summary: the admin console on
`http://localhost:8080/console/`, the session API on `http://localhost:8080` and, with `--onecli`, the OneCLI dashboard on
`http://localhost:10254` (its API on `:10256`), each marked ready or not, with no `kubectl port-forward`; the commands that
copy the admin API token (the console's sign-in) and the OneCLI login to the clipboard (it never prints a secret); the
isolation probe from `GET /admin/status` and the runc warning; and the next steps. These ports are published on 127.0.0.1 only, are admitted by the network
policies from one address (the Docker gateway of the kind network, a /32) and not from sandboxes
([network policy](docs/network-policy.md#kind-localhost-ports-kind-only)). They exist only when the cluster is created:
`hack/kind-up.sh --no-expose` skips them (use `kubectl port-forward`), and an existing cluster without them is refused, so
run `hack/kind-down.sh` first. On kind a sandbox can still reach the node's own ports (API server, kubelet) without
credentials: kindnet cannot filter that. `hack/kind-up.sh --cni cilium` creates the cluster with Cilium instead, where the
probe must report `enforced` and the smoke test fails if a sandbox reaches the node (slower to start; issue #139). The
cluster is named `cela` (`--name` or `KIND_CLUSTER_NAME`) and every command uses its own `kind-<name>` context, never
your current one. **Not for real use:** the sandboxes run under runc, not gVisor
([values-kind.yaml](charts/cela/values-kind.yaml)). kindnet blocks the sandbox's access to Postgres and the
orchestrator, but not to hostNetwork Pods (the Kubernetes API server, kubelet, etcd), so the probe reports `not-enforced`
on kind because the `kube-api` target is reachable; the smoke test accepts that one finding and fails on any other.
CI runs this on every pull request, and the Cilium lane on main, nightly and by hand ([workflow](.github/workflows/kind.yml)).

## Deploy on your cluster

The app is the Helm chart [`charts/cela`](charts/cela/README.md), installed with `hack/install.sh`
([install plan](docs/install-plan.md)).

Prerequisites (separate from the chart): the **agent-sandbox controller with extensions** (v1.0.11; `hack/agent-sandbox.sh
external` checks it), a gVisor RuntimeClass named `gvisor` (or `security.allowInsecureRuntime` for evaluation), a Postgres 17
reachable by URI (the bundled `charts/pi-postgres` or any other), OneCLI (tested with v2.20.0) unless you only use scripted models, a
NetworkPolicy-enforcing CNI (the default `networkPolicy.provider: cilium` needs Cilium; `standard` works with any other), and a dynamically provisioned
StorageClass. Do not use real credentials until the isolation suite passes. Build the application and sandbox images
for your nodes (amd64 and arm64 are supported, [build instructions](images/README.md)).

```sh
# values.yaml: your image digests, database.external (Secret with the URI + egress selector), onecli, models
KUBE_CONTEXT=your-context hack/install.sh --namespace cela --values local/values.yaml
```

It creates the namespace with the restricted Pod Security labels and the missing `sandboxd-auth` and `api-auth` Secrets,
installs the chart and prints the runtime and network-policy state from `GET /admin/status`. Read the
[chart README](charts/cela/README.md) for the values, [credentials](docs/model-credentials.md) for OneCLI and
[network policy](docs/network-policy.md) for the isolation rules.

**Sandbox network.** With the egress proxy (`egressProxy.enabled`, the default) a sandbox reaches it and nothing else (no DNS, no direct
internet, no direct OneCLI gateway): every connection is judged by the egress rules and audited. That is the default
`proxied` network mode. A profile can opt into `networkMode: direct` (open internet and DNS, no rules, no audit; private,
cluster and platform addresses stay blocked) only when the operator sets `security.allowDirectSandboxEgress`, which the
console flags as "unfiltered, unaudited". The proxy needs a read-only database role and its Secret (`hack/install.sh`
explains, [network policy](docs/network-policy.md#egress-proxy-egressproxyenabled)). `egressProxy.enabled: false` opts out:
the sandbox policies are then as before the cutover (every sandbox has direct internet). See [network policy](docs/network-policy.md) and [ADR 0038](docs/decisions/0038-network-modes.md).

A **browser sandbox** (profile field `sandboxFlavour: browser`, chart `sandbox.flavours.browser.enabled`, on by default; set it to `false` to skip the image) runs the
sandbox image plus Chromium, Patchright and agent-browser, always through the egress proxy and without credentials.
`hack/install.sh` seeds the `browser` profile and its two skills on install when the flavour is on (create-only: an edited profile is never overwritten on upgrade; `--no-seed-browser-profile` opts out; the script is `hack/seed-browser-profile.mjs`); check a cluster with
`hack/browser-smoke.sh`. See [ADR 0041](docs/decisions/0041-browser-sandbox.md).

Test in a disposable namespace: `KUBE_CONTEXT=your-context STORAGE_CLASS=your-storage-class tests/e2e/run.sh smoke`. Omit
`STORAGE_CLASS` for the cluster default; set `ORCH_IMAGE`, `INGEST_IMAGE`, `DRIVER_IMAGE` and `SANDBOX_IMAGE` to your pushed
image digests. Every run installs the chart. See [e2e](docs/e2e.md) for OneCLI ingress rules, secret-store access,
prerequisites and the isolation suite (`phase3`). Never test against production.

## Development

Requires Node 22.19+, pnpm and Go (`pnpm check` also builds, vets and tests `packages/egress-proxy`; the toolchain is pinned in its `go.mod`).

```sh
pnpm install
pnpm check        # build, lint, format, typecheck, unit tests
tests/e2e/run.sh smoke   # needs a cluster with agent-sandbox, gVisor and a Postgres (`charts/pi-postgres`); deploys its own namespace pi-e2e-<id> and deletes it
```

## License

MIT, see [LICENSE](LICENSE). The vendored agent-sandbox SDK in `packages/vendor/agent-sandbox-client` keeps its Apache-2.0 license.
