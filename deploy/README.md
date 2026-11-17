# Deploy settings

> The supported install is now the Helm chart [`charts/pi-durable`](../charts/pi-durable/README.md) with
> [`hack/install.sh`](../hack/install.sh) (install slice 4); `tests/e2e/run.sh` installs it too. The kustomize base in
> this directory and its scripts still work for the existing long-lived stack and are removed once the chart replaces
> them (slice 11). The image build instructions below apply to both.

The base uses namespace `pi-durable-poc`, the current kubectl context, and the cluster's default StorageClass (storage class fields are omitted, not set to `""`). Use a dedicated test cluster, not production. PVCs need dynamic provisioning and ReadWriteOnce support; choose a `Delete` reclaim policy for disposable e2e volumes. Retained volumes need manual cleanup.

Workspaces and data need different classes. A sandbox workspace is per-session scratch: a fast single-replica class
with `WaitForFirstConsumer` fits, at the cost of losing the workspace (not the conversation) if its node's disk is lost.
Its PVC is kept across idle suspend and deleted with the session, so the class must reclaim with `Delete`; with `Retain`
every deleted session leaves a volume behind. Postgres needs a replicated, durable class. Application code lives in images,
not persistent volumes. Preserve an existing database's storage class in your overlay before applying changes.

## Required application names

Orchestrator requires `PI_ORCH_NAMESPACE`, `PI_ORCH_WARMPOOL`, `PI_ONECLI_GATEWAY` and `PI_ONECLI_API`;
missing or blank values stop startup with the variable name. The base supplies the namespace from `metadata.namespace`
(the downward API), the warm pool and both OneCLI URLs explicitly. Shards inherit these settings; `add-shard.sh`
also sets the downward API reference. Configure the URLs even for scripted-only installs (they are unused there).
`PI_ONECLI_NAME_PREFIX` is explicitly `pi-session-` in the base and remains the code default; give each install sharing
OneCLI a distinct prefix. A future chart can set it directly without code changes.

The model dispatcher bypasses the gateway for the configured database host (URI host/query `host`, then `PGHOST`,
then localhost), the OneCLI API host, localhost, cluster suffixes (`.svc`, `.cluster.local`), Kubernetes API and private
CIDRs. `NO_PROXY` adds entries; it does not replace these protections. For a nonstandard cluster domain add its suffix
there. This is dispatcher-local, not a process-wide proxy setting.

Ingest requires an explicit `PI_ORCH_URL`; the base supplies its single-shard Service URL and `PI_ORCH_SHARDS=1`.
See [scaling](../docs/scaling.md) for the template contract and the startup check against stored session shards.

## Build images

From the repository root (Docker buildx and Node 22.19+ required):

```sh
images/build.sh all                              # amd64 + arm64 OCI archives; no publication
images/build.sh all --platform linux/arm64       # --load on a native arm64 host
IMAGE_REPO=registry.example.com/team images/build.sh all --push
```

CI (`.github/workflows/images.yml`) runs the same script for every push to `main` and every pull request of this
repository and publishes to `ghcr.io/<owner>/pi-*:<version>-<short sha>`; the job summary lists the digests.

`IMAGE_REPO` is a registry/repository **prefix**: images are named `pi-orchestrator`, `pi-ingest`, `pi-sandbox`,
`pi-e2e-driver` beneath it (default: those local names). Every tag is `<root package version>-<git short sha>`.
Use a clean checkout so the tag identifies its source. The script prints image references and content digests;
use `registry.example.com/team/pi-orchestrator@sha256:…` in your overlay. Without `--push`, a single native
platform is loaded into Docker; other builds write `pi-<name>-<tag>.oci.tar` in the current directory. No images
are published automatically. Omitting the image target builds `all`. `--platform` accepts `linux/amd64`, `linux/arm64`, or their comma-separated list.

All Dockerfiles take the repository root as context. App builds use the frozen pnpm lockfile and deploy workspace
dependencies, including the vendored adapter/SDK and session-core SQL migrations. The driver includes CLI tools,
suite scripts, Node clients and the sandbox-env Phase 1 test bundle. Containers run as uid/gid 1000; manifests
retain the restricted Pod Security controls (ADR 0019).

The sandbox selects `pi-env` 1.5.2 from its npm tarball by `TARGETARCH`. Verified binary SHA-256 values:

| Architecture | Tarball path | SHA-256 |
| --- | --- | --- |
| amd64 | `package/bin/pi-env-linux-x64/pi-env` | `b730549ce73dbefc2f3e9e90aee6f9f172ae8279d7f84e726b14fffe527f990c` |
| arm64 | `package/bin/pi-env-linux-arm64/pi-env` | `23094f7089e3ab4410431ced346ee50944ae601ea91aa14061573d23d4e3d8c3` |

## Configure and deploy

Adapt the base or use a local Kustomize overlay before applying:

| Setting | Where / default |
| --- | --- |
| Storage class | `postgres.yaml` `/spec/storage/storageClass`; `sandbox-template.yaml` `/spec/volumeClaimTemplates/0/spec/storageClassName`. Omitted = cluster default. |
| Images | `orchestrator.yaml` and `ingest.yaml` use deliberately non-pullable `registry.example.com/team/pi-…:replace-me` examples. Replace `/spec/template/spec/containers/0/image` with your built digest. Also replace the sandbox template's existing arm64 example at `/spec/podTemplate/spec/containers/0/image` with your multi-arch digest. |
| OneCLI endpoints | `orchestrator.yaml`: `PI_ONECLI_API=http://onecli.onecli:10256`, `PI_ONECLI_GATEWAY=http://onecli.onecli:10255`. Patch its env entries and the OneCLI namespace/pod selectors in network policies together. |
| External Secrets | `onecli-externalsecret.yaml`, `repo-externalsecrets.yaml`: `ClusterSecretStore/cluster-secret-store`, remote keys and properties. Supply your store, or remove these resources and create the same target Secrets by another secure mechanism. |
| Network identities | `networkpolicy*.yaml`, `cilium/`: DNS `kube-system/kube-dns`, CNPG operator `postgres-system/cloudnative-pg`, OneCLI `onecli/app=onecli`. Match your installed labels/namespaces. |
| Client ingress | `networkpolicy-ingest.yaml`: optional Envoy Gateway selectors. Replace with your controller or use port-forward. No HTTPRoute/hostname is required. |
| Models | `model-config.yaml` seeds Postgres once; select providers/models you have configured in OneCLI. Later use the admin API. |

For example, a local overlay at `local/` in the repository root (outside `deploy/`: kustomize refuses an overlay inside its base) can choose storage and an image (do not commit your local settings):

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../deploy
patches:
  - target: { kind: Cluster, name: pi-pg }
    patch: |-
      - op: add
        path: /spec/storage/storageClass
        value: your-storage-class
  - target: { kind: Deployment, name: pi-orchestrator }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/image
        value: registry.example.com/team/pi-orchestrator@sha256:your-digest
  - target: { kind: Deployment, name: pi-ingest }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/image
        value: registry.example.com/team/pi-ingest@sha256:your-digest
  - target: { kind: SandboxTemplate, name: pi-env-template }
    patch: |-
      - op: add
        path: /spec/volumeClaimTemplates/0/spec/storageClassName
        value: your-storage-class
      - op: replace
        path: /spec/podTemplate/spec/containers/0/image
        value: registry.example.com/team/pi-sandbox:your-tag
```

Apply the adapted Cilium policies first. Generate `sandboxd-auth` and `api-auth` with `gen-secret.sh` and
`gen-api-secret.sh`; provision the OneCLI Secrets and fetch its CA with `fetch-onecli-ca.sh`
(`ONECLI_NAMESPACE=onecli`, `ONECLI_SERVICE=onecli`, `ONECLI_API_PORT=10256` by default), then apply your stack overlay.
These scripts use `NAMESPACE` (default `pi-durable-poc`) and `KUBE_CONTEXT` (unset = current context).
Update each orchestrator shard to the same digest on subsequent rollouts; `add-shard.sh` clones the current shard 0
image without shared-volume node affinity. See [model credentials](../docs/model-credentials.md) and
[network policy](../docs/network-policy.md).

E2e uses the same base, not `local/`. `STORAGE_CLASS` overrides database and workspace storage;
`SANDBOX_STORAGE_CLASS` overrides workspace storage alone. Set `ORCH_IMAGE`, `INGEST_IMAGE`, `DRIVER_IMAGE` and
`SANDBOX_IMAGE` to pushed image digests before running. Other customizations belong in `deploy/` or
`tests/e2e/deploy/`. See [e2e](../docs/e2e.md).

## Reinstall an existing `deploy/` stack from the chart

A stack made from this directory is not upgraded to the chart: its namespace is deleted and recreated, and its sessions,
workspaces and database are discarded ([install plan](../docs/install-plan.md) section 9a). Keep what is worth keeping
first; the delete cannot be undone.

1. **Inventory (read-only).** Note the images, the sandbox template (runtime class, resources, workspace size and class),
   `PI_API_ADMINS`, the model settings, the OneCLI URLs and the CA ConfigMap name, and which `ExternalSecret`s exist.
   Put them in the cluster's values file under `local/` (git-ignored).
2. **Back up the runtime config.** Settings, session profiles, skills and the MCP catalog live in Postgres (schema
   `inbox`). Dump them data-only from the database pod and keep the file outside the repository:
   `pg_dump --data-only --column-inserts -t inbox.settings -t inbox.settings_history -t inbox.profiles
   -t inbox.profile_versions -t inbox.skills -t inbox.skill_versions -t inbox.skill_version_files
   -t inbox.mcp_servers -t inbox.mcp_servers_history`. Check that the file lists your profiles. Save the old `api-auth`
   owner names (not tokens): the new tokens differ.
3. **Delete the namespace** while the agent-sandbox controller runs, so the Sandbox finalizers complete. Never touch the
   CloudNativePG operator, its CRDs or namespace: only this stack's own `Cluster` goes with the namespace. Then list
   `kubectl get pv | grep <namespace>` and remove Released volumes of this namespace by hand (none remain with a
   `Delete` storage class).
4. **Create the database.** `hack/install.sh` creates the namespace with the restricted Pod Security labels and the
   `sandboxd-auth` and `api-auth` Secrets, then stops until the database URI Secret exists; so run it once, create the
   `charts/pi-postgres` Secrets and release and the URI Secret, then apply the ExternalSecrets and the OneCLI CA, and
   run `hack/install.sh` again:

   ```sh
   hack/install.sh -n <ns> -f local/values.yaml        # stops: the database Secret is missing; namespace and Secrets exist now
   # pi-postgres-auth (postgres-password, pi-password, onecli-password) from random values, then:
   helm upgrade --install pi-postgres charts/pi-postgres -n <ns> -f local/postgres-values.yaml --wait
   # the URI Secret named by database.external.existingSecret: postgres://pi:<pi-password>@pi-postgres.<ns>.svc:5432/pi
   kubectl -n <ns> apply -f deploy/onecli-externalsecret.yaml -f deploy/repo-externalsecrets.yaml
   NAMESPACE=<ns> deploy/fetch-onecli-ca.sh              # the chart does not create the CA ConfigMap
   hack/install.sh -n <ns> -f local/values.yaml
   ```

5. **Restore the config.** In one transaction truncate the nine `inbox` config tables (the new install seeds a
   `coding` profile and a settings row; the restored rows replace them) and load the dump; then restart the orchestrator
   and ingest so their caches reload. Check `GET /admin/settings` and `GET /admin/profiles`.
6. **Verify.** `GET /admin/status` shows the configured and observed runtime (the observed one appears after the first
   sandbox exists), run one session through ingest, then `tests/e2e/run.sh smoke`.

The values that carried over in the lab are in [lab notes](../docs/lab-notes.md).

## agent-sandbox controller and CRDs

The controller and its CRDs are cluster-wide and a prerequisite of this stack. `hack/agent-sandbox.sh` (`KUBE_CONTEXT`
as above) handles them in one of two modes and never upgrades, adopts, patches or deletes an existing controller or CRD:

- `hack/agent-sandbox.sh bundled`: if none of the four CRDs (`sandboxes.agents.x-k8s.io`, and `sandboxclaims`,
  `sandboxtemplates`, `sandboxwarmpools` under `extensions.agents.x-k8s.io`) exist, downloads the pinned v1.0.11
  `sandbox-with-extensions.yaml` release asset, verifies its sha256, applies it server-side and waits for the CRDs and the
  controller Deployment (`agent-sandbox-system`). If any of the CRDs exist it refuses and changes nothing.
- `hack/agent-sandbox.sh external`: read-only. Checks that `v1beta1` is served for Sandbox, SandboxClaim,
  SandboxTemplate and SandboxWarmPool and that a controller Deployment, if one is detectable, has available replicas.

The version matches the vendored SDK (`packages/vendor/agent-sandbox-client/VENDORED.md`). Move it on purpose: change the
version, URL and sha256 at the top of the script.
