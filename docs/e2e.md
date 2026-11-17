# End-to-end suites: one namespace per run

`tests/e2e/run.sh <suite>` deploys a complete stack into a fresh namespace `pi-e2e-<run id>`, runs the suite there and
deletes the namespace again (issue #69, [decision 0013](decisions/0013-e2e-namespace-per-run.md)). The long-lived
namespace `pi-durable-poc` is never touched: the script refuses any namespace that does not start with `pi-e2e-`, and the
`run-*.sh` scripts have no default namespace. Two runs, for example from two branches, can run at the same time.

```sh
tests/e2e/run.sh smoke                    # ~5 minutes of tests plus deployment and teardown time
KEEP_NS=1 tests/e2e/run.sh phase4         # keep the namespace for debugging
KEEP_NS_ON_FAIL=1 tests/e2e/run.sh all    # keep it only when something failed
RUN_ID=ab12cd tests/e2e/run.sh phase4b    # reuse (and redeploy into) the kept namespace pi-e2e-ab12cd
tests/e2e/sweep.sh 6                      # delete e2e namespaces older than 6 hours (DRY_RUN=1 lists them)
```

Suites: `smoke`, `phase1`, `phase3`, `phase4`, `phase4b`, `phase4c`, `mcp`, `shards`, `all` (phase1, phase3, phase4, phase4b).
`phase4c`, `mcp` and `shards` are not part of `all`; `phase4c` needs `REPO_A` and `REPO_B`, `mcp` needs the internet and the OneCLI host rule
for `mcp.deepwiki.com`.

| Variable            | Meaning                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `STORAGE_CLASS` | storage class for database and workspace PVCs (unset: cluster default) |
| `SANDBOX_STORAGE_CLASS` | storage class for the sandbox workspace PVCs only; wins over `STORAGE_CLASS` for them |
| `ORCH_IMAGE` | orchestrator image (default `pi-orchestrator:<version>-<sha>`) |
| `INGEST_IMAGE` | ingest image (default `pi-ingest:<version>-<sha>`) |
| `DRIVER_IMAGE` | e2e driver and Phase 1 runner image (default `pi-e2e-driver:<version>-<sha>`) |
| `SANDBOX_IMAGE` | sandbox image (default `pi-sandbox:<version>-<sha>`) |
| `KUBE_CONTEXT`      | kubectl context (default: the current one)                                                                |
| `KEEP_NS=1`         | never delete the namespace at the end                                                                     |
| `KEEP_NS_ON_FAIL=1` | keep it if the exit code is not 0. Exit code 2 (the operator machine lost the Job) always keeps it, the Job is still in it |
| `RUN_ID`            | the id in `pi-e2e-<id>` (default: 6 random hex digits); an existing e2e namespace is reused               |
| `SKIP_SWEEP=1`      | do not run the sweeper at the start                                                                       |
| `SWEEP_MAX_AGE_HOURS` | age limit of the sweeper (default 6)                                                                    |
| `NS_DELETE_WAIT_SECONDS` | how long the end of a run waits for the namespace to be gone (default 300)                           |
| `E2E_PARALLEL`      | independent tests of a suite that run side by side (default 4; 1 = one by one). Tests that restart or kill the orchestrator run alone afterwards (`tests/e2e/fns.sh`) |
| `ONLY`              | `ONLY="a,b"` runs just those tests of the phase                                                           |
| `REAL_MODEL=1`      | phase4b also makes two real Codex turns through OneCLI (spend)                                            |
| `REPO_A`, `REPO_B`  | private `owner/name` repos in the GitHub App installation, for phase4c (otherwise most of its tests SKIP) |

Requires the [cluster prerequisites and settings](../README.md#deploy-on-your-cluster), Node 22.19+, Git,
`kubectl`, Python 3, curl, jq and OpenSSL on the operator machine. The supplied policies require Cilium CRDs;
with another enforcing CNI, supply equivalent API and DNS/FQDN policies. Local `local/` overlays are not used
by the runner: adapt `deploy/` or `tests/e2e/deploy/` for network identities, secret stores and OneCLI endpoints.

Build and push all four images before running the suites ([build instructions](../deploy/README.md#build-images)).
The defaults match `images/build.sh` at the current root package version and git short SHA; they are local names,
not published images. On a remote cluster set all four variables to reachable registry references, preferably digests:

```sh
ORCH_IMAGE=registry.example.com/team/pi-orchestrator@sha256:… \
INGEST_IMAGE=registry.example.com/team/pi-ingest@sha256:… \
DRIVER_IMAGE=registry.example.com/team/pi-e2e-driver@sha256:… \
SANDBOX_IMAGE=registry.example.com/team/pi-sandbox@sha256:… tests/e2e/run.sh smoke
```

The operator machine does not build or ship code during a run. Node is used only to compute default image tags.

## What a run does

1. **Sweep.** `tests/e2e/sweep.sh` deletes e2e namespaces older than 6 h (killed runs, forgotten `KEEP_NS=1`). It selects
   by name prefix `pi-e2e-`, by the label `pi-durable-e2e=true` and by age, so `pi-durable-poc` cannot match.
2. **Namespace.** Creates `pi-e2e-<id>` with the label `pi-durable-e2e=true` (the OneCLI ingress policy and the sweeper
   select on it) and the annotations `pi-durable-e2e/branch` and `/suite`. The label exists before the first Pod does,
   because Cilium takes a Pod's identity from its namespace labels when the Pod starts. The same `apply` (also on a reused
   namespace) sets the Pod Security labels: `enforce`, `warn` and `audit` = `restricted`, version `v1.36`, as in
   `deploy/namespace.yaml` ([decision 0019](decisions/0019-restricted-pod-security.md)). Every Pod the run creates,
   including the Phase 1 runner and the driver Job, must meet that profile.
3. **Stack.** A generated overlay (`kustomization.yaml` in a temp dir with `namespace: pi-e2e-<id>`) over
   `tests/e2e/deploy`, which is `deploy/` (without its `Namespace` object) plus `tests/e2e/driver` (driver
   ServiceAccount and Roles), the test switches of the orchestrator and lower resource requests. That gives:
   the CNPG cluster `pi-pg` (own database, same mechanism and manifest as production), orchestrator (starts at 0
   replicas), ingest, the SandboxTemplate and warm pool, RBAC, every NetworkPolicy and, from `deploy/cilium`, every
   CiliumNetworkPolicy. Cilium policies are applied first (`docs/network-policy.md`).
4. **Secrets** (next section), then the **OneCLI CA** (`deploy/fetch-onecli-ca.sh`, public data fetched from OneCLI).
5. **Start images.** Scale every orchestrator shard from 0 to 1 after credentials exist, then wait for orchestrator
   and ingest rollouts. The `shards` suite first runs `deploy/add-shard.sh 1`, which clones shard 0's image and adds
   routing for shard 1 without shared-volume node affinity ([scaling](scaling.md)).
6. **Driver.** Create one Job per suite phase using `DRIVER_IMAGE`. Scripts, clients and Phase 1 dependencies are
   baked in: there is no local build, code upload, loader Pod or driver PVC. Phase 1 starts a runner using the same
   image, copying its packaged test bundle into a writable emptyDir so tests can model process restarts.
   The Job gets `NAMESPACE` from its own metadata.
7. **Verdict** from the Job status, unchanged from before (live log stream for watching only).
8. **Delete.** `kubectl delete namespace`, then wait until it is gone. That removes the Job, the stack, the CNPG cluster,
   the PVCs, sandboxes and secrets with it. Use a StorageClass with reclaim policy `Delete` for disposable tests;
   a `Retain` policy leaves backing volumes for manual cleanup.

## Where each secret comes from

| Secret / ConfigMap in the run namespace   | Source                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pi-pg-app` (database URI)                | generated by CloudNativePG for the run's own `pi-pg` cluster                                    |
| `sandboxd-auth` (`master`)                | `deploy/gen-secret.sh`, random per run, created in the namespace. Not copied from production     |
| `api-auth` (`tokens`: alice, bob)         | `deploy/gen-api-secret.sh`, random per run. Not copied from production                          |
| `pi-onecli` (OneCLI agent token)          | ExternalSecret `pi-onecli`, store `ClusterSecretStore/cluster-secret-store` (example store; configure your own) |
| `pi-onecli-admin` (OneCLI management key) | ExternalSecret `pi-onecli-admin`, same store                                                    |
| `pi-github-app` (App key, ids)            | ExternalSecret `pi-github-app`, same store                                                      |
| ConfigMap `onecli-ca` (public CA)         | `deploy/fetch-onecli-ca.sh`, from `onecli:10256/v1/gateway/ca`                                  |

The three ExternalSecrets are in `deploy/` and are applied with the stack. Configure your **ClusterSecretStore** to admit the labelled e2e namespaces (do not open it to every namespace
unnecessarily), or adapt the ExternalSecrets to your own store. No secret value needs to pass through the operator machine. The orchestrator reads them as optional and only once at start, so `run.sh` waits for the
ExternalSecrets to be Ready (120 s) before it starts the orchestrator. If one is not Ready the run warns and goes on; suites that need it
SKIP (phase4b real model) or fail (phase4c, mcp). The two Secrets made by the scripts are written from a private temp file,
never through argv or stdout.

The OneCLI agent token and management key are the same ones production uses, so e2e runs share one OneCLI identity with
production. They also share one OneCLI **workspace**, and every orchestrator's orphan sweep revokes the OneCLI agents it does
not know (`docs/decisions/0002-orphan-sweep.md`). So each stack names its agents and secrets with its own prefix
(`PI_ONECLI_NAME_PREFIX`): `pi-session-` for the long-lived stack (the default, unchanged), `pi-e2e-<run id>-` for a run, so a
run's agent is `pi-e2e-<run id>-<session uuid>` and its secrets end in `-git` and `-api`. The sweep matches names anchored at the
start, so it judges only its own prefix: `pi-session-` does not match `pi-e2e-ab12cd-<uuid>`, nor the reverse. `run.sh` sets the
variable in the run's overlay (next to the namespace) and in the Job (`PI_ONECLI_NAME_PREFIX`); `run-phase4c.sh` finds the
session's agent and secrets by it, for "the OneCLI agent is gone" and "its secrets are gone" too. No other suite looks up OneCLI
objects. Every suite deletes what it created.

Leak: OneCLI objects live outside the namespace, so deleting a namespace does not delete them. Agents of a run that was killed,
kept (`KEEP_NS`) or swept by `tests/e2e/sweep.sh` stay in OneCLI under `pi-e2e-<run id>-`, and no later stack can sweep them,
because their prefix is not its own. They are a few small objects each. Remove them by hand from the OneCLI admin API (agents
whose identifier starts with `pi-e2e-` and the secrets with the same prefix). `sweep.sh` does not do it: it runs on the operator machine, which
holds no OneCLI management key (only the orchestrator pods do).

## What is cluster-scoped or lives outside the namespace

| Piece                                         | Where it lives                       | Handling                                                                                         |
| --------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Namespace, labels                             | cluster                              | created and deleted by `run.sh`; label `pi-durable-e2e=true`                                     |
| RBAC (driver, runner, orchestrator)           | Roles and RoleBindings in the namespace | nothing is cluster-wide; created with the stack                                               |
| NetworkPolicy, CiliumNetworkPolicy            | in the namespace                     | created with the stack. They name other namespaces (`kube-system`, `postgres-system`, `envoy-gateway-system`, `onecli`) by name; unchanged |
| CNPG operator (`postgres-system`)             | shared                               | watches all namespaces (no `WATCH_NAMESPACE`); its ingress to the run's Postgres is in `networkpolicy-postgres.yaml` |
| agent-sandbox controller, `gvisor` RuntimeClass | shared                             | cluster-wide, unchanged                                                                          |
| ESO `ClusterSecretStore/cluster-secret-store` | cluster                              | configure access for test namespaces                                                           |
| OneCLI ingress policy `onecli/onecli-ingress` | `onecli` namespace | admit labelled test namespaces as below |
| OneCLI host rules (`deploy/onecli-host-rules.sh`) | OneCLI, global                   | unchanged, global to all agents                                                                  |

## OneCLI ingress for test namespaces

The ingress policy of your OneCLI namespace must admit orchestrators from namespaces labelled
`pi-durable-e2e=true` to :10255 and :10256, and sandboxes to :10255 only.
Without these rules, suites that call the gateway or API from a run namespace fail.
The example `deploy/onecli-policies/ingress.yaml` includes these entries; apply them however you manage OneCLI:

```yaml
    # e2e run namespaces (tests/e2e/run.sh, docs/e2e.md): any namespace labelled pi-durable-e2e=true
    - fromEndpoints:
        - matchLabels:
            k8s:io.cilium.k8s.namespace.labels.pi-durable-e2e: "true"
            app.kubernetes.io/name: pi-orchestrator
      toPorts:
        - ports:
            - { port: "10255", protocol: TCP }
            - { port: "10256", protocol: TCP }
    - fromEndpoints:
        - matchLabels:
            k8s:io.cilium.k8s.namespace.labels.pi-durable-e2e: "true"
            app.kubernetes.io/name: pi-sandbox
      toPorts:
        - ports:
            - { port: "10255", protocol: TCP }
```

Cilium matches namespace labels with the prefix `io.cilium.k8s.namespace.labels.`. That form was not separately checked here. To check
it: run `KEEP_NS=1 tests/e2e/run.sh phase4b` and look at `hubble observe --to-pod onecli/<pod>
--from-namespace pi-e2e-<id>`, or run `curl http://onecli.onecli:10256/v1/gateway/ca` from the orchestrator pod. If the label form does not
select, the equivalent standard NetworkPolicy in the `onecli` namespace works (policies add up) and is
unambiguous:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: onecli-allow-e2e-namespaces, namespace: onecli }
spec:
  podSelector: { matchLabels: { app: onecli } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector: { matchLabels: { pi-durable-e2e: "true" } }
          podSelector: { matchLabels: { app.kubernetes.io/name: pi-orchestrator } }
      ports: [{ protocol: TCP, port: 10255 }, { protocol: TCP, port: 10256 }]
    - from:
        - namespaceSelector: { matchLabels: { pi-durable-e2e: "true" } }
          podSelector: { matchLabels: { app.kubernetes.io/name: pi-sandbox } }
      ports: [{ protocol: TCP, port: 10255 }]
```

Whoever can create a namespace with that label can reach the OneCLI gateway and API as an orchestrator would.
Creating namespaces is a cluster-admin action, the same trust as creating `pi-durable-poc`.

## Cost of a run

Requests (what the scheduler reserves), per run: Postgres 50m / 192Mi, orchestrator 50m / 192Mi, two ingest pods 50m / 128Mi each, the
driver Job 50m / 64Mi and one 100m / 128Mi sandbox per claim, so about 0.3 CPU and 0.7 Gi plus the sandboxes. Limits are
the production ones. Storage: one 1 Gi database persistent volume plus one per sandbox.

## Scripts that take the namespace

Every deploy script reads `NAMESPACE` (default `pi-durable-poc`, the long-lived deployment) and `KUBE_CONTEXT`:
`add-shard.sh`, `gen-secret.sh`, `gen-api-secret.sh`, `fetch-onecli-ca.sh`. The manifests carry no namespace
except `deploy/kustomization.yaml` and `deploy/cilium/kustomization.yaml`, which set the long-lived one and are overridden by
the run's overlay; the orchestrator gets `PI_ORCH_NAMESPACE` from the downward API and `PI_ONECLI_NAME_PREFIX` (`pi-e2e-<run id>-`) from the overlay. The `run-*.sh` suites require
`NAMESPACE` (the Job sets it). `packages/orchestrator/test/e2e-namespace.test.ts` fails if a new hard-coded `pi-durable-poc`
appears outside comments and those defaults.

## Verifying a change to this by hand

`kustomize build` of a generated overlay shows exactly what a run applies (every object has the run namespace, there is
no `Namespace` object and no `pi-durable-poc`):

```sh
d=$(mktemp -d) && printf 'namespace: pi-e2e-test\nresources:\n  - %s\n' "$(python3 -c 'import os,sys;print(os.path.relpath(os.path.realpath(sys.argv[1]),os.path.realpath(sys.argv[2])))' tests/e2e/deploy "$d")" >"$d/kustomization.yaml" && kustomize build "$d" | grep -c pi-durable-poc
```
