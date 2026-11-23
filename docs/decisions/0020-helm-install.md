# 0020: Install with Helm releases behind one command

Amended by [0064](0064-sandbox-runtimes.md) (2026-11-23): `sandbox.runtimeClassName` with `security.allowInsecureRuntime` stays the default runtime; `sandbox.runtimes` adds named runtimes, each with its own acknowledgement.

Status: accepted as the direction, 2026-11-17 (issue #104). Built slice by slice: the app chart and `hack/install.sh` exist (slice 4, `charts/pi-durable`), and `deploy/` was removed in slice 11b (issue #141), so this is the only supported install path; the rest is planned. The plan, slices and acceptance checks are in
[install-plan.md](../install-plan.md). Builds on [0019](0019-restricted-pod-security.md) (restricted Pod Security) and
[0013](0013-e2e-namespace-per-run.md) (a namespace per e2e run).

## Context

An install needs CloudNativePG, agent-sandbox, gVisor, a policy-enforcing CNI, External Secrets and OneCLI set up by
hand, then about ten scripts in a fixed order. There are no application images: code is copied onto a PVC or into a
ConfigMap. Nobody can try the project on a fresh cluster or on kind without reading most of `deploy/`.

## Decision

- **Packaging.** The app chart `charts/pi-durable` holds orchestrator shards, ingest, sandbox template and pool, RBAC and
  policies. Postgres (`charts/pi-postgres`), OneCLI (the upstream chart) and agent-sandbox (its pinned release manifest)
  are separate releases. `hack/install.sh` installs them in order. Each part is `bundled | external`, and OneCLI can be
  `disabled` (scripted model only). Uninstalling the app never removes a database, a credential gateway or CRDs.
- **Images.** Multi-arch, digest-pinned images for orchestrator, ingest, sandbox and the e2e driver replace the code
  push.
- **Database.** No CloudNativePG in the package. The bundled Postgres is a single StatefulSet for evaluation;
  production uses `database.external` (any Postgres, CNPG included). Direct or session-mode connections only. One
  install per database, because the `inbox` schema is fixed.
- **OneCLI** is bundled through its upstream chart (runner off, one replica, no Redis) with its own database and role on
  our Postgres instance. A bootstrap step creates the account, admin key, orchestrator agent, host rules and CA
  ConfigMap right after rollout.
- **Runtime.** `gvisor` by default. Any other RuntimeClass, including the node default (runc), needs an explicit
  `allowInsecureRuntime`, which both the chart and the orchestrator check. Configured and observed runtime are
  reported.
- **Network policy: warn only.** Policies are always rendered (`cilium` or `standard` provider). The orchestrator
  runs an isolation probe and reports `enforced | not-enforced | inconclusive | unknown` through `GET /admin/status`,
  NOTES.txt and every start log. Nothing is blocked. CI sets `NETPOL_ENFORCED=1`, so tests fail without enforcement.
- **Cluster-wide operators are never touched.** No chart, script or suite installs, upgrades or removes the CNPG
  operator, its CRDs or anything outside the release namespace. agent-sandbox CRDs are installed only when absent and
  never upgraded or deleted as a side effect.
- **Secrets.** The chart takes only `existingSecret` references; `install.sh` creates missing ones once and never
  regenerates them. External Secrets is optional.
- **Local and CI.** `hack/kind-up.sh` wraps `install.sh` (kindnet, runc, `standard` policies, OneCLI disabled). The e2e
  suites install the chart.
- **Existing `deploy/` installs are reinstalled, not migrated.** Their data is discarded.

## Decisions made in slice 4 (the app chart)

- **Fixed object names, one release per namespace.** `pi-orchestrator`, `pi-ingest`, `pi-env-template`, `pi-env-pool`,
  `sandboxd-auth` and `api-auth` are not prefixed with the release name. The policies, ingest's shard routing and the e2e
  suites select on them, and one install per database already limits an install to one per namespace.
- **Shards are a value.** `orchestrator.shards: N` renders N Deployments (`pi-orchestrator` for shard 0, then
  `pi-orchestrator-<k>`), a Service per shard and ingest's `PI_ORCH_SHARDS` and `PI_ORCH_URL` together. The count only
  grows. `deploy/add-shard.sh` is not used by the chart or the e2e suites.
- **The runtime guard is in two places.** `values.schema.json` and a `fail` in the templates both refuse any runtime but
  `gvisor` (empty included) without `security.allowInsecureRuntime`, which also sets `PI_ALLOW_INSECURE_RUNTIME=1`.
- **Policy providers.** `standard` adds an orchestrator egress rule to the API server (`kubeApiCidrs`, else TCP 443/6443 to
  any) and no FQDN rule; `cilium` adds the kube-apiserver entity, the DNS policy and, with a GitHub App, the FQDN rule. The
  sandbox policies are identical for both providers: gateway port only, never the OneCLI management API port.
- **Test-only pieces stay out of the chart.** The e2e driver's policies, the run's CNPG cluster and its ExternalSecrets live in
  `tests/e2e/deploy`; the chart takes only values for them (`networkPolicy.ingest.clients`, `orchestrator.extraEnv`).
- **`hack/install.sh` reads the status from inside an ingest pod**, so the admin token never leaves the cluster and no
  port-forward is needed.

## Consequences

- `deploy/` and its scripts are removed (done in slice 11b, issue #141); the scripts still in use are in `hack/`.
- The lab cluster's stack is deleted and recreated; client tokens change.
- Warn-only means a cluster without enforcement runs agent code with no network isolation. This is accepted for the
  PoC, because the state is measured and shown everywhere, not assumed.
- Reviewers (two Sol sessions, Fable) preferred blocking tools until isolation is verified. The decision was warn only.
