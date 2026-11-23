# 0063: A ValidatingAdmissionPolicy limits the Pods the orchestrator may create to the isolation probe

Status: accepted, 2026-11-23 (issue #381). Hardens the isolation probe ([network policy](../network-policy.md), install
plan slice 9) and builds on [0019](0019-restricted-pod-security.md).

## Context

The orchestrator's Role grants `pods: create` so the isolation probe can start a short-lived Pod. RBAC cannot limit what
the Pod contains. With `create pods` the orchestrator ServiceAccount can mount any Secret of the namespace into a Pod it
creates (the restricted Pod Security level allows Secret volumes), read it from the Pod's log, run the Pod as any
ServiceAccount of the namespace, and give it any label. The pi-postgres and OneCLI NetworkPolicies admit Pods by label, so a
Pod with the right label also reaches the database and OneCLI. The orchestrator handles model and MCP output, so a
code-execution bug there is the realistic trigger.

The orchestrator already holds many secrets in its environment. The real increment of the grant is: the Postgres
superuser Secret, OneCLI's `SECRET_ENCRYPTION_KEY` (which decrypts every stored credential), Pods with other
ServiceAccounts, and Pods with labels that pass other workloads' policies.

## Options

1. **A ValidatingAdmissionPolicy** (GA in Kubernetes 1.30) that admits a Pod created by the orchestrator only in the shape
   of the probe Pod. The repository already targets v1.36 and newer (ADR 0019, `hack/kind-config.yaml`).
2. A separate ServiceAccount and Job for the probe. The orchestrator would still need `create jobs`, and a Job template
   has the same freedom as a Pod, so nothing is gained.
3. Run the probe through a SandboxClaim of a dedicated template (the orchestrator can already create claims). The probe
   would then exercise the real sandbox path, but it needs a sandboxd command channel, a PVC and a second template per
   network mode: a redesign of the probe, not a hardening.
4. Document the risk only. Cheap, and the finding stays open.

## Decision

Option 1. The chart renders a `ValidatingAdmissionPolicy` and a binding (`templates/orchestrator/probe-pod-policy.yaml`),
named `pi-orchestrator-probe-pod-<namespace>`, bound to the release namespace. A match condition limits it to requests
from `system:serviceaccount:<namespace>:pi-orchestrator`; every other creator (the Sandbox controller, Jobs, people) is
untouched. For that user a `CREATE` of a Pod is denied unless:

- the name starts with `pi-netprobe-` and the labels are exactly `app.kubernetes.io/name=pi-sandbox`,
  `cela.dev/network-mode=proxied` and `cela/netprobe` (the sandbox's own position, so it is judged by the sandbox policies and
  matches no label the pi-postgres or OneCLI policies admit);
- the ServiceAccount is `default` with `automountServiceAccountToken: false`;
- there is no volume, no host network, PID or IPC, one container and no init or ephemeral container;
- the runtime class is `sandbox.runtimeClassName`;
- the container runs the orchestrator image of the release with `node -e`, has no `envFrom`, no `valueFrom` (no
  `secretKeyRef`), no volume mount or port, and is neither privileged nor allowed to escalate.

`failurePolicy: Fail` and `validationActions: [Deny]`. The probe Pod now sets `serviceAccountName: default` explicitly
(`PROBE_SERVICE_ACCOUNT`). `security.probePodPolicy.enabled` (default `true`) turns the policy off.

The policy and its binding are **cluster-scoped**, the one exception to the chart's namespaced-only rule: the install
needs the right to create them (it already needs to create namespaces on the e2e path), and a cluster that does not serve
`admissionregistration.k8s.io/v1` `ValidatingAdmissionPolicy` (Kubernetes before 1.30, or the API disabled) must set
`probePodPolicy.enabled=false`. `tests/e2e/run.sh` deletes the two objects with the run namespace.

## Tests

`netprobe-policy.test.ts` renders the chart and checks the policy against the constants `buildProbePod` uses (labels,
ServiceAccount, command, image, runtime class). It restates the conditions in TypeScript and checks that the Pod
`buildProbePod` builds is admitted and that a Secret volume, `secretKeyRef`, `envFrom`, another ServiceAccount, a token
mount, an extra or another label, another image or command, an extra container, host network and a privileged container
are each rejected. The CEL itself is not evaluated in unit tests (no cluster, no CEL engine in the repository). The e2e
runs install the chart on a real cluster, and the orchestrator runs the probe at start: a policy that rejects the probe
Pod makes the create call fail, so the probe reports no result (the network policy state is not `enforced`, and the
orchestrator logs `network-policy-not-verified`); the e2e runs therefore exercise the policy, but nothing asserts its
denial of a foreign Pod on a real cluster (not run here).

## Residual risk

- The orchestrator can still create probe-shaped Pods: it may run `node -e` with the orchestrator image (one Pod per name, any
  script, any plan in `NETPROBE_PLAN`), inside the sandbox network position, with no token and no volume. That is the
  position of a sandbox, which the model-controlled tools already hold; it can exfiltrate nothing the orchestrator
  does not already hold in its own environment.
- The orchestrator can delete Pods and read any Pod's log; unchanged.
- The `default` ServiceAccount of the namespace is used. Pods without a token cannot use it, but its `imagePullSecrets` are
  merged in if the orchestrator Pod had none. Do not grant the `default` ServiceAccount rights.
- The policy protects only if the API server enforces it. With `probePodPolicy.enabled=false`, or a cluster with the
  admission API off, the original exposure returns in full: `create pods` reads every Secret of the namespace.
- Someone with rights on `validatingadmissionpolicies` can remove it; that is a cluster-admin right, outside this threat.
- The image check pins the string of the chart. An orchestrator started with another image string (a hand-edited
  Deployment) cannot run its probe until the chart is applied again.
