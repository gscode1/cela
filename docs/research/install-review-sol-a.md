# Install plan review, Sol session A: packaging and dependencies

Answer of a `gpt-6.1-sol` session running on this stack in a lab cluster, 2026-11-17, reviewing the ideas in `docs/install-plan.md` against `main` at `9f52ebc`. Kept as written except that lab-specific names are generalized (`<lab-storage-class>`). Some findings were fixed on `main` by #101 afterwards (no storage class in the base, configurable OneCLI CA fetch). Claims used in the plan were checked there.

## Recommendation


**Package the application, but do not make its Helm release own the cluster.** Offer a convenient bundled installation for evaluation and independently managed dependencies for production.

My verdict on ideas 1–4:

| Idea | Verdict |
|---|---|
| One chart deploys everything “on any cluster” | **Narrow the promise.** Deploy the application on supported clusters; provide a separate bootstrap workflow for prerequisites. |
| Replace bundled CNPG with a Postgres StatefulSet | **Yes for evaluation.** Production should use an externally operated database, which can still be CNPG. |
| Bundle OneCLI and share Postgres | **Yes, optionally.** Share the **instance**, not the database or application role. |
| Bundle agent-sandbox | **Installable by the same workflow, but a separate cluster-owned release.** Never silently take over an existing controller or CRDs. |

I reviewed `main` at `9f52ebce186ff0b38d295b468876b48dea7b6ffc`, including the requested files and every file under `deploy/`. I also checked OneCLI’s **v2.20.0 source**, matching the version documented here. I made no deployment changes.

## 1. Chart structure and dependency ownership

Use two application charts:

- **`pi-durable`**: orchestrator shards, ingest, Services, namespace-scoped RBAC, sandbox templates/pool, configuration and policies. Assumes database, OneCLI and agent-sandbox are available.
- **`pi-durable-stack`**: evaluation umbrella containing `pi-durable`, optional Postgres and optional OneCLI, with pinned dependency versions.

For production, recommend **separate releases** for database infrastructure, OneCLI and pi-durable. This gives independent upgrades and prevents an application uninstall from becoming a credential-gateway or database uninstall.

The all-in-one installer can manage those releases in order. **One command does not require one Helm release.**

### agent-sandbox is a platform dependency

Its CRDs are cluster-scoped; controller Deployments may be namespaced, but their RBAC and reconciliation scope are cluster-level concerns.

Provide explicit modes:

- `existing`: check compatible CRDs and controller functionality; install nothing.
- `install`: install a pinned controller/CRD distribution as a **separate release**, after checking for existing ownership.
- No automatic adoption, replacement or controller upgrade during a pi-durable upgrade.

Install both the core and extension functionality required here:

- `Sandbox`
- `SandboxClaim`
- `SandboxTemplate`
- `SandboxWarmPool`

The current SDK is vendored from **agent-sandbox v1.0.11**, commit `890de53…` (`packages/vendor/agent-sandbox-client/VENDORED.md`). Publish a tested controller/SDK/sandboxd compatibility matrix rather than accepting arbitrary controller versions.

Do not rely on an umbrella dependency to establish CRD readiness before rendering custom resources. Helm’s `crds/` mechanism also does not provide ordinary CRD upgrade/rollback management. Establish CRDs, wait for `Established`, start controllers, then install application resources. Never delete shared CRDs on application uninstall: that can delete other users’ custom resources.

### Optional components

Make these independently configurable:

- Bundled versus external Postgres.
- Bundled versus existing OneCLI; disabled only for explicitly scripted/offline operation.
- Existing versus installer-managed agent-sandbox.
- ESO resource generation.
- Cilium-specific policies versus a documented portable policy profile.
- Ingress/HTTPRoute integration.
- RuntimeClass, storage classes, resources, scheduling and image pull secrets.

Do **not** install or replace a CNI from the ordinary application chart. Likewise, do not install ESO or create a broadly accessible `ClusterSecretStore` by default.

A subchart normally shares its parent’s release namespace. If OneCLI must remain in a separate namespace, use a separate release rather than pretending Helm dependencies provide independent namespace ownership.

## 2. Database contract: make it explicit

A proposed application-facing values shape:

```yaml
database:
  mode: bundled                  # bundled | external

  bundled:
    image:
      repository: postgres
      digest: sha256:...
    persistence:
      size: 10Gi
      storageClass: null         # omit to use cluster default
      retain: true

  external:
    existingSecret: pi-database
    uriKey: uri                  # feeds PI_DURABLE_DATABASE_URL

  tls:
    mode: verify-full            # disabled only in an explicit trial profile
    existingSecret: pi-database-tls
    caKey: ca.crt
    clientCertKey: null
    clientKeyKey: null

  schemas:
    durableBase: durable
    createAtStartup: true

orchestrator:
  shardCount: 1
  replicasPerShard: 1

onecli:
  mode: bundled                  # bundled | existing | disabled
  database:
    existingSecret: onecli-database
    uriKey: DATABASE_URL
```

This is a **proposed interface**, not existing chart configuration. Validate mutually exclusive modes and required references with `values.schema.json`.

### Important invariants

1. **One application database per pi-durable installation.**  
   Durable state uses `durable`, `durable_s1`, etc., but shared application state is hard-coded into **`inbox`** throughout session-core. Changing `PI_DURABLE_SCHEMA` does not isolate two complete installations sharing one database. Either require separate databases or deliberately parameterize all inbox SQL.

2. **One active owner per durable schema.**  
   Render one Deployment per shard, one replica, `Recreate`. Do not expose an ordinary orchestrator replica count or HPA that suggests active/active operation.

3. **Direct writer connections or verified session pooling only. No transaction poolers.**  
   The adapter pins a PostgreSQL connection and holds a session advisory lock on it. The application also uses `LISTEN`. Transaction pooling breaks these semantics; it is not merely a performance issue.

4. **Stable, explicit search paths.**  
   The lock key includes `current_schema()`. Every shard must resolve its intended schema consistently. Test connection-string options and pool configuration together so a supplied URI cannot unexpectedly override the intended search path.

5. **Database permissions are part of installation.**  
   Today startup creates schemas and runs migrations. The role therefore needs database/schema creation and DDL privileges appropriate to that behavior—not just table DML. A production variant can pre-create schemas and use a dedicated migration role, but that requires a supported code path.

6. **Shard count cannot casually decrease.**  
   Sessions remain assigned to their original shard. A Helm upgrade that reduces `shardCount` would remove workers serving existing sessions. Reject this in the upgrade workflow unless an explicit retirement procedure has completed.

### TLS needs implementation, not just values

`packages/session-core/src/db.ts` and `packages/orchestrator/src/storage.ts` construct separate `pg` pools. Neither currently exposes an explicit shared CA/client-certificate configuration contract.

Add and test TLS handling in **both**, including schema-probe/create connections. Verify certificates and hostnames; do not translate “TLS enabled” into `rejectUnauthorized: false`. Document node-postgres URI/config precedence.

Also expose database connection budgets: each shard has an inbox pool of up to **10**, plus its pinned adapter connection; each ingest replica has a pool of up to **5**. Sharing an instance with OneCLI increases the need for connection and resource limits.

## 3. OneCLI: share the instance, not the database

For a local/evaluation stack, one Postgres instance is sensible:

```text
Postgres instance
├── database pi_durable   — role pi_durable
│   ├── inbox
│   ├── durable
│   └── durable_s1 ...
└── database onecli      — role onecli
    └── OneCLI/Prisma tables and migration history
```

**Do not use only separate schemas in one database.** Separate databases give clearer ownership, migration history, permissions, dumps and restore boundaries. OneCLI has its own Prisma migration system; pi-durable has both inbox migrations and adapter migrations. Neither should operate inside the other application’s database.

Remove unnecessary cross-database access, avoid application superusers, and provision databases/roles using a bootstrap identity that serving pods do not retain.

### What OneCLI actually requires

OneCLI v2.20.0 already has an upstream chart: [`charts/onecli`](https://github.com/onecli/onecli/tree/v2.20.0/charts/onecli). Prefer integrating a pinned published artifact over reproducing its deployment.

For this project, use its:

- API, web and credential gateway.
- Matching migration image/job.
- Postgres database.
- Persistent application secrets and gateway CA.

Disable **OneCLI’s own hosted-agent runner** (`runner.enabled=false`) and leave its channel adapter disabled. We already have the pi-durable orchestrator and agent-sandbox; bundling another agent execution plane adds irrelevant RBAC and infrastructure.

**Redis is not mandatory for the single-instance self-hosted configuration at this tag.** The source selects in-memory gateway cache/approval stores when `REDIS_HOST` is absent. Setting `REDIS_HOST` selects licensed multi-instance functionality; an unlicensed gateway refuses to start.

Evidence:

- `apps/gateway/crates/onecli-gateway/src/wiring.rs`
- `apps/gateway/crates/ee/ee/src/ha.rs`
- `charts/onecli/values.yaml`

Thus, do not automatically bundle Redis merely because the existing external deployment has it. Keep API and gateway at one replica in the basic profile. An enterprise/HA profile needs a separately validated Redis and scaling configuration.

The external GitOps deployment is not present in this repo, so this source check does not establish its exact live Redis configuration.

### Upgrade coupling and blast radius

Sharing the instance still shares:

- Disk capacity, WAL and I/O.
- Connection exhaustion.
- Database maintenance/restarts.
- Instance-level failure and recovery.

For evaluation, accept that. For production, support an independently configured OneCLI database endpoint, even if initially pointing to the same managed instance.

Keep OneCLI versions independently selectable within a tested compatibility range. Its migrations must complete before serving components start. Do not assume `helm rollback` reverses database migrations; the repository’s OneCLI recheck explicitly records forward-only migration/restore requirements.

There is also a bootstrap gap: **deploying OneCLI does not create the user/org, provider credentials, orchestrator agent and grants automatically.** Document a supported onboarding step or implement a narrowly privileged, idempotent provisioner. Do not generate arbitrary `oc_`/`aoc_` strings and assume they are registered identities, or seed undocumented internal tables.

## 4. Dropping bundled CNPG is right—with an honest support boundary

The core application is already mostly PostgreSQL-agnostic. It consumes `PI_DURABLE_DATABASE_URL`; it does not intrinsically need a Service named `pi-pg-rw`.

What disappears with a simple StatefulSet:

| CNPG capability | Replacement responsibility |
|---|---|
| Primary discovery and `-rw` endpoint | Stable writer Service; no failover claim for a single replica |
| Replication, failover and controlled switchovers | Not provided by the evaluation database |
| Backup/WAL/PITR integration | Explicit backup/restore integration or external DB requirement |
| Certificate lifecycle | TLS provisioning, trust and renewal |
| Operator health/reconciliation | StatefulSet probes plus operator-owned operational procedures |
| Generated `pi-pg-app` credentials | Database provisioning and stable connection Secret |

Be precise: the current manifest has **one instance and no configured backups**. You are losing an operator’s available capabilities, not an already configured HA/backup deployment.

Required changes:

- Replace CNPG-generated Secret references.
- Replace CNPG pod selectors in network policies.
- Remove CNPG instance-manager/API traffic rules from the simple-Postgres profile.
- Supply database/role/schema initialization that also works with existing PVCs. Image init scripts run only on an empty data directory.
- Refactor tests that exec into CNPG pods or wait on CNPG `Cluster` readiness.
- Define PVC retention, credential reuse, password rotation and restore behavior.

Do not silently migrate an existing CNPG database by changing Helm values. Offer a separate migration procedure: quiesce writers, take verified backups, migrate both applications’ databases as applicable, change endpoints, and test recovery.

## 5. Images, secrets and External Secrets

### Replace code shipping completely

Build and publish at least:

- Orchestrator image.
- Ingest image.
- Sandbox image.
- E2E driver image.

Use reproducible multi-stage builds with pinned Node/pnpm/base images and the frozen lockfile. Include the vendored adapter/SDK and **session-core’s SQL migration files**, not just compiled JavaScript.

Reference runtime images by digest, including OneCLI’s web/API/gateway/migrations images and bootstrap jobs. The upstream OneCLI chart currently exposes a shared tag, so digest support needs a reviewed integration change; do not assume it already exists.

Remove:

- `retired-code-volume` PVC and loader pods.
- Ingest code ConfigMap and unpack init container.
- Push locks/retries from the installation path.
- Shard pod affinity imposed solely by the shared RWO code volume.

Built images eliminate that unnecessary single-node constraint. Keep per-shard `Recreate` and a controlled upgrade procedure: ADR 0017 currently says mixed shard versions are unsupported.

**Multi-architecture is a release requirement.** the former arm64-only sandbox build script currently packages only the Linux **arm64** pi-env binary and builds `linux/arm64`. That will not deliver an ordinary amd64 kind experience. Build and verify each architecture, then publish a multi-architecture index.

### Secret ownership

| Secret | Recommended handling |
|---|---|
| sandboxd master key | Generate once for trials or accept existing Secret; preserve across upgrades/restores |
| API bearer tokens | Generate once for trials; require explicit owners/admins or an existing Secret for real installations |
| Bundled DB passwords | Generate once, retain with database lifecycle; separate application roles |
| External DB credentials | Require existing Secret |
| OneCLI encryption/auth/internal keys | Generate once or require existing Secret; back up with OneCLI data |
| OneCLI management key and agent token | Obtain through supported OneCLI provisioning; never fabricate locally |
| GitHub App private key, App ID, installation ID | User-provided existing Secret; optional feature |
| Provider credentials/OAuth login | Onboard into OneCLI, never embed in chart values |

Avoid freshly evaluated `randAlphaNum` on every render. Prefer create-if-absent generation with explicit lifecycle rules, or operator-created Secrets. Offline `helm template`/GitOps must not depend on a live `lookup` to preserve identity.

Losing or rotating the sandboxd master breaks authentication to existing claims. Losing OneCLI’s encryption key makes stored credentials unusable. These are **backup assets**, not disposable generated configuration.

There is an existing security discrepancy worth making visible: `deploy/repo-externalsecrets.yaml` supplies an **account-level OneCLI management key to the orchestrator**, although the plan targets a scoped key or separate provisioner. Packaging should not disguise this as least privilege.

### CA handling

Replace laptop port-forward fetching with a supported bootstrap/trust mechanism.

The upstream OneCLI chart can generate its gateway CA into a persistent Secret using the gateway binary. Distribute **only the public certificate** to pi-durable; do not expose the private CA key to orchestrators or sandboxes.

For an existing gateway, accept an explicit CA ConfigMap/reference. Define CA rotation and client restarts. Today the orchestrator’s proxy agent reads the CA at construction, so updating a ConfigMap alone is insufficient.

### External Secrets

**Yes—keep it optional.**

The base chart should work with ordinary Kubernetes Secrets and no ESO CRDs. An optional integration may create `ExternalSecret` objects with configurable store kind/name and remote mappings. Never install a cluster-wide secret store implicitly.

For enabled features, wait for required credentials before startup. Today several Secret references are optional and read only once; a late-arriving Secret does not update the environment of a running process.

## 6. Concrete hard-coded assumptions to remove

| Files | Assumption and required change |
|---|---|
| `deploy/postgres.yaml` | CNPG `Cluster/pi-pg`, PG17, `app` database/role, `durable` bootstrap schema, `<lab-storage-class>`. Replace or select database backend explicitly. |
| `deploy/orchestrator.yaml`, `deploy/ingest.yaml` | `pi-pg-app` Secret, key `uri`; fixed application/config/Secret names and stock Node image/code shipping. Template connection references and names. |
| `deploy/orchestrator.yaml` | `onecli.onecli:10255/10256`, `pi-pg-rw` in `NO_PROXY`, fixed warm-pool/CA names. Render actual endpoints. |
| `packages/orchestrator/src/config.ts` | Defaults to `pi-durable-poc`, `pi-env-pool`, `onecli.onecli`; `DEFAULT_NO_PROXY` contains `pi-pg-rw` and `.cluster.local`. Prefer explicit deployment configuration and configurable cluster domain. |
| `packages/ingest/src/config.ts`, `deploy/add-shard.sh`, `deploy/orchestrator-service.yaml` | Fixed `pi-orchestrator[-{shard}]` naming/routing; imperative shard creation. Render shards and URLs together. |
| `packages/session-core/src/migrate.ts`, `packages/session-core/migrations/`, session-core SQL | Fixed shared `inbox` schema. Requires a dedicated application database unless comprehensively parameterized. |
| `packages/orchestrator/src/storage.ts`, `packages/session-core/src/db.ts` | Startup schema creation and separate pool factories; TLS contract needs adding. Their CNPG references are largely documentation, not a hard hostname dependency. |
| `deploy/networkpolicy-{ingest,orchestrator,postgres}.yaml`, `deploy/cilium/kube-apiserver.yaml` | `cnpg.io/cluster=pi-pg`, operator namespace `postgres-system`, CNPG ports/API access. Wrong selectors will block a StatefulSet database. |
| `deploy/networkpolicy.yaml`, `deploy/networkpolicy-orchestrator.yaml` | OneCLI namespace `onecli`, pod label `app=onecli`, fixed ports. Upstream OneCLI chart uses separate component Deployments/Services and different labels. |
| `deploy/onecli-policies/{ingress,egress}.yaml` | Fixed `pi-durable-poc`, `onecli`, Envoy namespace/labels, and DB target `postgres-clusters/pg-db-cluster`. Must match bundled/external topology. |
| `deploy/fetch-onecli-ca.sh` | Port-forwards `onecli/svc/onecli`, API port 10256; writes fixed ConfigMap `onecli-ca`. Replace with configurable trust/bootstrap wiring. |
| `deploy/{onecli-externalsecret,repo-externalsecrets}.yaml` | Mandatory ESO kinds, fixed `ClusterSecretStore/cluster-secret-store` and remote keys. Gate and parameterize. |
| `deploy/onecli-host-rules.sh` | Reads management key from `secret-store/pi-onecli-admin`; fixed org-wide host rules. Do not automatically mutate policies on an existing shared gateway. |
| `deploy/namespace.yaml`, `deploy/kustomization.yaml`, `deploy/cilium/kustomization.yaml` | Fixed namespace; PSA version `v1.36`. Use release namespace and a documented supported/pinned PSA profile. |
| `deploy/{gen-secret,gen-api-secret,push-code,push-ingest,fetch-onecli-ca,add-shard}.sh` | Default namespace `pi-durable-poc`. These defaults are overridable already, but should disappear from the supported install path. |
| `deploy/sandbox-template.yaml`, `deploy/retired-code-volume-pvc.yaml`, `tests/e2e/driver/driver-pvc.yaml` | `<lab-storage-class>`; sandbox also requires RuntimeClass `gvisor`. Make storage/runtime choices explicit. |
| `images/sandbox/{Dockerfile,build.sh}`, `pnpm-workspace.yaml` | arm64-oriented binary/build/dependency preparation. Add amd64 release coverage. |
| `tests/e2e/run.sh`, `tests/e2e/deploy/kustomization.yaml` | Unconditional Cilium resources, CNPG patches, ESO wait, CA fetch and code pushing. Exercise the chart instead. |
| `tests/e2e/run-{phase3,phase4,phase4b,phase4c,mcp,shards}.sh` | SQL helpers exec into `pi-pg-1`, container `postgres`, database `app`; several await CNPG readiness. Introduce backend-independent test helpers. |
| `tests/e2e/run-phase3.sh`, `tests/e2e/run-phase4c.sh` | Fixed DB/OneCLI DNS probes or fallback API address. Pass rendered endpoints into tests. |
| `packages/orchestrator/src/onecli-names.ts` | Default shared prefix `pi-session-`. Generate a **stable installation-unique** prefix; otherwise one installation’s orphan sweep can revoke another’s agents. |

Two nontrivial portability issues accompany that list:

- Standard policy generation alone is insufficient: current API-server/FQDN allowances live in Cilium resources. Supply a working alternative policy contract, not merely skip those manifests.
- Existing Sandboxes retain copied templates. As ADR 0019 explains, a template update does not update them. Provide safe patch/recycle procedures; **never delete claims automatically**, because that deletes workspace PVCs.

For runtime support, keep gVisor the supported isolation default. Allow an explicit empty/default RuntimeClass for trusted kind tests, with a prominent warning—never silently fall back to runc when gVisor scheduling fails.

A CNI-capability warning is reasonable, but CRD presence does not prove enforcement. Add actual isolation probes. Also fix the current E2E gap: `NETPOL_ENFORCED` is not forwarded through `run.sh` and `job.yaml.tpl`, allowing isolation to remain `KNOWN-FAIL`.

## Ranked top risks

1. **False isolation claims:** unenforced policies, incorrect selectors, or silent runc fallback produce a working but unsafe installation.
2. **Persistent identity/data loss:** regenerated master/encryption keys, deleted PVCs, or assuming Helm rollback reverses migrations.
3. **Broken ownership semantics:** transaction pooling, wrong search paths, or inappropriate replica/shard changes.
4. **Shared cluster-resource ownership:** upgrading/removing agent-sandbox CRDs/controllers used by other installations.
5. **OneCLI bootstrap and privilege:** gateway deployment mistaken for credential provisioning; account-level management keys and shared-prefix sweeps.
6. **Shared Postgres blast radius:** OneCLI and durable workloads contend for resources and fail together.
7. **Untested portability:** arm64-only sandbox builds, lab storage/Envoy/Cilium assumptions, and CNPG-specific E2E helpers.

## Proposed install sequence

1. **Select a profile:** production/external dependencies or explicit evaluation mode. Validate Kubernetes version, architecture, storage, runtime and policy requirements.
2. **Bootstrap cluster prerequisites separately:** on kind, create the cluster and install a pinned policy-enforcing CNI; install/reuse compatible agent-sandbox CRDs/controllers. Check readiness with a sandbox probe.
3. **Create namespace/security configuration and durable Secrets.** Establish retention and backup ownership before starting stateful components.
4. **Provision Postgres:** bundled evaluation instance or external endpoint; create separate pi-durable/OneCLI databases and roles; verify TLS, permissions and session semantics.
5. **Install/reuse OneCLI:** disable its runner, complete migrations, establish persistent CA/keys, then configure account, credentials, grants and host rules.
6. **Install pi-durable and its policies:** use digest-pinned images, rendered shard routing, connection Secrets and public gateway CA.
7. **Run chart-based smoke, restart, double-owner, multi-shard and isolation tests.** Add real-model/repository tests only after credentials and isolation are verified.
8. **Enable external access last.** The kind script should orchestrate these same steps—not maintain a second installation implementation.
