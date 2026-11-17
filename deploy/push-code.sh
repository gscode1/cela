#!/usr/bin/env bash
# Bundle the orchestrator and copy it onto the orchestrator-code PVC, so the stock node image can run it and
# a pod restart keeps the code. No image is built or pushed. The orchestrator Deployment (if present) is
# scaled to 0 while the volume is written, because a ReadWriteOnce volume is mounted by one node at a time.
# NAMESPACE (default pi-durable-poc) picks the target; every e2e run passes its own pi-e2e-<id>.
# Usage: deploy/push-code.sh [deployment...]
#   Default: every orchestrator shard (the Deployments labelled app.kubernetes.io/name=pi-orchestrator, ADR 0017), one
#   push for all, because they share the code volume. Each is scaled back to the replica count it had, and to at
#   least 1: a push starts every shard it stopped. Named deployments are scaled back to 1.
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
work=$(mktemp -d)
deployments=("$@")
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
scaled=()   # deployments this run scaled to 0; the trap restores exactly these
restore=()  # their replica counts, same order
lock=orchestrator-code-push-lock
# shellcheck source=push-lock.sh
. "$here/push-lock.sh"
# shellcheck source=push-retry.sh
. "$here/push-retry.sh"
# Which shards to stop. A failed listing must abort: falling back to pi-orchestrator alone would replace the shared code
# under shards that keep running. The fallback is only for a successful listing that came back empty.
if [[ ${#deployments[@]} -eq 0 ]]; then
  listing=$(push_retry k get deployment -l app.kubernetes.io/name=pi-orchestrator -o name) || {
    rm -rf "$work"
    echo "could not list the orchestrator Deployments; nothing was changed" >&2
    exit 1
  }
  while IFS= read -r d; do [[ -z $d ]] || deployments+=("${d#deployment.apps/}"); done <<<"$listing"
  [[ ${#deployments[@]} -gt 0 ]] || deployments=(pi-orchestrator)
fi
echo "orchestrator deployments: ${deployments[*]}" >&2
locked=0 # 1 only when this run created the lock; the trap must never touch another run's lock or loader
# Runs on every exit path: a failed wait, cp or extract must not leave the orchestrator at 0 replicas.
cleanup() {
  local d i
  rm -rf "$work"
  if [[ $locked -eq 1 ]]; then
    k delete pod orchestrator-code-loader --ignore-not-found --wait=false >/dev/null 2>&1 || true
    # Index loop: macOS bash 3.2 has no ${!array[@]} for an empty array under set -u, and ${!name+...} is indirection.
    for ((i = 0; i < ${#scaled[@]}; i++)); do
      d=${scaled[$i]}
      k scale deployment "$d" --replicas="${restore[$i]}" >/dev/null || echo "could not scale $d back to ${restore[$i]}; run: kubectl -n $ns scale deployment $d --replicas=${restore[$i]}" >&2
    done
    push_lock_release || true
  fi
}
trap cleanup EXIT

(cd "$root" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter "@pi-durable-k8s/orchestrator..." build >/dev/null)
(cd "$root" && pnpm --filter @pi-durable-k8s/orchestrator deploy --prod "$work/app" >/dev/null)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$work/app.tgz" -C "$work/app" .

# Create-if-absent is atomic, so it is the lock: a second push stops here instead of deleting this run's loader.
# An expired lock (crashed run, failed delete) is taken over with a resourceVersion precondition.
push_lock_acquire || exit 1
locked=1
# Create the code PVC only when it is missing, never re-apply it: an overlay may have set its storage class, and an
# apply of the base (which names none) would try to remove that immutable field and fail.
if ! err=$(k get pvc orchestrator-code -o name 2>&1 >/dev/null); then
  if [[ $err != *NotFound* ]]; then
    echo "could not look up PVC orchestrator-code: $err" >&2
    exit 1
  fi
  k create -f "$here/orchestrator-code-pvc.yaml" >/dev/null
fi
for d in "${deployments[@]}"; do
  if k get deployment "$d" >/dev/null 2>&1; then
    scaled+=("$d")
    n=$(k get deployment "$d" -o jsonpath='{.spec.replicas}')
    restore+=("$((${n:-1} > 1 ? n : 1))")
    k scale deployment "$d" --replicas=0 >/dev/null
  fi
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
# cp and exec are retried on a connection reset (the lock stays held). Both can be redone: cp overwrites
# /tmp/app.tgz, and the script below starts by clearing app.new and app.old, then swaps by rename.
push_retry k cp "$work/app.tgz" orchestrator-code-loader:/tmp/app.tgz >/dev/null
# Extract beside the live tree and swap only after the entry point exists, so a failed extract leaves the old
# code in place. Same volume, so each mv is a rename.
push_retry k exec orchestrator-code-loader -- sh -c 'set -e
rm -rf /code/app.new /code/app.old
mkdir -p /code/app.new
tar xzf /tmp/app.tgz -C /code/app.new
ls /code/app.new/dist/main.js >/dev/null
if [ -e /code/app ]; then mv /code/app /code/app.old; fi
mv /code/app.new /code/app
rm -rf /code/app.old'
k delete pod orchestrator-code-loader --wait=true >/dev/null
# The EXIT trap scales the deployments back to 1.
echo "orchestrator code pushed to PVC orchestrator-code"
