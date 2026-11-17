#!/usr/bin/env bash
# One command from nothing to a running pi-durable on a local kind cluster (docs/install-plan.md section 7, D9):
#
#   hack/kind-up.sh [--name pi-durable] [--namespace pi-durable] [--build] [--onecli] [--timeout 10m]
#
#   1. checks docker, kind (>= 0.24: kindnet enforces NetworkPolicy from there), helm, kubectl and openssl
#   2. creates the kind cluster (hack/kind-config.yaml: pinned node image, kindnet); an existing cluster of that name is
#      reused, so a second run upgrades the install
#   3. images: published ones from ghcr.io/gscode1 (default: the tag build.sh gives HEAD, 0.0.0-<short sha>), or with
#      --build built here for the native architecture and loaded into the node
#   4. hack/agent-sandbox.sh bundled (controller and CRDs; skipped when they exist)
#   5. the namespace, random Secrets (never printed) and charts/pi-postgres
#   6. hack/install.sh with charts/pi-durable/values-kind.yaml: runc (allowInsecureRuntime), kindnet with the standard
#      network policies, OneCLI disabled (or, with --onecli, bundled: install.sh runs hack/onecli.sh first), the scripted
#      model only
#   7. prints the isolation probe (hack/kind-smoke.sh --status), where the API token is and how to port-forward
#
# --onecli installs the bundled OneCLI (docs/decisions/0022-bundled-onecli.md) with its externalUrl http://localhost:10254, for
# a port-forward trial. It needs the OneCLI images from ghcr.io/onecli (the node pulls them) and adds three to five minutes. The
# scripted model still needs no credential; hack/kind-smoke.sh --onecli proves a session's orchestrator routes through the
# gateway. A real model: docs/model-credentials.md.
#
# Images: IMAGE_TAG (default as above) applies to all three; ORCH_IMAGE, INGEST_IMAGE and SANDBOX_IMAGE (a tag or digest
# reference, for example ghcr.io/gscode1/pi-ingest@sha256:...) override one image. IMAGE_REPO (default ghcr.io/gscode1)
# is the registry prefix. NETPOL_ENFORCED=1 fails the run unless the isolation probe says enforced (CI sets it).
# Run the smoke test afterwards: hack/kind-smoke.sh. Remove everything: hack/kind-down.sh.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=${KIND_CLUSTER_NAME:-pi-durable}
namespace=pi-durable
timeout=10m
build=0
onecli=0
repo=${IMAGE_REPO:-ghcr.io/gscode1}
min_kind=0.24.0

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--build] [--onecli] [--timeout 10m]" >&2
  echo "  env: IMAGE_TAG, ORCH_IMAGE, INGEST_IMAGE, SANDBOX_IMAGE, IMAGE_REPO, NETPOL_ENFORCED=1" >&2
  exit 64
}
die() {
  echo "kind-up: $*" >&2
  exit 1
}
t0=$SECONDS
log() { printf '\n## %s (%ss)\n' "$*" "$((SECONDS - t0))"; }

while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --build) build=1; shift ;;
  --onecli) onecli=1; shift ;;
  --timeout) [[ $# -ge 2 ]] || usage; timeout=$2; shift 2 ;;
  -h | --help) usage ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad namespace '$namespace'"

# ------------------------------------------------------------------ 1. tools
log "check the tools"
for tool in docker kind helm kubectl openssl curl; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"
# "kind v0.33.0 go1.27.1 darwin/arm64" -> 0.33.0; sort -V is not in macOS's sort, so compare the numbers.
kind_version=$(kind version | sed -n 's/^kind v\([0-9][0-9.]*\).*/\1/p')
[[ -n $kind_version ]] || die "cannot read the kind version from: $(kind version)"
version_ge() { # a b -> a >= b, both x.y.z
  local IFS=. a b i
  read -ra a <<<"$1"
  read -ra b <<<"$2"
  for i in 0 1 2; do
    if ((${a[i]:-0} > ${b[i]:-0})); then return 0; fi
    if ((${a[i]:-0} < ${b[i]:-0})); then return 1; fi
  done
  return 0
}
version_ge "$kind_version" "$min_kind" ||
  die "kind $kind_version is too old: kindnet enforces NetworkPolicy only since $min_kind, and the isolation probe would fail. Upgrade kind."
echo "kind $kind_version, $(helm version --short), kubectl $(kubectl version --client -o json | sed -n 's/.*"gitVersion": "\([^"]*\)".*/\1/p' | head -1)"

ctx=kind-$name
k() { kubectl --context "$ctx" "$@"; }

# ------------------------------------------------------------------ 3. image references (before the cluster exists: a bad ref fails early)
version=$(node -p "JSON.parse(require('node:fs').readFileSync('$root/package.json', 'utf8')).version" 2>/dev/null || echo 0.0.0)
tag=${IMAGE_TAG:-$version-$(git -C "$root" rev-parse --short HEAD)}
ref_orchestrator=${ORCH_IMAGE:-$repo/pi-orchestrator:$tag}
ref_ingest=${INGEST_IMAGE:-$repo/pi-ingest:$tag}
ref_sandbox=${SANDBOX_IMAGE:-$repo/pi-sandbox:$tag}
set_args=()
extra_args=()
[[ $onecli -eq 0 ]] || extra_args+=(--set onecli.mode=bundled)
add_image_sets() { # key ref: --set images.<key>.repository/tag/digest from a "repo:tag" or "repo@sha256:..." reference
  local key=$1 ref=$2 repository tag="" digest=""
  case $ref in
  *@sha256:*) digest=sha256:${ref##*@sha256:}; repository=${ref%%@sha256:*} ;;
  *) repository=$ref ;;
  esac
  # A tag is what follows the last colon, unless that colon belongs to a registry port (a slash follows it).
  if [[ ${repository##*/} == *:* ]]; then
    tag=${repository##*:}
    repository=${repository%:*}
  fi
  [[ -n $repository && ( -n $tag || -n $digest ) ]] || die "bad image reference '$ref' (need repo:tag or repo@sha256:...)"
  set_args+=(--set "images.$key.repository=$repository" --set "images.$key.tag=$tag" --set "images.$key.digest=$digest")
}
add_image_sets orchestrator "$ref_orchestrator"
add_image_sets ingest "$ref_ingest"
add_image_sets sandbox "$ref_sandbox"
manifest_ok() { # the registry can be slow: three tries
  for _ in 1 2 3; do
    docker manifest inspect "$1" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
if [[ $build -eq 0 ]]; then
  # Fail now, not after a 3 minute install, when the images were not published for this commit.
  for ref in "$ref_orchestrator" "$ref_ingest" "$ref_sandbox"; do
    manifest_ok "$ref" ||
      die "image $ref cannot be pulled. Set IMAGE_TAG (or ORCH_IMAGE, INGEST_IMAGE, SANDBOX_IMAGE) to published images, or use --build to build them here."
  done
fi

# ------------------------------------------------------------------ 2. the cluster
log "kind cluster $name"
if kind get clusters 2>/dev/null | grep -qx -- "$name"; then
  echo "cluster $name exists, reused"
else
  kind create cluster --name "$name" --config "$root/hack/kind-config.yaml" --wait 180s
fi
# Everything below names its context. The current context of the user's kubeconfig is never used.
k get nodes >/dev/null || die "cannot reach the cluster through context $ctx"

# ------------------------------------------------------------------ 3. images
if [[ $build -eq 1 ]]; then
  log "build the images (native architecture) and load them into the node"
  case $(uname -m) in aarch64 | arm64) platform=linux/arm64 ;; *) platform=linux/amd64 ;; esac
  for image in orchestrator ingest sandbox; do
    IMAGE_REPO=$repo "$root/images/build.sh" "$image" --platform "$platform" >/dev/null
  done
  # build.sh names them <repo>/pi-<image>:<version>-<short sha>; the install refs must be exactly those.
  built=$version-$(git -C "$root" rev-parse --short HEAD)
  for image in orchestrator ingest sandbox; do
    kind load docker-image "$repo/pi-$image:$built" --name "$name"
  done
  set_args=()
  for image in orchestrator ingest sandbox; do
    add_image_sets "$image" "$repo/pi-$image:$built"
  done
  # IfNotPresent would be enough, Never makes a missing load a clear error instead of a pull of a tag nobody published.
  for image in orchestrator ingest sandbox; do set_args+=(--set "images.$image.pullPolicy=Never"); done
fi

# ------------------------------------------------------------------ 4. agent-sandbox
log "agent-sandbox"
if [[ -n $(k get crd sandboxes.agents.x-k8s.io --ignore-not-found -o name) ]]; then
  KUBE_CONTEXT=$ctx "$root/hack/agent-sandbox.sh" external
else
  KUBE_CONTEXT=$ctx "$root/hack/agent-sandbox.sh" bundled
fi

# ------------------------------------------------------------------ 5. namespace, secrets, postgres
log "namespace $namespace and the bundled Postgres"
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
if [[ -z $(k get namespace "$namespace" --ignore-not-found -o name) ]]; then
  # The Pod Security version is the one hack/install.sh pins; read from there so there is one place to change it.
  ps_version=$(sed -n 's/.*pod-security.kubernetes.io\/enforce-version: //p' "$root/hack/install.sh" | head -1)
  [[ -n $ps_version ]] || die "cannot read the Pod Security version from hack/install.sh"
  k create namespace "$namespace" >/dev/null
  labels=()
  for level in enforce warn audit; do
    labels+=("pod-security.kubernetes.io/$level=restricted" "pod-security.kubernetes.io/$level-version=$ps_version")
  done
  k label namespace "$namespace" "${labels[@]}" >/dev/null
  echo "namespace $namespace created, with the restricted Pod Security labels"
fi
kn() { k -n "$namespace" "$@"; }
if [[ -z $(kn get secret pi-postgres-auth --ignore-not-found -o name) ]]; then
  # Values go through files, never argv (visible in ps) or stdout. Existing Secrets are never regenerated.
  for key in postgres-password pi-password onecli-password; do
    openssl rand -hex 24 | tr -d '\n' >"$tmp/$key"
  done
  kn create secret generic pi-postgres-auth --from-file=postgres-password="$tmp/postgres-password" \
    --from-file=pi-password="$tmp/pi-password" --from-file=onecli-password="$tmp/onecli-password" >/dev/null
  echo "pi-postgres-auth: created (random passwords)"
else
  echo "pi-postgres-auth: exists, kept"
fi
helm --kube-context "$ctx" upgrade --install pi-postgres "$root/charts/pi-postgres" --namespace "$namespace" \
  --set persistence.storageClass=standard --set persistence.size=2Gi --wait --timeout "$timeout"

# The URI of the app's database for install.sh, which creates the Secret pi-database once (and keeps an existing one).
pi_password=$(kn get secret pi-postgres-auth -o jsonpath='{.data.pi-password}' | base64 -d)
DATABASE_URL="postgres://pi:$pi_password@pi-postgres.$namespace.svc:5432/pi"
export DATABASE_URL

# ------------------------------------------------------------------ 6. pi-durable
log "install pi-durable (hack/install.sh)"
KUBE_CONTEXT=$ctx "$root/hack/install.sh" --namespace "$namespace" --values "$root/charts/pi-durable/values-kind.yaml" \
  ${set_args[@]+"${set_args[@]}"} ${extra_args[@]+"${extra_args[@]}"} --timeout "$timeout"
unset DATABASE_URL pi_password

# ------------------------------------------------------------------ 7. report
log "isolation probe"
"$root/hack/kind-smoke.sh" --name "$name" --namespace "$namespace" --status

total=$((SECONDS - t0))
cat <<TXT

## pi-durable is running on kind cluster $name (context $ctx), $((total / 60))m$((total % 60))s

The API token (owner admin) is in the Secret api-auth, key tokens, as lines of owner:token. It was not printed:

  kubectl --context $ctx -n $namespace get secret api-auth -o jsonpath='{.data.tokens}' | base64 -d | sed -n 's/^admin://p'

Reach the session API on localhost:8080:

  kubectl --context $ctx -n $namespace port-forward svc/pi-ingest 8080:8080

Smoke test:   hack/kind-smoke.sh --name $name --namespace $namespace
Remove it:    hack/kind-down.sh --name $name

This is a trial: sandboxes run under runc, not gVisor, and only the scripted model is available (the message text is the
script, see docs/session-api.md). A real model needs OneCLI: rerun with --onecli (docs/model-credentials.md).
TXT
if [[ $onecli -eq 1 ]]; then
  cat <<TXT

Bundled OneCLI runs in $namespace; its API and dashboard have no Ingress and only the orchestrator reaches the API.
Prove that the orchestrator routes through the gateway:  hack/kind-smoke.sh --name $name --namespace $namespace --onecli
Sign in to the dashboard (two port-forwards; the login is in the Secret pi-onecli-admin and is not printed):

  kubectl --context $ctx -n $namespace port-forward svc/onecli-web 10254:10254 &
  kubectl --context $ctx -n $namespace port-forward svc/onecli-api 10256:10256 &
  open http://localhost:10254/auth/login
  kubectl --context $ctx -n $namespace get secret pi-onecli-admin -o jsonpath='{.data.email}' | base64 -d; echo
  kubectl --context $ctx -n $namespace get secret pi-onecli-admin -o jsonpath='{.data.password}' | base64 -d | pbcopy   # or xclip

Then connect a provider there (docs/model-credentials.md) and set models in your values to use it.
TXT
fi
