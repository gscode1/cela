#!/usr/bin/env bash
# Install or check agent-sandbox (controller + CRDs), which are cluster-wide.
#
#   hack/agent-sandbox.sh bundled   install the pinned release if none of its CRDs exist
#   hack/agent-sandbox.sh external  read-only check of an existing install
#
# KUBE_CONTEXT selects the kubectl context (unset: the current one). This script never
# upgrades, adopts, patches or deletes an existing controller or CRD: deleting a CRD deletes
# every Sandbox and, through claims, workspace PVCs (docs/install-plan.md, D5).
set -euo pipefail

# Pinned release. The single asset holds all four CRDs and the controller. Its sha256 is
# also the digest GitHub shows for the release asset. The vendored SDK targets the same tag
# (packages/vendor/agent-sandbox-client/VENDORED.md). Upgrade only on purpose.
VERSION=v1.0.11
MANIFEST_URL=${AGENT_SANDBOX_MANIFEST_URL:-https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$VERSION/sandbox-with-extensions.yaml}
MANIFEST_SHA256=${AGENT_SANDBOX_MANIFEST_SHA256:-6c749a5b667ccc533d6ee8a593ea5a5ded37bca90fff0e9ed64c69973609e236}
CONTROLLER_NS=agent-sandbox-system
CONTROLLER_DEPLOYMENT=agent-sandbox-controller
CONTROLLER_LABEL=app=agent-sandbox-controller
API_VERSION=v1beta1
# group|plural|kind
KINDS=(
  "agents.x-k8s.io|sandboxes|Sandbox"
  "extensions.agents.x-k8s.io|sandboxclaims|SandboxClaim"
  "extensions.agents.x-k8s.io|sandboxtemplates|SandboxTemplate"
  "extensions.agents.x-k8s.io|sandboxwarmpools|SandboxWarmPool"
)

usage() {
  echo "usage: ${0##*/} bundled|external   (KUBE_CONTEXT selects the cluster)" >&2
  exit 64
}
die() {
  echo "agent-sandbox: $*" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
mode=$1
tmp=
[[ $mode == bundled || $mode == external ]] || usage

kube_args=()
if [[ -n ${KUBE_CONTEXT:-} ]]; then
  kube_args=(--context "$KUBE_CONTEXT")
fi
k() { kubectl ${kube_args[@]+"${kube_args[@]}"} "$@"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# Is the version served for this kind? A 404 from the API server means it is not.
served() {
  local group=$1 plural=$2
  k get --raw "/apis/$group/$API_VERSION" 2>/dev/null | grep -Eq "\"name\": *\"$plural\""
}

bundled() {
  local existing=() entry group plural crd found
  for entry in "${KINDS[@]}"; do
    IFS='|' read -r group plural _ <<<"$entry"
    crd=$plural.$group
    # Assigned on its own line so an unreachable cluster aborts instead of reading as "absent".
    found=$(k get crd "$crd" --ignore-not-found -o name)
    if [[ -n $found ]]; then
      existing+=("$crd")
    fi
  done
  if [[ ${#existing[@]} -gt 0 ]]; then
    {
      echo "agent-sandbox: refusing to install, these CRDs already exist:"
      printf '  %s\n' "${existing[@]}"
      echo "Nothing was changed. This script never upgrades, adopts or deletes an existing"
      echo "controller or its CRDs. Use 'external' mode to check the existing install."
    } >&2
    exit 1
  fi

  # Global, not local: the EXIT trap runs after this function has returned.
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading $MANIFEST_URL"
  curl -fsSL --retry 3 -o "$tmp/manifest.yaml" "$MANIFEST_URL" || die "download failed: $MANIFEST_URL"
  local actual
  actual=$(sha256_of "$tmp/manifest.yaml")
  if [[ $actual != "$MANIFEST_SHA256" ]]; then
    die "checksum mismatch for $MANIFEST_URL: expected $MANIFEST_SHA256, got $actual. Nothing was applied."
  fi

  echo "applying agent-sandbox $VERSION (server-side)"
  k apply --server-side --field-manager=cela-install -f "$tmp/manifest.yaml"
  for entry in "${KINDS[@]}"; do
    IFS='|' read -r group plural _ <<<"$entry"
    k wait --for=condition=Established --timeout=60s "crd/$plural.$group"
  done
  k -n "$CONTROLLER_NS" wait --for=condition=Available --timeout=300s "deployment/$CONTROLLER_DEPLOYMENT"
  echo "agent-sandbox $VERSION is installed and the controller is available"
}

external() {
  local missing=() entry group plural kind
  for entry in "${KINDS[@]}"; do
    IFS='|' read -r group plural kind <<<"$entry"
    served "$group" "$plural" || missing+=("$kind ($group/$API_VERSION)")
  done
  if [[ ${#missing[@]} -gt 0 ]]; then
    {
      echo "agent-sandbox: $API_VERSION is not served for:"
      printf '  %s\n' "${missing[@]}"
      echo "Nothing was changed. Install it with '${0##*/} bundled' on a cluster without these CRDs,"
      echo "or upgrade the existing agent-sandbox to $VERSION or newer."
    } >&2
    exit 1
  fi

  local available
  available=$(k get deployments -A -l "$CONTROLLER_LABEL" \
    -o 'jsonpath={range .items[*]}{.status.availableReplicas}{"\n"}{end}')
  if [[ -z $available ]]; then
    echo "warning: no controller Deployment with label $CONTROLLER_LABEL found; cannot tell whether one runs" >&2
  elif ! grep -Eq '^[1-9]' <<<"$available"; then
    die "the controller Deployment ($CONTROLLER_LABEL) has no available replicas"
  fi
  echo "agent-sandbox: $API_VERSION is served for all four kinds"
}

"$mode"
