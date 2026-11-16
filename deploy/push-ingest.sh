#!/usr/bin/env bash
# Bundle ingest (with its workspace dependency session-core) into ConfigMap `ingest-code`, which the
# pi-ingest Deployment unpacks in an initContainer. No image is built or pushed. Restarts the pods when the
# bundle changed. Usage: deploy/push-ingest.sh
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
work=$(mktemp -d)
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
trap 'rm -rf "$work"' EXIT

(cd "$root" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter @pi-durable-k8s/session-core --filter @pi-durable-k8s/ingest build >/dev/null)
(cd "$root" && pnpm --filter @pi-durable-k8s/ingest deploy --prod "$work/app" >/dev/null)
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$work/app.tgz" -C "$work/app" .
size=$(wc -c <"$work/app.tgz" | tr -d ' ')
if [[ $size -gt 900000 ]]; then
  echo "ingest bundle is $size bytes; a ConfigMap holds 1 MiB. Switch to a code PVC (see deploy/ingest.yaml)." >&2
  exit 1
fi

sum=$(shasum -a 256 "$work/app.tgz" | awk '{print $1}')
current=$(k get configmap ingest-code -o jsonpath='{.metadata.annotations.bundle-sha256}' 2>/dev/null || true)
if [[ $current == "$sum" ]]; then
  echo "ingest bundle unchanged"
  exit 0
fi
k create configmap ingest-code --from-file=app.tgz="$work/app.tgz" --dry-run=client -o yaml |
  k annotate --local -f - "bundle-sha256=$sum" -o yaml | k apply -f - >/dev/null
if k get deployment pi-ingest >/dev/null 2>&1; then
  k rollout restart deployment/pi-ingest >/dev/null
fi
echo "ingest bundle pushed ($size bytes)"
