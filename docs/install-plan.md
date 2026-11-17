# Installation plan: Helm on any cluster, kind in one command

Status: accepted plan, 2026-11-17 (issue #104, [ADR 0020](decisions/0020-helm-install.md)). Implemented: slice 1 (isolation honesty), slice 2 (images), slice 3 (names from config), slice 4 (`charts/pi-durable`, `hack/install.sh`, e2e installs the chart; issue #119), slice 5 (the lab stack reinstalled from the charts, 2026-11-17, issue #124; see [lab notes](lab-notes.md)), slice 6a (`charts/pi-postgres`), slice 6b (e2e on `charts/pi-postgres`, issue #125), slice 7 (`hack/agent-sandbox.sh`) and slice 9 (isolation probe; issue #126). The rest is planned. It folds in a review by two `gpt-6.1-sol` sessions that
ran on a lab cluster against `main` at `9f52ebc` (section 11) and a second review of the merged plan by Claude Fable 5.2 (section 12). Decisions that survive review go to `docs/decisions/` as ADRs in the
PRs that implement them.

## 1. Problem

An install today needs a cluster where someone has already set up six things by hand. After that, about ten scripts
must run in a fixed order:

| Prerequisite today | Who installs it | Problem for a new user |
|---|---|---|
| CloudNativePG operator | by hand, cluster-wide | heavy dependency for one small database |
| agent-sandbox controller + CRDs | by hand | not documented as a step |
| gVisor RuntimeClass `gvisor` | node setup | hard-coded in `deploy/sandbox-template.yaml` |
| Cilium (to enforce policy) | CNI setup | without it isolation silently does not exist |
| External Secrets Operator + `cluster-secret-store` | by hand | `deploy/*externalsecret*.yaml` fail without it |
| OneCLI (own namespace, own Postgres) | by hand or GitOps | not in this repo; agent token, admin key, CA and host rules are manual |

Before slice 2, secret/CA setup and code-upload scripts preceded `kubectl apply -k deploy`. Slice 2 replaces runtime code upload with multi-arch application images. Many names are fixed: namespace
`pi-durable-poc`, `pi-pg-rw`/`pi-pg-app`, `onecli.onecli:10255/10256`, `cnpg.io/cluster=pi-pg` selectors,
admin `alice`. The sandbox image was arm64-only before slice 2; `images/build.sh` now builds both architectures. (#101 already removed the
storage class from the base and made the OneCLI CA fetch configurable.)

## 2. Goal

1. On a cluster that has only a CNI and a default StorageClass, one command installs a working stack: session API,
   orchestrator, Postgres, OneCLI and agent-sandbox.
2. `hack/kind-up.sh` creates a kind cluster, installs through the same path and runs the smoke tests. It works on an
   arm64 Mac and in amd64 CI.
3. The e2e suites install through the chart, so CI tests exactly what users install.
4. Users who already run Postgres, OneCLI or agent-sandbox switch our copy off with one value each.
5. Missing isolation is never silent. The install and the session API report the runtime and the network-policy
   state, and both states are checked, not assumed.

## 3. Decisions proposed

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Packaging | Chart **`pi-durable`** holds the app only: orchestrator shards, ingest, sandbox template/pool, RBAC, policies. The other parts are **separate releases**: `charts/pi-postgres` (bundled Postgres), the upstream OneCLI chart, and the agent-sandbox release manifest. One install command (`hack/install.sh`, also used by the kind script) installs them in order. Every part has the same modes: `bundled \| external`, and OneCLI also `disabled` (scripted model only) | One command does not need one release. Uninstalling the app must never uninstall a credential gateway, a database or cluster-wide CRDs |
| D2 | Images | Digest-pinned multi-arch images for orchestrator, ingest, sandbox and the e2e driver. Runtime code upload, its PVC and its ConfigMap are removed in slice 2 | A chart cannot push code onto a PVC. Without the shared RWO code volume, shards also no longer need to share a node |
| D3 | Database | Drop CNPG from the package. Default: a bundled single Postgres StatefulSet (evaluation, no HA, no backup). Production: `database.external` (any Postgres, CNPG included) through a Secret with the URI. Direct or session-mode connections only, never transaction pooling | Our needs are small. The CNPG features we lose (failover, backups, certificates) were not configured in `deploy/postgres.yaml` anyway: one instance, no backups |
| D4 | OneCLI | Use the **upstream OneCLI chart** (`oci://ghcr.io/onecli/charts/onecli`, v2.20.0, Apache-2.0) as a separate release, `runner.enabled=false`, one replica, no Redis. Its own Postgres is off (`database.enabled=false`); `database.external.existingSecret` points at a Secret with `DATABASE_URL` for a separate **database and role `onecli`** on our Postgres instance, not a schema in ours. The chart also requires `externalUrl` (https, or `allowInsecureExternalUrl=true` for port-forward trials) and `secrets.existingSecret` or `secrets.generate.enabled`. Its Services are `<release>-gateway:10255` and `<release>-api:10256`. `onecli.mode: external` points at an existing gateway; `disabled` runs the scripted model only | Upstream already packages it. Its hosted-agent runner duplicates our orchestrator. Redis is needed only for multi-replica (licensed) setups. A separate database keeps its Prisma migrations apart from ours |
| D5 | agent-sandbox | `agentSandbox.mode: bundled \| external`. `bundled` applies the pinned v1.0.11 release manifest with extensions (`kubectl apply --server-side`; the version the vendored SDK targets). Upstream's `helm/` chart is not published. `external` checks first that `v1beta1` is served for Sandbox, SandboxClaim, SandboxTemplate and SandboxWarmPool. Never adopt, upgrade or delete an existing controller or its CRDs as a side effect | CRDs are cluster-wide. Deleting them deletes every Sandbox and, through claims, workspace PVCs |
| D6 | Runtime | `sandbox.runtimeClassName` defaults to `gvisor`. Anything else, including empty (the node default, usually runc), requires `security.allowInsecureRuntime=true`. The chart enforces it (`values.schema.json`/`fail`), and so does the orchestrator at start. Never fall back silently | Only the operator picks the runtime, never a session caller. A manifest edit must not bypass the guard |
| D7 | Network policy | Plain `NetworkPolicy` is always rendered. The Cilium extras (kube-apiserver entity, FQDN rules) apply with `networkPolicy.provider: cilium`. With `standard` the chart renders an orchestrator egress rule to the API server instead (`networkPolicy.kubeApiCidrs`, else TCP 443/6443 to any): `default-deny-all` would otherwise stop the orchestrator from creating SandboxClaims on any enforcing CNI, which is a block, not a warning. The orchestrator runs the **isolation probe** (section 6). If enforcement is not verified, the install, the orchestrator and the session API **warn**; nothing is blocked. The warning is loud and does not go away: NOTES.txt, `helm test` output, an orchestrator log at every start, `networkPolicy: not-enforced \| inconclusive` in `GET /admin/status` | Decided 2026-11-17: warn only. The reviewers preferred blocking sandbox tools until isolation is verified, because on flannel the lab cluster's isolation test reached Postgres and the orchestrator. Warn-only keeps installs simple; it is safe only because the state is measured and shown, never assumed |
| D8 | Secrets | The chart only takes `existingSecret` references. `install.sh` creates the missing Secrets on first install (sandboxd master, DB passwords, a first API token, as the `gen-*.sh` scripts do today) and never regenerates them. ESO is an optional example, not a requirement. The sandboxd master and OneCLI's encryption key are backup assets: losing them breaks existing sandboxes and stored credentials | Works without ESO. No `lookup` in the chart, so `helm template`, render tests and GitOps work |
| D9 | Local and CI | `hack/kind-up.sh` is a thin wrapper around `hack/install.sh` with `values-kind.yaml`. `tests/e2e/run.sh` installs the chart into `pi-e2e-<id>` instead of kustomizing `deploy/` | One install path to maintain |

## 4. Layout

```
charts/pi-durable/           # the app chart (D1)
  values.yaml, values.schema.json
  templates/{orchestrator,ingest,sandbox,networkpolicy}/, NOTES.txt
charts/pi-durable/values-kind.yaml  # a cluster's own values file lives in local/ (git-ignored)
charts/pi-postgres/          # bundled Postgres: StatefulSet, Service, init of both databases and roles
hack/install.sh              # namespace + PSA labels -> Secrets -> agent-sandbox -> pi-postgres -> onecli
                             # -> onecli bootstrap -> pi-durable -> read /admin/status
hack/kind-up.sh, hack/kind-down.sh, hack/kind-config.yaml
images/{orchestrator,ingest,sandbox,e2e-driver}/
```

`pi-postgres` is its own release so that it exists before OneCLI, which needs its `onecli` database. `install.sh`
creates the namespace with the restricted Pod Security labels (`deploy/namespace.yaml` today); `helm
--create-namespace` would set none. Bundled OneCLI runs in the same namespace; whether its Jobs pass `restricted` is
still to be checked.

Values sketch (proposed, not final):

```yaml
database:
  mode: bundled                 # bundled | external (any mode change is a reinstall)
  bundled: { image: postgres:17@sha256:..., persistence: { size: 10Gi, storageClass: "", retain: true } }
  external: { existingSecret: "", uriKey: uri }
  tls: { mode: disable, existingSecret: "", caKey: ca.crt }       # verify-full once the code exists (slice 11)
onecli:
  mode: bundled                 # bundled | external | disabled
  externalUrl: ""              # required by the OneCLI chart when bundled
  external: { apiUrl: "", gatewayUrl: "", caConfigMap: "", agentTokenSecret: "", adminKeySecret: "" }
agentSandbox: { mode: bundled } # bundled | external
sandbox: { runtimeClassName: gvisor, storageClass: "" }
security: { allowInsecureRuntime: false }
networkPolicy: { provider: cilium, kubeApiCidrs: [] } # cilium | standard; always rendered
orchestrator: { shards: 1 }     # one Deployment per shard, 1 replica, Recreate; never an HPA
api: { admins: [admin], existingSecret: "" }
models: { default: ..., allowlist: [...] }           # seeds Postgres settings (ADR 0008)
github: { app: { existingSecret: "" } }              # optional; repo sessions off without it
```

## 5. Code changes the chart needs (verified in the repo)

- **Names from config, not code (implemented in slice 3).** Orchestrator requires namespace, warm pool and both
  OneCLI URLs. Namespace comes from the downward API; `NO_PROXY` combines cluster suffixes, configured DB/API hosts
  and operator additions. Ingest requires `PI_ORCH_URL` (with `{shard}` for multiple shards) and checks stored session
  shards against `PI_ORCH_SHARDS` before readiness. The chart renders these values; no install-name defaults remain
  in code except the intentionally retained OneCLI prefix.
- **One install per database.** session-core hard-codes the schema `inbox` (`packages/session-core/src/migrate.ts`
  and the SQL). Two installs therefore cannot share a database. Document this, or parameterize the schema; documenting
  is the proposal.
- **OneCLI name prefix.** The default prefix is `pi-session-` (`onecli-names.ts`). On a shared OneCLI, one install's
  orphan sweep could revoke another install's agents. Make it a value that `install.sh` defaults from release and
  namespace; a reinstalled stack keeps `pi-session-` (section 9a).
- **DB TLS.** `session-core/src/db.ts` and `orchestrator/src/storage.ts` build separate `pg` pools with no CA/cert
  contract. Add TLS to both, with verification, before `database.external` is called production-ready.
- **Shards.** Shard count can only grow: sessions stay on their shard (ADR 0017). `deploy/add-shard.sh` becomes the
  `orchestrator.shards` value, and ingest refuses to start when it sees sessions on a shard it has no route for.
- **OneCLI bootstrap.** Installing OneCLI does not create a user, an org, an `oc_` admin key, the orchestrator agent,
  grants or host rules. A bootstrap step (Job or `install.sh` step) must do this through OneCLI's API only, and must
  be idempotent. OneCLI has no switch to turn off sign-up, the first account owns the install, and admin keys are per
  user (`docs/research/onecli-v2-recheck.md`). So the bootstrap must script the email sign-up (not tested yet) and run
  right after the OneCLI rollout: until then anyone who can reach its API can claim the install. Today the orchestrator holds an **account-level** admin key
  (`deploy/repo-externalsecrets.yaml`). That breaks the plan's least-privilege goal; the packaging should not hide this.
  Model credentials (Codex OAuth) remain an interactive dashboard step. An API-key path can read an `existingSecret`.
- **OneCLI CA.** OneCLI's chart creates its gateway CA in Secret `<release>-gateway-ca`, with key and certificate
  together. The bootstrap (which can read that Secret) copies only the public certificate to a ConfigMap for us (replaces `fetch-onecli-ca.sh`). The orchestrator reads the CA once at start, so a rotation needs a
  restart.
- **Multi-arch sandbox.** Implemented in slice 2: select the pi-env binary by `TARGETARCH`, with a verified checksum per architecture (see deploy/README.md).
- **Policies rewritten, not just templated.** Replace the CNPG selectors and the CNPG operator rules
  (`networkpolicy-{ingest,orchestrator,postgres}.yaml`, `cilium/kube-apiserver.yaml`). Match the OneCLI chart's labels
  (it has separate web/api/gateway Deployments). Add OneCLI-to-database egress. Sandboxes may reach gateway :10255
  only. `deploy/onecli-policies/*` move into the chart for bundled OneCLI. External mode needs the OneCLI namespace
  and pod selector as values (today `onecli` and `app: onecli`), and `database.external` needs a pod selector or CIDR
  for the orchestrator and ingest egress rule, or `default-deny-all` makes the database unreachable.
- **Template changes do not reach existing Sandboxes** (ADR 0019). Changing runtime or security settings on an
  upgrade needs a documented recycle path that keeps claims and PVCs.

## 6. Isolation: runtime and network policy

Runtime:
- Keep `in-cluster-service` connectivity for every runtime. Do not switch runc to port-forward, because that would test
  a different data path.
- ADR 0019 applies under runc too: non-root, drop all capabilities, RuntimeDefault seccomp, no SA token. It does not
  replace gVisor.
- Report the configured and the observed runtime separately: the orchestrator reads the resolved Pod's
  `runtimeClassName` at attach (its RBAC already has `pods get`).

Status data path: `/admin/*` is served by ingest, which has no Kubernetes access and does not know shard state. So each
orchestrator writes its runtime and probe result to a Postgres row per shard, and `GET /admin/status` in ingest reads
those rows. NOTES.txt, `install.sh`, `helm test` and the kind script only read `/admin/status`; none runs its own probe.

Network policy probe (run only by the orchestrator, at start and on demand through the admin API):
- From a real SandboxClaim of the installed template, expect **denied**: Postgres, orchestrator, ingest, another
  sandbox's sandboxd, the kube API, OneCLI API/dashboard, and node, private and metadata addresses. Use both Service
  and Pod IPs.
- Expect **allowed**: DNS, OneCLI gateway, and the orchestrator reaching sandboxd with its token.
- A timeout proves nothing alone. Every denied target needs a positive control from an allowed source first. The result
  is `enforced | not-enforced | inconclusive`, and `unknown` until the probe has run.
- Warn only: the probe never gates readiness or tools; its result is only reported. In e2e and CI, `NETPOL_ENFORCED=1`
  turns `not-enforced` into a test failure.
- Fix first: `NETPOL_ENFORCED` is documented but not forwarded by `tests/e2e/run.sh` / `job.yaml.tpl`, so isolation can
  stay KNOWN-FAIL and the suite still passes.
- Sandboxes have open public internet egress (decided 2026-11-15). OneCLI's host rules do not limit it. Gateway-only
  egress (#47) is a separate policy profile.
- kind: kindnet enforces plain NetworkPolicy since kind v0.24.0 (kube-network-policies; checked in the release notes).
  It has no FQDN rules and no kube-apiserver entity, so it runs `networkPolicy.provider: standard`.

## 7. kind all-in-one (`hack/kind-up.sh`)

1. Check docker, kind, helm and kubectl versions. Use its own cluster name and context, and refuse to reuse an
   unrelated cluster.
2. `kind create cluster` with a pinned node image and the default kindnet (`--cni cilium` optional, for the full
   policy set).
3. Build native-arch images and `kind load` them; the release path pulls digests instead.
4. `hack/install.sh --values values-kind.yaml`: runc with `allowInsecureRuntime`, kind's `standard` StorageClass,
   bundled Postgres and agent-sandbox, `onecli.mode: disabled` and the scripted model by default. `--onecli` adds
   bundled OneCLI with `allowInsecureExternalUrl` for a port-forward trial. No ESO and no credentials are needed.
5. Verify: read `/admin/status` and print the runtime and network-policy warnings; then smoke (create a session, run
   one tool call that writes a workspace marker, stream the result, replace the Pod, check the marker, delete the
   session, check claim and PVC cleanup). It fails on `not-enforced` only with `NETPOL_ENFORCED=1`, which CI sets.
6. Print how to port-forward, where the token Secret is (it does not print the token), and how to add a real model in
   OneCLI.

## 8. CI

- Every PR: `pnpm check`; `helm lint` and render tests for gvisor/insecure, bundled/external DB, bundled/external/
  disabled OneCLI and both policy providers; pod-security checks on the **rendered** chart
  (`packages/orchestrator/test/pod-security.test.ts` scans `deploy/` today); kind (amd64, kindnet, `standard` policy,
  runc, OneCLI disabled) running install, smoke, orchestrator restart and sandbox replacement.
- Nightly or release: kind with Cilium and bundled OneCLI; the full `all` suite and `shards`; external DB; arm64.
  Real-model, MCP and private-repo tests run only with protected credentials, never on untrusted PRs.
- e2e helpers: the suites call `kubectl exec pi-pg-1 -c postgres -- psql ... app` and wait for a CNPG `Cluster`
  (`run-phase3/4/4b/4c/mcp/shards.sh`). Add a database helper that does not depend on the backend.
- Deferred, not cut: a gVisor-on-kind lane (runsc in the node image) on a known-good Linux runner. Until then gVisor is
  covered by the e2e suites on a gVisor cluster. A runc lane is app coverage, not gVisor certification.

## 9. Slices (one issue and PR each)

Each slice follows AGENT.md: issue, branch, `pnpm check`, PR. "Done when" is the acceptance check of the PR.

1. **Isolation honesty and test plumbing.**
   - Forward `NETPOL_ENFORCED` through `tests/e2e/run.sh` and `job.yaml.tpl`. Add positive controls to `t_isolation`
     (each denied target is first shown reachable from an allowed source).
   - Orchestrator start guard: a `runtimeClassName` other than `gvisor` without `PI_ALLOW_INSECURE_RUNTIME=1` stops the
     process with a clear error.
   - A per-shard status row (configured and observed runtime, `networkPolicy: unknown`), and `GET /admin/status` in
     ingest that reads it.
   - A backend-neutral e2e DB helper replaces `kubectl exec pi-pg-1 ... psql` in every suite.
   - Done when: unit tests cover the guard and the status route; `run.sh phase3` with `NETPOL_ENFORCED=1` fails on a
     namespace without policies and passes with them; every suite uses the DB helper.
2. **Images (implemented; architecture builds and cluster smoke still require reviewer verification).**
   - Dockerfiles for orchestrator, ingest and the e2e driver; the sandbox build selects `pi-env` by `TARGETARCH` with a
     checksum per architecture. Multi-arch (amd64, arm64) images published with digests.
   - `deploy/` runs the images; runtime code-upload scripts, the code PVC and the bundle ConfigMap are removed.
   - Done when: both architectures build in CI; `run.sh smoke` passes from images only.
3. **Config cleanup (implemented; cluster smoke requires reviewer verification).**
   - Every name listed in section 5 comes from config: OneCLI API and gateway URLs, namespace and pod selector, warm
     pool, `NO_PROXY`, the external DB egress selector, the OneCLI name prefix, ingest's shard routes.
   - Ingest refuses to start when sessions exist on a shard it has no route for.
   - Done when: `grep` finds none of these names as code defaults outside tests; `pnpm check` and `run.sh smoke` pass.
4. **Chart with external everything, and `install.sh`.**
   - `charts/pi-durable` with external DB, external OneCLI and external agent-sandbox; `values.schema.json`; NOTES.txt
     with the runtime and policy warnings. `hack/install.sh` creates the namespace with PSA labels and the Secrets, then
     installs.
   - Both policy providers; `standard` includes the kube API egress rule.
   - Render tests: every mode combination renders; the restricted pod-security test runs on the rendered output; no
     object is a CRD, a CNPG resource or outside the release namespace.
   - `run.sh` installs the chart (it still creates its own CNPG `Cluster` as the external DB until slice 6).
   - Done when: `helm lint`, the render tests and `run.sh all` pass on the chart.
5. **Reinstall the existing lab stack** from the chart (section 9a; done 2026-11-17, with `charts/pi-postgres` as its database).
   - Done when: the lab stack runs from the chart, `run.sh smoke` and `phase4b` pass, and the CNPG operator is unchanged.
6. **`charts/pi-postgres`.**
   - StatefulSet, Service, Secret references, init of the `pi` and `onecli` databases and roles (idempotent, also on an
     existing PVC). Policies for it (CNPG selectors replaced). e2e switches to it.
   - Done when: `run.sh all` and `shards` pass with the bundled Postgres; a restart of the Postgres Pod keeps all data.
7. **agent-sandbox bundled mode.**
   - `install.sh` applies the pinned v1.0.11 manifest with extensions (server-side) when no CRDs exist, and refuses when
     they exist in `bundled` mode. `external` checks that `v1beta1` is served for the four kinds.
   - Done when: a fresh cluster gets a working controller; a cluster with the controller is left untouched.
8. **`hack/kind-up.sh` and the kind PR job.**
   - kind with kindnet, runc, `standard` policy, bundled Postgres and agent-sandbox, OneCLI disabled, scripted model.
   - Done when: `hack/kind-up.sh` passes on an arm64 Mac and in amd64 CI, including the smoke steps of section 7, in
     under 15 minutes in CI.
9. **Isolation probe.**
   - The orchestrator runs the probe at start and on `POST /admin/status/probe`, and writes `enforced | not-enforced |
     inconclusive` to its status row. NOTES.txt, `install.sh` and `kind-up.sh` print it.
   - Done when: the probe reports `enforced` on kind (kindnet) and on a Cilium cluster, and `not-enforced` with the
     policies removed; e2e fails on `not-enforced` only with `NETPOL_ENFORCED=1`.
   - Status: implemented (issue #126). The design choices that section 6 left open are in
     [network policy](network-policy.md#isolation-probe): a plain Pod with the sandbox labels instead of a SandboxClaim,
     the orchestrator itself as the positive control for denied targets, shard 0 as the only runner, and a request
     column that ingest sets. Not yet checked live: kind (kindnet), Cilium, and the policies-removed case. `kind-up.sh`
     (slice 8) does not exist yet and will only read `/admin/status`.
10. **Bundled OneCLI.**
    - Spike first: dashboard sign-in over port-forward with an http `externalUrl`; scripted email sign-up and admin key;
      Prisma migrations on a shared Postgres 17 without superuser; OneCLI Jobs under `restricted`.
      Done in [research/onecli-bundled-spike.md](research/onecli-bundled-spike.md) (#120), with a prototype `hack/onecli-bootstrap.sh`.
    - Upstream chart as its own release (runner off, one replica, no Redis, `onecli` database); bootstrap step right
      after rollout (account, admin key, orchestrator agent and token Secret, host rules); public CA to a ConfigMap.
    - Done when: kind with `--onecli` runs a session through the gateway (scripted model plus one real-model test with
      protected credentials), and a second bootstrap run changes nothing.
11. **DB TLS and cleanup.**
    - TLS with verification for both `pg` pools; `database.tls` values. Remove the `deploy/` scripts and manifests that
      the chart replaced; update README, `deploy/README.md`, `docs/e2e.md`, `docs/model-credentials.md` and plan.md.
    - Done when: e2e passes against an external Postgres that requires TLS; no doc points at a removed script.

Deferred (not needed for the PoC): gVisor-on-kind lane, an Ingress/HTTPRoute template, a backup CronJob. The shard
check (`shards` may only grow) is done by ingest at start, not by the chart, so the chart needs no `lookup`.

### 9a. Reinstalling an existing `deploy/` stack (decided 2026-11-17: reinstall, not migrate)

An install made from `deploy/` (kustomize and scripts) is not upgraded to the chart. Its namespace is deleted and
recreated from the chart. Its sessions, workspaces and database are discarded: no data migration, no CNPG-to-StatefulSet
move, no Helm adoption of kustomize objects.

1. **Ask first.** The delete cannot be undone (AGENT.md). Optional `pg_dump` of `inbox.*` if settings, profiles,
   skills or the MCP catalog are worth keeping.
2. **Never touch the CNPG operator, its CRDs or its namespace.** The operator is cluster-wide and may serve other
   database clusters. Only this stack's own `Cluster` (`pi-pg`) goes away, with the namespace. No step of the chart,
   `install.sh`, `kind-up.sh` or the e2e suites installs, upgrades or removes the CNPG operator. A render test (slice 4)
   enforces that no chart object is a CNPG resource or lives outside the release namespace.
3. Run `tests/e2e/sweep.sh` so no `pi-e2e-*` namespace with the old layout survives.
4. Delete the namespace while the agent-sandbox controller runs, so Sandbox finalizers complete. If the workspace
   storage class retains volumes, remove the Released PVs by hand.
5. Leave the agent-sandbox controller and CRDs as they are (`agentSandbox.mode: external`; they also serve the e2e
   namespaces).
6. OneCLI: if it stays external, keep the namespace name and the pod labels `pi-orchestrator` and `pi-sandbox` that its
   ingress policy selects, and keep the prefix `pi-session-` so the new orphan sweep removes the old agents and secrets.
7. Apply the ExternalSecrets (`pi-onecli`, `pi-onecli-admin`, `pi-github-app`) from a local overlay before the app
   release; they feed the chart's `existingSecret` values.
8. New `sandboxd-auth` and `api-auth`: every client token changes. Set `api.admins` explicitly and the storage classes
   for sandboxes and Postgres in the cluster's own values file under `local/`.
9. Install, read `/admin/status`, run `tests/e2e/run.sh smoke`.

## 10. Open questions for you

- The lab stack's OneCLI after the reinstall: keep the existing instance as external (keeps the Codex login; plan
  default), or move to the bundled one (the old OneCLI app, its database and policies become leftovers, and the Codex
  login is entered again)?
- Production DB: say "external only" (CNPG or managed) and keep the bundled StatefulSet for evaluation? Recommended.
- Bundled Postgres backups: document `pg_dump` only for now? Recommended.
- Still to check: whether OneCLI's Prisma migrations need extensions or superuser on a shared Postgres 17, and whether
  its Jobs pass the `restricted` Pod Security level.

## 11. Review by two Sol sessions

Two sessions ran on our own stack in a lab cluster (`pi-durable-poc`, `openai-codex/gpt-6.1-sol`, reasoning high). Each cloned the
public repo into its gVisor sandbox and was told not to push. Session A reviewed packaging and dependencies; session
B reviewed runtime, isolation, kind and tests. I checked their main claims in the code and in OneCLI v2.20.0 before
using them above.

Where they changed the plan:
- Do not make one Helm release own the cluster (D1, D5). Use separate releases behind one command.
- Use OneCLI's own chart with the runner off and no Redis (D4). Verified: `charts/onecli/values.yaml` at v2.20.0 has
  `database.external`, `runner`, and needs Redis only for more than one replica.
- "Warn but don't fail" is too weak for untrusted code (D7). Not adopted: the decision is warn only, but the
  probe from their review decides what the warning says.
- Concrete blockers that the first draft missed: the hard-coded `inbox` schema, the arm64-only sandbox build, the unforwarded
  `NETPOL_ENFORCED`, the shared OneCLI prefix and the account-level admin key in the orchestrator, CNPG-specific e2e
  helpers, and template changes that do not reach existing Sandboxes.

Their ranked top risks, merged:
1. False isolation claims: unenforced policies, wrong selectors, or runc used without anyone noticing.
2. Loss of persistent identity or data: regenerated master or encryption keys, deleted PVCs, or the assumption that
   `helm rollback` reverses migrations.
3. OneCLI bootstrap and privilege: a running gateway is not a configured one.
4. Ownership of shared cluster resources (CRDs, controllers).
5. Broken ownership semantics: transaction poolers, a wrong `search_path`, fewer shards.
6. Blast radius of the shared Postgres.
7. Portability that nobody tested: arm64-only images, storage class, ingress controller and Cilium assumptions.

The full answers: [research/install-review-sol-a.md](research/install-review-sol-a.md) and
[research/install-review-sol-b.md](research/install-review-sol-b.md).

## 12. Review of the merged plan by Claude Fable 5.2

A read-only review of this plan (medium effort), with its claims checked against the repo and upstream before use.
What it changed:
- `networkPolicy.provider: standard` needs an orchestrator egress rule to the API server, or the orchestrator cannot
  create SandboxClaims under `default-deny-all` (D7). kindnet does enforce NetworkPolicy since kind v0.24.0, which
  settles the open point; PR CI runs kindnet with `standard`, and Cilium runs nightly.
- Bundled Postgres becomes its own release, because OneCLI needs its database before the app installs (D1, section 4).
- The OneCLI chart's real requirements: `externalUrl`, generated or existing secrets, `DATABASE_URL`, OCI-only chart,
  `<release>-gateway`/`-api` Services, and the CA Secret that holds the key. Plus open sign-up until the bootstrap
  runs (D4, section 5).
- `/admin/status` needs a data path: orchestrators write a row per shard, and ingest reads it. Only the orchestrator
  runs the probe (section 6).
- agent-sandbox's chart is not published: apply the release manifest instead (D5). The chart takes only
  `existingSecret`, and `install.sh` creates the Secrets (D8, no `lookup`).
- Reordered slices: the kind PR job comes before bundled OneCLI, the e2e DB helper moves into slice 1, and the existing
  stack is reinstalled (section 9a).
- Cut or deferred for the PoC: the gVisor-on-kind lane, Ingress/HTTPRoute, the backup CronJob, and a chart-side shard
  check.
