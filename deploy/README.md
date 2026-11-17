# Deploy settings

The base uses namespace `pi-durable-poc`, the current kubectl context, and the cluster's default StorageClass (storage class fields are omitted, not set to `""`). Use a dedicated test cluster, not production. PVCs need dynamic provisioning and ReadWriteOnce support; choose a `Delete` reclaim policy for disposable e2e volumes. Retained volumes need manual cleanup.

Workspaces and data need different classes. A sandbox workspace is per-session scratch: a fast single-replica class
with `WaitForFirstConsumer` fits, at the cost of losing the workspace (not the conversation) if its node's disk is lost.
Its PVC is kept across idle suspend and deleted with the session, so the class must reclaim with `Delete`; with `Retain`
every deleted session leaves a volume behind. Postgres needs a replicated, durable class. Application code lives in images,
not persistent volumes. Preserve an existing database's storage class in your overlay before applying changes.

## Build images

From the repository root (Docker buildx and Node 22.19+ required):

```sh
images/build.sh all                              # amd64 + arm64 OCI archives; no publication
images/build.sh all --platform linux/arm64       # --load on a native arm64 host
IMAGE_REPO=registry.example.com/team images/build.sh all --push
```

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
