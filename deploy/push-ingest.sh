#!/usr/bin/env bash
# Bundle ingest (with its workspace dependency session-core) into ConfigMap `ingest-code`, which the
# pi-ingest Deployment unpacks in an initContainer. No image is built or pushed. Restarts the pods when the
# bundle changed. NAMESPACE (default pi-durable-poc) picks the target; every e2e run passes its own pi-e2e-<id>.
# Usage: deploy/push-ingest.sh
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
# Deterministic archive (sorted names, fixed mtime and owner, no gzip timestamp): unchanged code must hash the
# same, or every push would restart the pods.
find "$work/app" -exec touch -h -t 200001010000 {} +
(cd "$work/app" && find . | LC_ALL=C sort >"$work/files.txt")
if tar --version 2>/dev/null | grep -q bsdtar; then owner=(--uid 0 --gid 0 --uname '' --gname ''); else owner=(--owner=0 --group=0); fi
COPYFILE_DISABLE=1 tar --no-xattrs --no-recursion --numeric-owner "${owner[@]}" -cf - -C "$work/app" -T "$work/files.txt" | gzip -n >"$work/app.tgz"
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
# replace (create when missing), never apply: apply copies the whole object, bundle included, into the
# last-applied-configuration annotation, which is capped at 256 KiB, far below the 1 MiB ConfigMap limit.
k create configmap ingest-code --from-file=app.tgz="$work/app.tgz" --dry-run=client -o yaml |
  k annotate --local -f - "bundle-sha256=$sum" -o yaml >"$work/cm.yaml"
if k get configmap ingest-code >/dev/null 2>&1; then
  k replace -f "$work/cm.yaml" >/dev/null
else
  k create -f "$work/cm.yaml" >/dev/null
fi
# Only "NotFound" means there is nothing to restart; any other failure must not look like a pushed bundle.
if err=$(k get deployment pi-ingest -o name 2>&1 >/dev/null); then
  k rollout restart deployment/pi-ingest >/dev/null
elif [[ $err == *NotFound* ]]; then
  echo "deployment pi-ingest not found; nothing to restart" >&2
else
  # Clear the annotation so a re-run does not report "unchanged" and skip the restart.
  k annotate configmap ingest-code bundle-sha256- >/dev/null 2>&1 || true
  echo "could not look up deployment pi-ingest: $err" >&2
  exit 1
fi
echo "ingest bundle pushed ($size bytes)"
