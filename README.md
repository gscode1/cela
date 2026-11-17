# pi-durable-k8s

Run [Pi Durable](https://github.com/earendil-works/pi) coding agents on your own Kubernetes cluster.

Each session gets an agent that keeps its state in PostgreSQL and resumes after a crash, plus a private gVisor
sandbox with a persistent workspace where its tools run. Model and GitHub credentials never reach the agent or the
sandbox: [OneCLI](https://github.com/onecli/onecli) injects them at its gateway.

**Status: proof of concept.** It runs end to end on a small arm64 lab cluster. It is not hardened for production;
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
   It is created on the first tool call and keeps its workspace on a PVC. The orchestrator reaches it through an
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
- No credentials in sandboxes or in the agent: OneCLI holds them and only relays to allowlisted hosts
  ([host rules](docs/onecli-host-rules.md)).

## Repository layout

| Path                                    | What                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/ingest`                       | Session API: auth, owner checks, inbox writes, SSE proxy                                                                   |
| `packages/orchestrator`                 | Pi Durable harness, sandbox lifecycle, model and OneCLI wiring                                                             |
| `packages/sandbox-env`                  | Bridge from Pi's `RemoteExecutionEnv` to an agent-sandbox pod (the only SDK user)                                          |
| `packages/session-core`                 | Shared schema, migrations, settings, profiles, skills, MCP catalog and auth helpers                                        |
| `packages/egress-proxy`                 | Go module: Smokescreen chained to OneCLI, a spike not yet deployed ([ADR 0012](docs/decisions/0012-egress-proxy-spike.md)) |
| `packages/vendor/agent-sandbox-client`  | Vendored, pinned agent-sandbox TypeScript SDK (Apache-2.0)                                                                 |
| `vendor/`                               | Packed `@netzlabor/pi-durable-postgres` adapter, ported to Pi Durable 1.5.2                                                |
| `images/sandbox`, `images/egress-proxy` | Sandbox image (sandboxd + `pi-env` + git); egress proxy image (not built yet)                                              |
| `deploy/`                               | Kubernetes manifests (namespace, Postgres, orchestrator, ingest, sandbox template, network policies)                       |
| `tests/e2e`                             | End-to-end suites that run as in-cluster Jobs                                                                              |
| `examples/`                             | Recorded load-test and bug-hunt runs                                                                                       |
| `docs/`                                 | API, credentials, networking, scaling, metrics, decisions (`docs/decisions/`) and research notes                           |

## Docs

- [Session API](docs/session-api.md)
- [Model credentials through OneCLI](docs/model-credentials.md)
- [Repository workspaces](docs/repo-workspace.md)
- [Scaling: one orchestrator per schema shard](docs/scaling.md)
- [Timing and memory metrics](docs/metrics.md)
- [End-to-end suites, one namespace per run](docs/e2e.md)
- [Pod Security: the restricted level](docs/decisions/0019-restricted-pod-security.md)
- [Network policy](docs/network-policy.md) and [OneCLI host rules](docs/onecli-host-rules.md)
- [Architecture decision records](docs/decisions/)
- [Plan, decisions and phase results](plan.md)

## Development

Requires Node 22.19+, pnpm and Go (`pnpm check` also builds, vets and tests `packages/egress-proxy`; the toolchain is pinned in its `go.mod`).

```sh
pnpm install
pnpm check        # build, lint, format, typecheck, unit tests
tests/e2e/run.sh smoke   # needs a cluster with agent-sandbox, gVisor, CNPG; deploys its own namespace pi-e2e-<id> and deletes it
```

## License

MIT, see [LICENSE](LICENSE). The vendored agent-sandbox SDK in `packages/vendor/agent-sandbox-client` keeps its Apache-2.0 license.
