#!/usr/bin/env bash
# Bundle the orchestrator and copy it onto the orchestrator-code PVC, so the stock node image can run it and
# a pod restart keeps the code. No image is built or pushed. The orchestrator Deployment (if present) is
# scaled to 0 while the volume is written, because a ReadWriteOnce volume is mounted by one node at a time.
# Usage: deploy/push-code.sh [deployment...]   (default: pi-orchestrator; scaled back to 1 afterwards)
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
work=$(mktemp -d)
deployments=("$@")
[[ ${#deployments[@]} -gt 0 ]] || deployments=(pi-orchestrator)
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
trap 'rm -rf "$work"; k delete pod orchestrator-code-loader --ignore-not-found --wait=false >/dev/null 2>&1 || true' EXIT

(cd "$root" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter "@pi-durable-k8s/orchestrator..." build >/dev/null)
(cd "$root" && pnpm --filter @pi-durable-k8s/orchestrator deploy --prod "$work/app" >/dev/null)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$work/app.tgz" -C "$work/app" .

k apply -f "$here/orchestrator-code-pvc.yaml" >/dev/null
for d in "${deployments[@]}"; do
  k get deployment "$d" >/dev/null 2>&1 && k scale deployment "$d" --replicas=0 >/dev/null
done
for d in "${deployments[@]}"; do
  k wait --for=delete pod -l "app.kubernetes.io/instance=$d" --timeout=120s >/dev/null 2>&1 || true
done

k delete pod orchestrator-code-loader --ignore-not-found --wait=true >/dev/null
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: orchestrator-code-loader
spec:
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: loader
      image: node:22-bookworm-slim
      command: [sleep, "600"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      resources:
        requests: { cpu: 10m, memory: 32Mi }
        limits: { cpu: 100m, memory: 128Mi }
      volumeMounts: [{ name: code, mountPath: /code }]
  volumes:
    - name: code
      persistentVolumeClaim: { claimName: orchestrator-code }
EOF
k wait --for=condition=Ready pod/orchestrator-code-loader --timeout=240s >/dev/null
k cp "$work/app.tgz" orchestrator-code-loader:/tmp/app.tgz >/dev/null
k exec orchestrator-code-loader -- sh -c 'rm -rf /code/app && mkdir -p /code/app && tar xzf /tmp/app.tgz -C /code/app && ls /code/app/dist/main.js >/dev/null'
k delete pod orchestrator-code-loader --wait=true >/dev/null

for d in "${deployments[@]}"; do
  k get deployment "$d" >/dev/null 2>&1 && k scale deployment "$d" --replicas=1 >/dev/null
done
echo "orchestrator code pushed to PVC orchestrator-code"
