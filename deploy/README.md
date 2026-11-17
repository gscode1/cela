# Deploy settings

The base uses namespace `pi-durable-poc`, the current kubectl context, and the cluster's default StorageClass (storage class fields are omitted, not set to `""`). Use a dedicated test cluster, not production. PVCs need dynamic provisioning and ReadWriteOnce support; choose a `Delete` reclaim policy for disposable e2e volumes. Retained volumes need manual cleanup.

Workspaces and data need different classes. A sandbox workspace is per-session scratch: a fast single-replica class
with `WaitForFirstConsumer` fits, at the cost of losing the workspace (not the conversation) if its node's disk is lost.
Its PVC is kept across idle suspend and deleted with the session, so the class must reclaim with `Delete`; with `Retain`
every deleted session leaves a volume behind. Postgres and the orchestrator code volume need a replicated, durable class.

**Upgrading a stack deployed before the storage class was removed from the base** (it named one explicitly): set the
same classes in your overlay before you apply, or `kubectl apply` tries to drop `storageClassName` from the existing
`orchestrator-code` PVC, which Kubernetes rejects as immutable, and changes the class of the existing Postgres cluster.
Read the current ones with `kubectl get pvc -o custom-columns=NAME:.metadata.name,CLASS:.spec.storageClassName`.

Adapt the base or use a local Kustomize overlay before applying:

| Setting | Where / default |
| --- | --- |
| Storage class | `postgres.yaml` `/spec/storage/storageClass`; `orchestrator-code-pvc.yaml` `/spec/storageClassName`; `sandbox-template.yaml` `/spec/volumeClaimTemplates/0/spec/storageClassName`. Omitted = cluster default. |
| Sandbox image | `sandbox-template.yaml` `/spec/podTemplate/spec/containers/0/image`. The digest-pinned `docker.io/gsimage/pi-sandbox` is the published **arm64** example image, not a registry you must own. Replace it with your image for your architecture/registry. |
| OneCLI endpoints | `orchestrator.yaml`: `PI_ONECLI_API=http://onecli.onecli:10256`, `PI_ONECLI_GATEWAY=http://onecli.onecli:10255`. Patch its env entries and the OneCLI namespace/pod selectors in network policies together. |
| External Secrets | `onecli-externalsecret.yaml`, `repo-externalsecrets.yaml`: `ClusterSecretStore/cluster-secret-store`, remote keys and properties. Supply your store, or remove these resources and create the same target Secrets by another secure mechanism. |
| Network identities | `networkpolicy*.yaml`, `cilium/`: DNS `kube-system/kube-dns`, CNPG operator `postgres-system/cloudnative-pg`, OneCLI `onecli/app=onecli`. Match your installed labels/namespaces. |
| Client ingress | `networkpolicy-ingest.yaml`: optional Envoy Gateway selectors. Replace with your controller or use port-forward. No HTTPRoute/hostname is required. |
| Models | `model-config.yaml` seeds Postgres once; select providers/models you have configured in OneCLI. Later use the admin API. |

For example, a local overlay at `deploy/local/` can choose storage and an image (do not commit your local settings):

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ..
patches:
  - target: { kind: Cluster, name: pi-pg }
    patch: |-
      - op: add
        path: /spec/storage/storageClass
        value: your-storage-class
  - target: { kind: PersistentVolumeClaim, name: orchestrator-code }
    patch: |-
      - op: add
        path: /spec/storageClassName
        value: your-storage-class
  - target: { kind: SandboxTemplate, name: pi-env-template }
    patch: |-
      - op: add
        path: /spec/volumeClaimTemplates/0/spec/storageClassName
        value: your-storage-class
      - op: replace
        path: /spec/podTemplate/spec/containers/0/image
        value: registry.example.com/team/pi-sandbox:your-tag
```

Build with `IMAGE_REPO=registry.example.com/team/pi-sandbox images/sandbox/build.sh` (Docker buildx and npm required). The build script currently packages the pinned linux/arm64 pi-env binary. For amd64, adapt the binary, checksum and build platform together; do not run the arm64 image on amd64 nodes.

Apply the adapted Cilium policies first, then the stack. Generate `sandboxd-auth` and `api-auth` with `gen-secret.sh` and `gen-api-secret.sh`; provision the OneCLI Secrets and fetch its CA with `fetch-onecli-ca.sh` (`ONECLI_NAMESPACE=onecli`, `ONECLI_SERVICE=onecli`, `ONECLI_API_PORT=10256` by default). Run `push-code.sh` and `push-ingest.sh` to build and upload code. These scripts use `NAMESPACE` (default `pi-durable-poc`) and `KUBE_CONTEXT` (unset = current context); they require Node/pnpm locally. See [model credentials](../docs/model-credentials.md) and [network policy](../docs/network-policy.md) for setup and verification.

E2e uses the same base, not `deploy/local`. `STORAGE_CLASS` overrides all four storage resources (including its driver PVC) and `SANDBOX_STORAGE_CLASS` the workspace class alone; `SANDBOX_IMAGE` overrides its sandbox image. Other base customizations must be made in `deploy/` or `tests/e2e/deploy/` before running. See [e2e](../docs/e2e.md).
