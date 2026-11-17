# Install plan review, Sol session B: runtime, isolation, kind and tests

Answer of a `gpt-6.1-sol` session running on this stack in a lab cluster, 2026-11-17, reviewing the ideas in `docs/install-plan.md` against `main` at `9f52ebc`. Kept as written except that lab-specific names are generalized (`<lab-storage-class>`). Some findings were fixed on `main` by #101 afterwards (no storage class in the base, configurable OneCLI CA fetch). Claims used in the plan were checked there.

## Recommendation


**Support runc as an explicitly insecure development mode; use Cilium-backed kind for local trials; make isolation verification mandatory for the normal installation profile.**

“Helm installed successfully” must not imply “safe to run untrusted code.”

I reviewed the requested files and deployment scripts at commit `9f52ebc`. No repository files were changed, and I did not run cluster tests.

Use two clearly named profiles:

| | Default installation | Local/CI development |
|---|---|---|
| Sandbox runtime | Preinstalled gVisor | runc, explicitly acknowledged |
| Network policies | Enabled, enforcement required | Enabled; preferably enforced by Cilium |
| Credentials | Explicit bootstrap | Scripted model by default, no provider credentials |
| Security claim | Verified prerequisites, not production certification | **Not suitable for untrusted workloads** |

## 5. Supporting runc alongside gVisor

### The application is less gVisor-specific than the deployment

The main assumptions are:

- `deploy/sandbox-template.yaml` hard-codes `runtimeClassName: gvisor`.
- `packages/orchestrator/src/sandboxes.ts` explicitly uses `in-cluster-service`.
- `packages/sandbox-env/src/index.ts` defaults to that connectivity mode.
- The vendored SDK supports port-forwarding, but its README and implementation document that it does not work with this gVisor arrangement.
- The sandbox image runs sandboxd and `pi-env` together; neither application component intrinsically requires gVisor.

**Keep `in-cluster-service` for both runtimes.** Do not automatically switch runc to port-forwarding. That would exercise a different data path locally, obscure policy failures, and potentially add `pods/portforward` permissions unnecessarily. Keep `service: true` on the template.

The lower-level bridge can retain port-forwarding as a developer option, not the packaged orchestrator’s default.

### Make runtime selection explicit—not merely an optional string

Suggested values, illustrative rather than existing:

```yaml
sandbox:
  isolation: gvisor
  runtimeClassName: gvisor

security:
  allowInsecureRuntime: false
  requireVerifiedNetworkPolicy: true
```

The local profile would deliberately set:

```yaml
sandbox:
  isolation: insecure-container
  runtimeClassName: ""

security:
  allowInsecureRuntime: true
```

An empty runtime class means **use the node’s default runtime**, not necessarily runc. Conversely, `runtimeClassName: runc` only works if somebody created that RuntimeClass. Explain this distinction.

Guard rails should exist in several places:

1. **Chart validation:** reject insecure/default-runtime selection without explicit acknowledgement. Never silently fall back when gVisor is missing.
2. **Orchestrator validation:** independently enforce the acknowledgement. Otherwise a manifest edit bypasses the Helm safeguard.
3. **Preflight execution:** create an actual sandbox through the packaged template and prove it becomes usable. A RuntimeClass object alone does not prove runsc is installed or correctly configured.
4. **Attach-time checks:** examine the resolved Sandbox/Pod before executing commands, including adopted sessions. Reject a runtime mismatch.
5. **Visibility:** emit a prominent structured startup warning and expose runtime/isolation status through an authenticated installation-status API and session responses.
6. **Scheduling:** use RuntimeClass scheduling constraints or equivalent node selectors/taints so gVisor workloads land only on prepared nodes.

Report configured and observed state separately, for example:

```json
{
  "sandbox": {
    "runtimeClassName": null,
    "isolation": "insecure-container",
    "verification": "passed"
  }
}
```

Here, “verification passed” means the deployment matched the requested configuration—not that runc became an adequate untrusted-code boundary. A RuntimeClass name is also not cryptographic runtime attestation.

Do not let ordinary session callers opt themselves into weaker isolation. Runtime selection should initially be an operator-level choice.

### Preserve ADR 0019 under both runtimes

runc does **not** require relaxing Pod Security:

- non-root;
- `allowPrivilegeEscalation: false`;
- drop all capabilities;
- `seccompProfile: RuntimeDefault`;
- no host namespaces or host mounts;
- no service-account token in sandbox pods.

These settings are particularly important under runc, but **restricted Pod Security is not a replacement for gVisor**. Agent commands still share the node kernel.

ADR 0019 needs two packaging updates:

- The fixed PSA version `v1.36` in `deploy/namespace.yaml` and `tests/e2e/run.sh` must become part of a documented, tested Kubernetes compatibility policy.
- Its exclusion of OneCLI and the agent-sandbox controller from “our workloads” needs revisiting once the installer owns them. Keep privileged CNI/node setup outside the restricted application namespace; audit each bundled component’s actual requirements.

**Runtime changes are also migrations.** Existing Sandboxes retain their copied `spec.podTemplate`; updating the SandboxTemplate does not change them, including after suspend/resume. Version templates and define an explicit migration path. Do not implement “change runtime” by deleting claims indiscriminately: claims can take workspace PVCs with them.

### Is gVisor on kind feasible?

**Yes, as a separately maintained integration profile—not a universally portable default.**

A custom kind node image can contain runsc and its containerd shim, with the appropriate containerd runtime handler configured. Then install the RuntimeClass and verify scheduling and execution.

But kind nodes are themselves containers:

- Host kernel features, nesting restrictions, cgroups, mounts and runsc platform selection matter.
- Docker Desktop adds a Linux VM; it is not equivalent to a native Linux CI host.
- A KVM-based setup requires usable `/dev/kvm`; do not assume that on Macs or hosted CI.
- Validate the chosen runsc release/platform on both architectures rather than promising parity.

My sequence would be:

1. Portable runc+Cilium kind profile for everyday development.
2. Dedicated gVisor-on-kind lane on a known-compatible Linux runner.
3. Retain real-cluster gVisor coverage until the nested lane demonstrates equivalent lifecycle behaviour.

Never downgrade the gVisor lane to runc when setup fails.

## 6. Network policies: create-and-warn is insufficient as the default

**Warning is reasonable for an explicitly insecure demo. It is not reasonable as the normal untrusted-agent installation policy.**

The repository already demonstrates why: `plan.md` records that the isolation test could reach Postgres, the orchestrator and another sandbox when flannel did not enforce policy.

A better distinction is:

- Unknown CNI: warn during preflight, then perform behavioural verification.
- Verified enforcement: proceed.
- Failed or inconclusive verification: block sandbox execution in the normal profile.
- Explicit insecure override: proceed with persistent warnings and API-visible degraded status.

Installation can leave diagnostic resources running without permitting agent tools. “Do not fail Helm immediately” and “allow unverified execution” need not be the same decision.

### What is portable today?

| Files | Dependency |
|---|---|
| `deploy/networkpolicy*.yaml` | Standard Kubernetes NetworkPolicy |
| `deploy/cilium/dns.yaml` | CiliumNetworkPolicy; overlaps the standard DNS allowance |
| `deploy/cilium/kube-apiserver.yaml` | Cilium `kube-apiserver` entity |
| `deploy/cilium/orchestrator-github.yaml` | Cilium DNS proxy rules and `toFQDNs` |
| `deploy/onecli-policies/{ingress,egress}.yaml` | Cilium endpoint identities, FQDN rules and explicit denies |

Therefore, **the current complete networking story is not CNI-neutral**, even though much of it uses standard policies.

Stock kind’s default **kindnet/kindnetd does not enforce NetworkPolicy**. Do not confuse it with separately installed policy-capable networking projects with similar names.

For the first supported package, I would choose:

- `networkPolicy.provider: cilium`: fully supported and tested.
- A later standard-policy mode with documented limitations and explicit configuration.
- No automatic “Cilium CRDs absent, omit those rules and call it equivalent” behaviour.

The comments claiming Kubernetes API access *cannot* be expressed with standard NetworkPolicy are too absolute. Endpoint/IP-based allowances are possible, but discovery, endpoint changes, host-traffic treatment and pre/post-DNAT behaviour make them implementation-dependent. Cilium’s entity abstraction avoids much of that portability work.

Standard NetworkPolicy has no equivalent to Cilium’s FQDN rules. A non-Cilium backend needs a consciously different solution—such as a constrained proxy or explicit endpoint allowances—not a cosmetic translation.

### Verify behaviour, not installed object names

A post-install verification Job and a reusable Helm test are good approaches. They should share the same probe implementation with any orchestrator self-check.

The probe should:

1. Create real SandboxClaims using the installed template and runtime.
2. Confirm allowed paths:
   - orchestrator → sandboxd, with authentication;
   - sandbox → DNS;
   - sandbox → OneCLI gateway;
   - orchestrator/ingest → database.
3. Confirm denied paths from a sandbox:
   - Postgres;
   - orchestrator and ingest;
   - another sandbox’s REST and gRPC ports;
   - Kubernetes API;
   - OneCLI management API and dashboard;
   - representative node/private/metadata destinations.
4. Test both Service addresses and direct Pod addresses where applicable.
5. Verify authentication separately: another sandbox’s token must not work even from an authorized network source.

**A timeout alone is not evidence of policy enforcement.** Each denied destination must have a confirmed listener reachable from an authorized source. Include direct-IP probes so broken DNS cannot manufacture a passing result.

Retry within a bounded window for endpoint/policy convergence; distinguish `failed` from `inconclusive`. On multi-node clusters, include cross-node checks.

`tests/e2e/run-phase3.sh:t_isolation` is a useful starting point, but it needs strengthening:

- Its allowed gateway control is valuable.
- Other denied targets also need positive reachability controls.
- It currently permits `KNOWN-FAIL` to count as an overall successful suite.
- **`NETPOL_ENFORCED` is not forwarded by `run.sh`/`job.yaml.tpl`**, as `docs/network-policy.md` explicitly notes. Fix this before treating CI green as isolation evidence.
- Its header still says public internet is denied, while the actual assertion requires it to be reachable.

Also avoid a bootstrap deadlock: if orchestrator readiness requires verification, a post-install hook must not require that same readiness before it can run. Either verification operates independently, or installation explicitly separates bootstrap readiness from permission to execute agent tools. Keep liveness independent.

### Policy changes required by the new topology

Packaging OneCLI and replacing CNPG require rewriting—not merely parameterizing—parts of the traffic matrix:

- Replace `cnpg.io/cluster` selectors and remove CNPG-only control-plane flows.
- Allow OneCLI to its new database destination.
- Preserve sandbox access to **gateway 10255 only**, not management 10256 or dashboard 10254.
- Parameterize namespaces, release identities, DNS configuration and ingress-controller selectors.
- Handle external database endpoints explicitly.
- Reconcile OneCLI’s private-address deny rules with its permitted database path and test the result.

If OneCLI shares a PostgreSQL server, use **separate databases and roles**, not the orchestrator’s database URI or owner role.

Finally, the existing sandbox policy intentionally permits broad public IPv4/IPv6 egress. The OneCLI host allowlist therefore **does not constrain direct sandbox internet access**. State that plainly; offer gateway-only egress as a distinct policy profile rather than implying that installing OneCLI supplies it.

## 7. The all-in-one kind script

**Yes—but make it a thin, deterministic composition of the real installer. Do not create a third deployment implementation.**

Suggested sequence:

1. **Validate tools and select an isolated target.**
   - Check Docker, kind, Helm and kubectl versions.
   - Choose a unique cluster name and explicit context.
   - Refuse accidental reuse of unrelated clusters.
   - Provide `--keep` and collect diagnostics before cleanup.

2. **Create kind with a pinned Kubernetes node image.**
   - Set `disableDefaultCNI: true`.
   - Start with one node for the portable profile; add a multi-node CI lane.
   - Use non-overlapping network ranges.
   - Default to explicit insecure-container mode, with a warning before creation.

3. **Install pinned Cilium configuration suitable for kind.**
   - Wait for agents, DNS and basic pod networking.
   - Do not make a normal application chart replace an existing cluster’s CNI.
   - If selecting gVisor, use the prepared node image/configuration and verify runsc first.

4. **Check storage.**
   - Verify kind’s provisioner/default StorageClass.
   - Select it explicitly for Postgres, OneCLI data and workspace PVCs.
   - Remove the `<lab-storage-class>` assumption.
   - Explain that surviving Pod deletion is not surviving deletion of the kind cluster.

5. **Build or obtain immutable application images.**
   - Add orchestrator and ingest Dockerfiles.
   - Build sandbox and test-driver images.
   - Load images into the named kind cluster; use explicit pull policies.
   - Replace the normal PVC/ConfigMap code-push path with images.

   Keep code pushing as a developer convenience if desired, not an installation prerequisite.

6. **Install agent-sandbox prerequisites and the chart.**
   - Pin a controller/CRD/sandboxd/SDK compatibility set.
   - Wait for CRDs and controllers before creating custom resources.
   - Make installing shared controller infrastructure optional.
   - Do not let uninstalling one application release remove infrastructure another release uses.

7. **Bootstrap OneCLI idempotently.**
   - Initialize its database and persistent state.
   - Establish the supported authenticated administrative bootstrap.
   - Install host rules before issuing usable session credentials.
   - Fetch and distribute its CA.
   - Create the orchestrator identity with only required grants.
   - Store resulting tokens in Kubernetes Secrets.

   This is new implementation work: the repo currently assumes an already initialized, separately managed OneCLI.

8. **Default to scripted models.**
   - No ESO or ClusterSecretStore should be required for a no-credential local trial.
   - Provide a separate opt-in real-model setup.
   - Accept credentials through existing Secrets or protected local input—not committed values files, shell arguments, Helm `--set`, or logs.
   - OAuth subscription login may require an interactive step; do not promise fully unattended bootstrap.

9. **Wait, verify isolation, then smoke-test.**
   - Create an authenticated scripted session.
   - Execute a tool that writes a workspace marker.
   - Read its streamed result.
   - Replace the sandbox Pod and verify persistence.
   - Delete the session and confirm claim/PVC cleanup.
   - Print status and access instructions without printing secrets.

Bootstrap credentials need stable lifecycle rules. Helm upgrade must not accidentally regenerate the sandbox master, database password or OneCLI CA. CA recreation also requires coordinated client trust updates.

### arm64 Macs and amd64 CI

There is an immediate concrete blocker: **`images/sandbox/build.sh` builds only `linux/arm64`, and its Dockerfile consumes an arm64 `pi-env` binary with an arm64-specific checksum.**

Change it to:

- select the binary using `TARGETARCH`;
- maintain verified checksums per architecture;
- verify every base image and bundled dependency supports both architectures;
- publish a multi-platform image index for releases;
- build/load only the native platform for local kind.

Check OneCLI and agent-sandbox artifacts too. A multi-platform Node base does not make the complete stack multi-platform.

Preserve macOS shell portability or require a documented newer Bash. Keep image compilation inside Linux build stages so host-native dependencies cannot leak into Linux images.

## E2E should install the chart

**Yes. Keep the existing suites; replace their installation mechanism.**

`tests/e2e/run.sh` already reuses `deploy/` through `tests/e2e/deploy/kustomization.yaml`, rather than maintaining a completely separate stack. Preserve that single-source principle by making it install the chart with test values:

- fresh `pi-e2e-*` namespace;
- unique OneCLI object prefix;
- scripted model defaults;
- test-only fault/control switches;
- reduced resources and shortened lifecycle timers;
- deterministic image references;
- isolated credentials and database state.

Retain its strong features: Job-based verdicts, no automatic test retries, namespace safety checks, and keep-on-failure diagnostics.

Remove dependencies on production’s OneCLI identity, shared secret store and lab configuration.

The suites also need a database-access helper. Many currently execute:

```sh
kubectl exec pi-pg-1 -c postgres -- psql ...
```

and wait for a CNPG `Cluster`. Those assumptions appear throughout `run-phase3.sh`, `run-phase4.sh`, `run-phase4b.sh`, `run-phase4c.sh`, `run-mcp.sh` and `run-shards.sh`. Switching the chart alone will not make those tests portable.

## Helm tests and minimal CI

### Every PR

1. `pnpm check`.
2. Helm lint, schema validation and rendering tests for:
   - gVisor and acknowledged insecure runtime;
   - bundled and external Postgres;
   - bundled and external OneCLI;
   - supported policy modes.
3. Validate **rendered manifests**, including test hooks, against the restricted security invariants.
4. Build native amd64 images and create kind with Cilium.
5. Install the chart from a clean cluster.
6. Run Helm tests covering:
   - readiness and API authentication;
   - one scripted tool call;
   - required isolation checks;
   - per-sandbox authentication;
   - session cleanup.
7. Run selected durability tests: orchestrator restart, sandbox replacement/PVC persistence, and database ownership fencing.
8. Always collect events, Job results and redacted logs before deleting the cluster.

Do not use provider credentials on untrusted PRs.

### Scheduled or release coverage

- Full existing `all` suite and sharding.
- Upgrade/reinstall with existing database and workspace state.
- External database configuration.
- arm64 execution.
- Real gVisor lifecycle/conformance tests.
- Protected, explicitly enabled real-model, MCP and private-repository tests.

A passing runc lane is application coverage, **not gVisor certification**.

### Concrete change map

| Area | Files |
|---|---|
| Runtime values and stable connectivity | `deploy/sandbox-template.yaml`, `packages/orchestrator/src/{config,kube,sandboxes,main}.ts` |
| Runtime/status API | `packages/ingest/src/server.ts`, `packages/session-core/src/store.ts`, `docs/session-api.md` |
| Networking backends/topology | `deploy/networkpolicy*.yaml`, `deploy/cilium/*`, `deploy/onecli-policies/*` |
| OneCLI bootstrap and secrets | `deploy/{fetch-onecli-ca,onecli-host-rules,gen-secret,gen-api-secret}.sh`, ExternalSecret manifests |
| Immutable/multiarch images | `images/sandbox/{Dockerfile,build.sh}`; new orchestrator, ingest and driver images |
| Chart-based tests | `tests/e2e/run.sh`, `tests/e2e/deploy/kustomization.yaml`, `job.yaml.tpl`, `driver/*`, suite DB helpers |
| Security regression coverage | `packages/orchestrator/test/pod-security.test.ts`—currently scans source manifests, not a new chart’s rendered output |
| Documentation | `README.md`, `plan.md`, requested networking/credentials/e2e docs, ADR 0019 |
| New packaging | Chart, kind configuration, bootstrap/verification commands and CI workflow |

## Ranked risks and overlooked work

1. **False assurance from successful installation.** runc or unenforced policies can turn agent execution into node/cluster compromise. Require explicit insecure acknowledgement and behavioural isolation checks.
2. **OneCLI bootstrap and credential authority.** Installing its Pods is not configuring authentication, identities, grants, host rules, CA persistence and rotation. The current orchestrator also holds an account-level management key.
3. **“Any cluster” exceeds the current networking design.** Cilium entities/FQDN policies, hard-coded namespaces, DNS assumptions, lab ingress selectors and private-range exclusions are substantive portability dependencies.
4. **Destructive upgrades.** Existing Sandboxes retain old templates; claims own valuable workspaces. Runtime/security migrations, CRD upgrades, secret stability and uninstall retention need explicit contracts.
5. **A green test can hide absent isolation.** Current `KNOWN-FAIL` handling and missing `NETPOL_ENFORCED` forwarding must be fixed before CI is trusted.
6. **Shared database increases blast radius.** Separate roles/databases, migration ownership, backups and restore testing are necessary; session advisory locks prohibit transaction-pooled connections.
7. **Architecture support is incomplete today.** The sandbox build is arm64-only, and nested gVisor adds host-specific constraints beyond ordinary multiarch images.
8. **Cluster-scoped lifecycle and local persistence.** Controller/CRD ownership, multiple releases, PVC finalizers, OneCLI object leaks, and deletion of kind’s backing storage are not solved by Helm packaging.
