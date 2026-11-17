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
# shellcheck source=push-retry.sh
. "$here/push-retry.sh"
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
# The bundle goes in without the bundle-sha256 annotation (replace drops the old one), and the annotation is added only
# once the pods restart onto it. Any failure in between, cleanup included, leaves no marker, so a re-run pushes again.
k create configmap ingest-code --from-file=app.tgz="$work/app.tgz" --dry-run=client -o yaml >"$work/cm.yaml"
# replace is retried on a connection reset: it sends the same full object, so repeating it is harmless.
# create is not retried, because a repeat after a lost reply would fail with AlreadyExists.
if k get configmap ingest-code >/dev/null 2>&1; then
  push_retry k replace -f "$work/cm.yaml" >/dev/null
else
  k create -f "$work/cm.yaml" >/dev/null
fi
# Only "NotFound" means there is nothing to restart; any other failure must not look like a pushed bundle.
if err=$(k get deployment pi-ingest -o name 2>&1 >/dev/null); then
  # Retried on a connection reset: the restart patches a timestamp annotation, so a repeat is harmless.
  if ! push_retry k rollout restart deployment/pi-ingest >/dev/null; then
    echo "could not restart deployment pi-ingest; the bundle is in ConfigMap ingest-code but the pods still run the old code" >&2
    exit 1
  fi
elif [[ $err == *NotFound* ]]; then
  echo "deployment pi-ingest not found; nothing to restart" >&2
else
  echo "could not look up deployment pi-ingest: $err" >&2
  exit 1
fi
# A lost marker only costs a redundant push and restart next time.
if ! push_retry k annotate configmap ingest-code --overwrite "bundle-sha256=$sum" >/dev/null; then
  echo "WARNING: could not record bundle-sha256; the next push will push and restart again" >&2
fi
echo "ingest bundle pushed ($size bytes)"
