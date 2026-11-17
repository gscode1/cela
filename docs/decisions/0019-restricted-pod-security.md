# 0019: Our namespaces enforce the restricted Pod Security level

Status: accepted, 2026-11-17 (issue #96). Builds on [0004](0004-idle-suspend.md) (suspend and resume of a Sandbox) and
[0013](0013-e2e-namespace-per-run.md) (a namespace per e2e run).

## Context

No Pod of ours needs privileges, but nothing enforced that. A server-side dry run against `restricted` on the poc cluster
(Kubernetes v1.36.2) found one violation: the sandbox template had no `seccompProfile`. `tests/e2e/runner-pod.yaml` lacked it
too.

## Why we can be unprivileged

- The sandbox isolation is gVisor, chosen by `runtimeClassName: gvisor` in the pod spec. The runtime is installed on the
  node (outside our namespaces); the Pod itself asks for no capability, no host access and no privileged mode.
- The workspace is a PVC from a CSI storage class. No `hostPath`, no node-level mounts.
- The orchestrator and the ingest Deployments only call the Kubernetes API and Postgres. The controller (agent-sandbox)
  creates the sandbox Pods; we never run a Pod that manages containers or networking.
- Every container already ran as non-root (uid 1000) with `allowPrivilegeEscalation: false` and `capabilities.drop: [ALL]`.

## Decision

- `deploy/namespace.yaml` and the namespace that `tests/e2e/run.sh` creates (or reuses) carry
  `pod-security.kubernetes.io/{enforce,warn,audit}=restricted` and `...-version=v1.36`. The version is pinned to the cluster's
  minor version, not `latest`, so a cluster upgrade does not tighten the rules unnoticed; moving it is a deliberate change.
- Every pod spec we ship sets `seccompProfile: RuntimeDefault` (pod level), and every container sets
  `allowPrivilegeEscalation: false`, drops ALL capabilities and runs as non-root. No host namespaces, host ports or
  `hostPath`; only `configMap`, `csi`, `downwardAPI`, `emptyDir`, `ephemeral`, `persistentVolumeClaim`, `projected` and
  `secret` volumes.
- `packages/orchestrator/test/pod-security.test.ts` enforces this. It reads every file under `deploy/` and `tests/e2e/`
  (whole YAML and `.tpl` files; the heredoc bodies of `.sh` and `.mjs` files), counts the lines `kind: Pod|Job|CronJob|
  Deployment|StatefulSet|DaemonSet|ReplicaSet|SandboxTemplate|Sandbox`, parses them, and fails if a kind line does not come out as a
  parsed manifest (so a new manifest cannot hide) or if any container, init container or pod spec breaks the rules. It also
  checks the namespace labels and that no TypeScript code builds a pod spec (the orchestrator only creates
  SandboxClaims; the Pod comes from the template).

## What PSA does not cover

Admission applies per namespace. Workloads in other namespaces are outside it and are not changed here: the agent-sandbox
controller, the CloudNativePG operator, OneCLI, and the gVisor node setup. The CNPG Cluster in our namespace is different:
its Pods are created by the operator but land in our namespace, so they are subject to the enforcement (the operator's
default pod spec is restricted-compatible in current releases; not verified by a test here, and the live rollout is the
check).

## Existing Sandboxes keep the old pod spec

A Sandbox stores its own copy of the template in `spec.podTemplate`. Suspend (0004) deletes the Pod, and a resume creates a
new Pod from that stored copy, not from the current SandboxTemplate. A Sandbox created before the seccomp change therefore
recreates a Pod without `seccompProfile`, and an enforcing namespace rejects that Pod; the Sandbox then never becomes Ready.

Order of a rollout on a cluster that has Sandboxes:

1. Apply the template change (`kubectl apply -k deploy` with the namespace labels still absent, or only `warn`/`audit`).
2. Remove existing SandboxClaims/Sandboxes (or patch `spec.podTemplate.spec.securityContext.seccompProfile` in each), so
   they are recreated from the new template. Deleting a claim deletes its workspace PVC: only do it where that data is
   expendable (the poc cluster; the owner approved it for issue #96).
3. Apply the namespace labels (`enforce`).

Any later change to the template's security settings needs the same step 2 before it is enforced.
