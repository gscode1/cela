#!/usr/bin/env bash
# Delete the kind cluster hack/kind-up.sh created (the name is the same default): everything in it goes, including the
# database and the workspaces. Only a kind cluster is touched, never another kubeconfig context.
#
#   hack/kind-down.sh [--name cela]      (or KIND_CLUSTER_NAME)
set -euo pipefail

name=${KIND_CLUSTER_NAME:-cela}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || { echo "usage: ${0##*/} [--name CLUSTER]" >&2; exit 64; }; name=$2; shift 2 ;;
  *) echo "usage: ${0##*/} [--name CLUSTER]" >&2; exit 64 ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || { echo "kind-down: bad cluster name '$name'" >&2; exit 1; }
command -v kind >/dev/null 2>&1 || { echo "kind-down: kind is required" >&2; exit 1; }

if kind get clusters 2>/dev/null | grep -qx -- "$name"; then
  kind delete cluster --name "$name"
else
  echo "kind cluster '$name' does not exist; nothing to do"
fi
