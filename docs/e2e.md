# End-to-end suites: one namespace per run

`tests/e2e/run.sh <suite>` deploys a complete stack into a fresh namespace `pi-e2e-<run id>` (the run's own database, then
the [`pi-durable` Helm chart](../charts/pi-durable/README.md), installed the way a user installs it), runs the suite there and
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

Suites: `smoke`, `phase1`, `phase3`, `phase4`, `phase4b`, `phase4c`, `mcp`, `shards`, `browser`, `console`, `all` (phase1, phase3, phase4, phase4b).
`phase4c`, `mcp`, `shards`, `browser` and `console` are not part of `all`; `phase4c` needs `REPO_A` and `REPO_B`, `mcp` needs the internet and the OneCLI host rule
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
| `DB_TLS=1`          | the run's Postgres requires TLS and pi-durable verifies it ([Database TLS](#database-tls)); unset or `0`: plain, as before |
| `EGRESS_PROXY_IMAGE` | egress proxy image (default `pi-egress-proxy:<version>-<sha>`), for the suites that run the proxy: `phase3`, `phase4c`, `browser` and `all` |
| `EGRESS_PROXY=0`    | `phase3`, `phase4c` (and `all`) without the egress proxy: the explicit opt-out, which tests the old direct sandbox egress ([Isolation](#isolation-enforcement-and-database-client), [phase4c](#repository-workspace-phase4c)). `browser` refuses it |
| `BROWSER_SANDBOX_IMAGE` | the `browser` suite only: a pushed reference of `pi-sandbox-browser` (required; there is no local default) |
| `SKIP_LIVE=1`       | the `browser` suite leaves out its live-model test |
| `REAL_MODEL=1`      | phase4b also makes two real Codex turns through OneCLI (spend)                                            |
| `REPO_A`, `REPO_B`  | private `owner/name` repos in the GitHub App installation, for phase4c (otherwise most of its tests SKIP) |

Requires the [cluster prerequisites and settings](../README.md#deploy-on-your-cluster), Node 22.19+, Git,
`kubectl`, `helm`, Python 3, curl, jq and OpenSSL on the operator machine. A run needs the agent-sandbox controller. It does not need the CloudNativePG operator: the run's database is the
`charts/pi-postgres` release. The test-only policies require Cilium CRDs and
the run installs the chart with `networkPolicy.provider: cilium`. Your own `local/` values are not used by the runner: adapt
`tests/e2e/chart-values.py` (the chart values of a run) or `tests/e2e/deploy/` (database, secrets, test-only policies) for
network identities, secret stores and OneCLI endpoints. `HELM_TIMEOUT` (default `10m`) bounds the chart's rollout wait.

Build and push all four images before running the suites ([build instructions](../images/README.md)), and `pi-egress-proxy`
for `phase3`, `phase4c`, `browser` and `all` (`EGRESS_PROXY_IMAGE`).
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
   by name prefix `pi-e2e-`, by the label `pi-durable-e2e=true` and by age, so `pi-durable-poc` cannot match. `run.sh` sets
   `SWEEP_EXCLUDE=<its own namespace>`, so re-running a kept namespace (`RUN_ID=<id>`) after more than 6 h reuses it instead
   of the sweep deleting it. `sweep.sh` alone honours the same variable.
2. **Namespace.** Creates `pi-e2e-<id>` with the label `pi-durable-e2e=true` (the OneCLI ingress policy and the sweeper
   select on it) and the annotations `pi-durable-e2e/branch` and `/suite`. The label exists before the first Pod does,
   because Cilium takes a Pod's identity from its namespace labels when the Pod starts. The same `apply` (also on a reused
   namespace) sets the Pod Security labels: `enforce`, `warn` and `audit` = `restricted`, version `v1.36`, as in
   `hack/install.sh` ([decision 0019](decisions/0019-restricted-pod-security.md)). Every Pod the run creates,
   including the Phase 1 runner and the driver Job, must meet that profile.
3. **Stack.** A generated overlay (`kustomization.yaml` in a temp dir with `namespace: pi-e2e-<id>`) over
   `tests/e2e/deploy` applies what surrounds the chart: the three ExternalSecrets, the policies of the test-only pods (the e2e driver; the
   CiliumNetworkPolicies in `tests/e2e/deploy/cilium` first, see `docs/network-policy.md`) and `tests/e2e/driver` (driver
   ServiceAccount and Roles).
4. **Secrets** (next section), then the **OneCLI CA** (`hack/fetch-onecli-ca.sh`, public data fetched from OneCLI; e2e runs use the external OneCLI, not the bundled one of [ADR 0022](decisions/0022-bundled-onecli.md), which `hack/kind-smoke.sh --onecli` covers), then
   the **database**: random passwords in `pi-postgres-auth` (made here, never printed; a reused namespace keeps its
   secret), `helm upgrade --install pi-postgres charts/pi-postgres` (1 Gi, `STORAGE_CLASS`, PVC not retained,
   `networkPolicy.clientSelectors` = orchestrator, ingest and the `e2e-db-client` pod), wait for `pi-postgres-0`, and the
   URI Secret `pi-db-uri` for the `pi` database (`postgres://pi:…@pi-postgres.<ns>.svc:5432/pi`). One Postgres per run.
5. **Chart.** `helm upgrade --install pi-durable charts/pi-durable` into the namespace with values generated by
   `tests/e2e/chart-values.py`: the four image variables split into repository, tag and digest, the storage classes,
   `database.external` (`pi-db-uri`, the `pi-postgres` pods as egress selector), external OneCLI with this run's name prefix,
   `networkPolicy.provider: cilium`, admin `alice`, the model allowlist and the test switches of the orchestrator
   (`PI_ORCH_CONTROL`, `PI_ORCH_TEST_FAULTS`, short sweep and suspend times) as `orchestrator.extraEnv`, and lower resource
   requests. Everything the orchestrator reads once at start exists before it starts, so there is no scale-to-zero step.
   Helm waits for the rollout. The `shards` suite installs with `orchestrator.shards=2` (a second Deployment
   `pi-orchestrator-1`, the Services and ingest's `PI_ORCH_SHARDS`/`PI_ORCH_URL` come from the chart). A kept namespace that already has shard 1 keeps two shards on a re-run, because the count can only grow
   ([scaling](scaling.md)).
6. **Driver.** Create one Job per suite phase using `DRIVER_IMAGE`. Scripts, clients and Phase 1 dependencies are
   baked in: there is no local build, code upload, loader Pod or driver PVC. Phase 1 starts a runner using the same
   image, copying its packaged test bundle into a writable emptyDir so tests can model process restarts.
   The Job gets `NAMESPACE` from its own metadata.
7. **Verdict** from the Job status, unchanged from before (live log stream for watching only).
8. **Delete.** `kubectl delete namespace`, then wait until it is gone. That removes the Job, the stack, the Postgres release,
   the PVCs, sandboxes and secrets with it. Use a StorageClass with reclaim policy `Delete` for disposable tests;
   a `Retain` policy leaves backing volumes for manual cleanup.

## Where each secret comes from

| Secret / ConfigMap in the run namespace   | Source                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pi-postgres-auth` (passwords)            | `tests/e2e/run.sh`, random per run, for `charts/pi-postgres` (`openssl rand`), never printed |
| `pi-db-uri` (database URI)                | `tests/e2e/run.sh`, built from `pi-postgres-auth`; the chart's `database.external.existingSecret` |
| `sandboxd-auth` (`master`)                | `hack/gen-secret.sh`, random per run, created in the namespace before the chart. Not copied from production |
| `api-auth` (`tokens`: alice, bob)         | `hack/gen-api-secret.sh`, random per run. Not copied from production                          |
| `pi-onecli` (OneCLI agent token)          | ExternalSecret `pi-onecli`, store `ClusterSecretStore/cluster-secret-store` (example store; configure your own) |
| `pi-onecli-admin` (OneCLI management key) | ExternalSecret `pi-onecli-admin`, same store                                                    |
| `pi-github-app` (App key, ids)            | ExternalSecret `pi-github-app`, same store                                                      |
| ConfigMap `onecli-ca` (public CA)         | `hack/fetch-onecli-ca.sh`, from `onecli:10256/v1/gateway/ca`                                  |

The three ExternalSecrets are in `tests/e2e/deploy/external-secrets.yaml` and are applied with the stack. Configure your **ClusterSecretStore** to admit the labelled e2e namespaces (do not open it to every namespace
unnecessarily), or adapt the ExternalSecrets to your own store. No secret value needs to pass through the operator machine. The orchestrator reads them as optional and only once at start, so `run.sh` waits for the
ExternalSecrets to be Ready (120 s) before it installs the chart (which starts the orchestrator). If one is not Ready the run warns and goes on; suites that need it
SKIP (phase4b real model) or fail (phase4c, mcp). The two Secrets made by the scripts are written from a private temp file,
never through argv or stdout.

The OneCLI agent token and management key are the same ones production uses, so e2e runs share one OneCLI identity with
production. They also share one OneCLI **workspace**, and every orchestrator's orphan sweep revokes the OneCLI agents it does
not know (`docs/decisions/0002-orphan-sweep.md`). So each stack names its agents and secrets with its own prefix
(`PI_ONECLI_NAME_PREFIX`): `pi-session-` for the long-lived stack (the default, unchanged), `pi-e2e-<run id>-` for a run, so a
run's agent is `pi-e2e-<run id>-<session uuid>` and its secrets end in `-git` and `-api`. The sweep matches names anchored at the
start, so it judges only its own prefix: `pi-session-` does not match `pi-e2e-ab12cd-<uuid>`, nor the reverse. `run.sh` sets the
value `onecli.namePrefix` of the chart (through `chart-values.py`) and the variable in the Job (`PI_ONECLI_NAME_PREFIX`); `run-phase4c.sh` finds the
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
| RBAC (driver, runner, orchestrator)           | Roles and RoleBindings in the namespace | nothing is cluster-wide; the orchestrator's comes from the chart, the driver's from the stack |
| NetworkPolicy, CiliumNetworkPolicy            | in the namespace                     | created by the chart and the stack. They name other namespaces (`kube-system`, `postgres-system`, `envoy-gateway-system`, `onecli`) by name; unchanged |
| CNPG operator (`postgres-system`)             | shared                               | not used by a run; the lab stack's Postgres still runs on it, untouched                          |
| agent-sandbox controller, `gvisor` RuntimeClass | shared                             | cluster-wide, unchanged                                                                          |
| ESO `ClusterSecretStore/cluster-secret-store` | cluster                              | configure access for test namespaces                                                           |
| OneCLI ingress policy `onecli/onecli-ingress` | `onecli` namespace | admit labelled test namespaces as below |
| OneCLI host rules (`hack/onecli-host-rules.sh`) | OneCLI, global                   | unchanged, global to all agents                                                                  |

## OneCLI ingress for test namespaces

The ingress policy of your OneCLI namespace must admit orchestrators from namespaces labelled
`pi-durable-e2e=true` to :10255 and :10256, and sandboxes and the egress proxy (the `route=onecli` upstream of `phase4c`,
ADR 0037) to :10255 only.
Without these rules, suites that call the gateway or API from a run namespace fail.
The example `hack/onecli-policies/ingress.yaml` (the OneCLI side, not part of the chart) includes these entries; apply them however you manage OneCLI:

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
    - fromEndpoints:
        - matchLabels:
            k8s:io.cilium.k8s.namespace.labels.pi-durable-e2e: "true"
            app.kubernetes.io/name: pi-egress-proxy
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
    - from:
        - namespaceSelector: { matchLabels: { pi-durable-e2e: "true" } }
          podSelector: { matchLabels: { app.kubernetes.io/name: pi-egress-proxy } }
      ports: [{ protocol: TCP, port: 10255 }]
```

Whoever can create a namespace with that label can reach the OneCLI gateway and API as an orchestrator would.
Creating namespaces is a cluster-admin action, the same trust as creating `pi-durable-poc`.

## Cost of a run

Requests (what the scheduler reserves), per run: Postgres 50m / 192Mi, orchestrator 50m / 192Mi, two ingest pods 50m / 128Mi each, the
driver Job 50m / 64Mi and one 100m / 128Mi sandbox per claim, so about 0.3 CPU and 0.7 Gi plus the sandboxes. Limits are
the production ones. Storage: one 1 Gi database persistent volume plus one per sandbox.

## Scripts that take the namespace

Every script that takes a namespace reads `NAMESPACE` (default `pi-durable-poc`, the long-lived deployment) and `KUBE_CONTEXT`:
`hack/gen-secret.sh`, `hack/gen-api-secret.sh`, `hack/fetch-onecli-ca.sh`. The
chart's manifests carry no namespace (Helm applies the release namespace); the orchestrator gets `PI_ORCH_NAMESPACE` from the
downward API and `PI_ONECLI_NAME_PREFIX` (`pi-e2e-<run id>-`) from the chart values. The `run-*.sh` suites require
`NAMESPACE` (the Job sets it). `packages/orchestrator/test/e2e-namespace.test.ts` fails if a new hard-coded `pi-durable-poc`
appears outside comments and those defaults.

## Verifying a change to this by hand

`helm template` with the values of a run shows exactly what a run installs (every object is namespaced, no `Namespace`
object, no CRD, no CNPG resource, no `pi-durable-poc`); the tests render the same values for one and two shards
(`packages/orchestrator/test/e2e-chart-values.test.ts`):

```sh
ORCH_IMAGE=o:1 INGEST_IMAGE=i:1 SANDBOX_IMAGE=s:1 tests/e2e/chart-values.py pi-e2e-test- 2 >/tmp/values.json
helm template pi-durable charts/pi-durable -n pi-e2e-test -f /tmp/values.json | grep -c pi-durable-poc
```

### Isolation enforcement and database client

`NETPOL_ENFORCED=1 tests/e2e/run.sh phase3` forwards the setting into the driver Job and makes missing enforcement a
FAIL rather than KNOWN-FAIL. Unset preserves automatic detection; `0` explicitly requests KNOWN-FAIL when controls
succeed. Positive-control failures always fail. The isolation test checks ingest as well as Postgres, orchestrator,
another sandbox's sandboxd (REST and gRPC), Kubernetes API and OneCLI API. Every denied address must first accept a
TCP connection from an allowed source. In-namespace targets use both a Service and a ready endpoint Pod IP;
external OneCLI and the Kubernetes API use their Service (the driver has no cross-namespace endpoint permissions).

`phase3` runs with the egress proxy, the chart's default (ADR 0038 and its amendment; issue #280): `run.sh` makes the
proxy's Secrets as for `browser` (below) and `run-phase3.sh` reads the mode from the orchestrator (`PI_EGRESS_PROXY_URL`).
A proxied sandbox has no DNS, so the driver resolves each Service name and the sandbox probes its address.
The OneCLI gateway (:10255) is a denied target too, with the orchestrator as its positive control; direct public internet
(`1.1.1.1:443`) must be blocked and the sandbox must not resolve names; the allowed control is a TCP connection to the
egress proxy's Service on :3128. The test `egress-proxy` creates a session through ingest (a `/control` session is not in
the inbox and gets no proxy token) on a throwaway profile whose only rule set is `github-public`, and from its sandbox sends
`CONNECT` with the session's token: `github.com:443` must answer `200`, `example.com:443` (no rule) and the Kubernetes API's
name must be denied (`4xx`); the Pod must carry `pi-durable.dev/network-mode=proxied`. The OneCLI web port (10254) is not a
target: no in-cluster client may reach it, so it has no positive control.

`EGRESS_PROXY=0 tests/e2e/run.sh phase3` is the opt-out: the chart is installed with `egressProxy.enabled: false` and the
isolation test asserts the sandbox egress of before the cutover (public internet and the OneCLI gateway reachable, the
gateway as the control); `egress-proxy` is SKIP. `all` installs the chart once, so with `phase3` in it phases 1, 4 and 4b
run with the proxy as well. `smoke`, `phase1`, `phase4`, `phase4b`, `mcp`, `shards` and `console` run without it:
they test durability, credentials and the console, not the sandbox network.

### Repository workspace (phase4c)

`phase4c` runs with the egress proxy by default (issue #284): a repo session's sandbox reaches `github.com` only through
the proxy, which chains its tunnels to the OneCLI gateway with the session's sealed binding (`route=onecli`, ADR 0037). Next
to the clone, push and scope checks, `clone-push` then asserts that the sandbox's `HTTPS_PROXY` is the proxy Service's
address and that its environment holds no OneCLI gateway address or agent token, that `POST /admin/egress/explain` answers
`route: onecli` with a binding for `github.com` and `api.github.com`, and that the proxy logged the session's `github.com:443`
tunnels (Smokescreen's `CANONICAL-PROXY-DECISION`, `role` = session id) as allowed with route onecli and none otherwise.
`scope` first proves that the GitHub App installation covers `REPO_B`: in the orchestrator pod (which holds the App key) it
mints a token scoped to `REPO_B` with only `metadata: read`, checks that GitHub names exactly that repository and revokes
it, printing neither the token nor the installation id. Then A's session reads `REPO_B` with `git ls-remote` (refused) and
`REPO_A` (allowed); `REPO_B` is never pushed to. `delete` also asserts that the binding and the session's rules are gone.
The proxy needs the OneCLI gateway: an external OneCLI must admit `app.kubernetes.io/name=pi-egress-proxy` from the e2e
namespaces on :10255 ([below](#onecli-ingress-for-test-namespaces)). `EGRESS_PROXY=0 tests/e2e/run.sh phase4c` is the
opt-out: the sandbox uses the OneCLI gateway directly with the agent token, as before, and the proxy checks are left out.

All SQL suites use `e2e_db` / `e2e_db_start` in `tests/e2e/fns.sh`, not a database-server Pod name or a database operator's readiness.
The helper creates a restricted, tokenless `e2e-psql` client Pod in the throwaway namespace, waits for `select 1`,
and execs psql using a Secret URI. It uses `E2E_DB_SECRET` / `E2E_DB_URI_KEY` (defaults `pi-db-uri` / `uri`); no URI
is printed. The Pod lives until namespace cleanup and supports concurrent client sessions and lock-holder queries.
The local phase4b adapter still uses `LOCAL_DB_URL`. Test-only client policies allow DNS and database TCP egress,
plus ingress from the `pi-postgres` release, which run.sh opens for that client label with `networkPolicy.clientSelectors`; a different
backend must admit it too. The runtime guard reads the real template; an insecure test stack (not what `run.sh` installs: its cluster has gVisor) sets
`sandbox.runtimeClassName` and `security.allowInsecureRuntime`, which the chart turns into `PI_ALLOW_INSECURE_RUNTIME=1`.

### Database TLS

`DB_TLS=1 tests/e2e/run.sh smoke` runs a suite against a Postgres that requires TLS (install slice 11a,
[ADR 0021](decisions/0021-database-tls.md); issue #132). Without it nothing changes. With it, `run.sh`, before it installs the
database:

1. makes a throwaway CA and a server certificate with `openssl` in its private temp dir (EC P-256, 7 days). The SANs are
   `pi-postgres`, `pi-postgres.<ns>`, `pi-postgres.<ns>.svc` and `pi-postgres.<ns>.svc.cluster.local`, so the URI host
   `pi-postgres.<ns>.svc` matches;
2. creates the Secret `pi-postgres-tls` (`kubernetes.io/tls`: `tls.crt`, `tls.key`; the server's) and `pi-db-tls-ca` (`ca.crt` only; the
   clients'). Then it deletes the temp dir with the CA key. No key is printed or put in an argument. A reused namespace keeps both
   Secrets, so a retained database and its certificate stay a pair;
3. installs `charts/pi-postgres` with `tls.existingSecret=pi-postgres-tls` and `tls.requireTls=true` (`pg_hba`: `hostssl` only);
4. checks, from a short-lived Pod `e2e-tls-probe` (label `e2e-db-client`, so the network policy admits it), that a
   connection to `pi-postgres.<ns>.svc` with `sslmode=disable` is rejected with the server's own `pg_hba.conf ... no encryption`
   error (a refused connection would not count) and that `sslmode=verify-full` with the CA works (positive control). Either one
   failing stops the run;
5. gives pi-durable `database.tls` with `verify-full`, `existingSecret: pi-db-tls-ca`, `caKey: ca.crt` (`tests/e2e/chart-values.py`).

The e2e psql client (`e2e_db_start` in `tests/e2e/fns.sh`) mounts `pi-db-tls-ca` (optional) and, when it is there, sets `PGSSLMODE=verify-full` and
`PGSSLROOTCERT`, so the SQL helpers keep working. The orchestrator and ingest are the real clients of the TLS path:
a suite that passes proves both pools connect and verify. Phase 4's `postgres-restart` (in `smoke`) covers a reconnect over TLS.

### Install-name configuration

The chart renders the warm-pool and OneCLI URLs and ingest's `PI_ORCH_URL` / `PI_ORCH_SHARDS` from values.
Orchestrator namespace always comes from its Pod's `metadata.namespace`, including every shard;
short Service URLs and the generated database Secret resolve inside that run's namespace, never the lab namespace.
`run.sh` sets the OneCLI prefix to `pi-e2e-<run id>-` (`onecli.namePrefix`). The driver explicitly sets its OneCLI API URL and
gets `PI_ORCH_NAMESPACE` from its own metadata for sandbox probes. Adapt external OneCLI endpoints in both
`tests/e2e/chart-values.py` and the driver template. Ingest stays unready until stored session shards have configured routes,
and exits listing missing shards instead of silently sending them to shard 0.

## The browser suite (sandbox)

`tests/e2e/run.sh browser` runs the browser sandbox of [ADR 0041](decisions/0041-browser-sandbox.md) on the cluster's real runtime
(gVisor) with a live model (issue #267). It is not part of `all` and it spends model turns. The run installs the chart with
`egressProxy.enabled` (like `phase3`; the suites that do not test the network set `egressProxy.enabled: false`, the chart's
opt-out) and `sandbox.flavours.browser.enabled` (`tests/e2e/chart-values.py`, switched by `EGRESS_PROXY=1` and `BROWSER_SUITE=1`), adds
`openai-codex/gpt-6-luna` to the model allowlist and makes the proxy's Secrets in the namespace: `pi-egress-database` (the URI of
the read-only role `pi_egress`, which the run's Postgres creates with `auth.egressReader`) and `pi-egress-binding`. It does not
turn on `onecli.hostRules.reconcile`, so no global OneCLI rule changes. `BROWSER_SANDBOX_IMAGE` is required and
`EGRESS_PROXY_IMAGE` must be a pushed reference, next to the four usual image variables (the browser image is about 1.6 GB: the first sandbox waits for the pull).

`tests/e2e/run-browser.sh` (in the driver Job) checks: the seed script (`hack/seed-browser-profile.mjs`, baked into the driver
image with the skills), a Pod with `runtimeClassName: gvisor` and the browser image, Chromium starting under gVisor, Playwright
CLI and agent-browser each returning a title and a PNG, the denials (kube API by name and IP, a platform Service, the metadata
address, `file://`, `chrome://`, a host outside a narrow profile's rules), and two live turns (about eight model calls) on
`openai-codex/gpt-6-luna` through OneCLI, one per tool, asserting the tool calls, "Example Domain" in the answer and the PNG
files in the sandbox. The OneCLI credential never enters the sandbox (the suite also checks the sandbox's variable names).

## The console suite (browser)

`tests/e2e/run.sh console` tests the [admin console](admin-ui-plan.md) in a real browser (Playwright, Chromium). It
installs the chart with `console.enabled=true` and runs the specs of `packages/admin-ui/e2e/` against
`http://127.0.0.1:<port>/console/`: sign-in, direct navigation, assets under the CSP, sign-out, reload asking for the token
again, `401` ("invalid token") against `403` ("valid owner without admin access"), HTML-like API data rendered as text, and
the security headers. It then runs `helm upgrade` with `console.enabled=false` and checks that `/console/` is `404`.

Unlike the other suites it does not run as a Job in the cluster: a browser needs a display stack the driver image lacks,
and what it tests is what an operator sees through a `kubectl port-forward svc/pi-ingest`, the supported way in. The
operator machine therefore needs `pnpm install` and `pnpm --filter @pi-durable-k8s/admin-ui exec playwright install chromium`.
The run still creates and deletes its own namespace `pi-e2e-<id>`. `alice` (the run's only `api.admins` owner) is the admin
and `bob` the owner without admin access; their tokens come from the run's `api-auth` Secret into the environment of the
Playwright process and are never printed or written to a file. The plan's second admin is not used: the run has one.

The specs take `CONSOLE_BASE_URL`, `CONSOLE_ADMIN_TOKEN`, `CONSOLE_NONADMIN_TOKEN` and `CONSOLE_EXPECT=enabled|disabled`
(`pnpm --filter @pi-durable-k8s/admin-ui e2e`), so they also run against any other deployment you can reach. Playwright is
not part of `pnpm check`, which needs no browser.

Without a cluster, the same specs run against the real ingest server code over session-core's in-memory fake database
(`packages/admin-ui/e2e/local-server.mjs`), one instance with the console and one without. The local run also has the
`settings` and `profiles` specs (edits, review, `409` conflicts, broken references, skill pins), which change global state
and so run on one worker; the deployed `console` suite keeps to the read-only specs. Two more instances run the console
with a small in-memory fake of the skills, MCP servers, status and profile reads in front (`e2e/fake-admin.mjs`, which reuses
session-core's validators, digest and zip writer), one in `console.catalogs: manage` and one in `readOnly` mode. The catalog
specs (`catalogs.spec.ts`, `catalogs-readonly.spec.ts`: skill upload from a folder and a zip, review, diff, identical
re-upload, MCP register, edit, conflict, disable, delete with references, shard status, read-only mode) need that fake and
run on those two only. The fake keeps its own profile list, separate from the profiles of the fake database:

```sh
pnpm build
pnpm --filter @pi-durable-k8s/admin-ui exec playwright install chromium   # once
pnpm --filter @pi-durable-k8s/admin-ui e2e:local
```

## Without a cluster: kind

`hack/kind-up.sh` creates a local kind cluster with the same chart (runc, kindnet, bundled Postgres, scripted model) and
`hack/kind-smoke.sh` runs a short session, tool call, Pod replacement and deletion against it, with the egress proxy on (the
chart's default) and a check that the sandbox has no direct internet; the `kind` workflow runs both
on every pull request. It is a smoke test of the install path, not these suites: it has no gVisor and does not run
`phase3`. See [Quick start on kind](../README.md#quick-start-on-kind).
