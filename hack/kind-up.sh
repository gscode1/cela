#!/usr/bin/env bash
# One command from nothing to a running pi-durable on a local kind cluster (docs/install-plan.md section 7, D9):
#
#   hack/kind-up.sh [--name pi-durable] [--namespace pi-durable] [--build] [--onecli] [--egress-proxy] [--no-expose]
#                   [--cni kindnet|cilium] [--set key=value]... [--timeout 10m] [--verbose]
#
# Output: one line per step; what the steps print (kind, helm, kubectl, the sub-scripts) goes to a log file and is shown
# only when a step fails (its last lines and the log's path). --verbose, or CI set in the environment, streams all of it.
#
#   1. checks docker, kind (>= 0.24: kindnet enforces NetworkPolicy from there), helm, kubectl and openssl
#   2. creates the kind cluster (hack/kind-config.yaml: pinned node image, kindnet, and port mappings that publish the
#      session API on localhost:8080 and, with --onecli, the OneCLI dashboard and API on localhost:10254 and :10256); an
#      existing cluster of that name is reused, so a second run upgrades the install. Port mappings exist only at creation:
#      a cluster that lacks them is refused (kind-down first, or --no-expose)
#   3. images: published ones from ghcr.io/gscode1 (default: the tag build.sh gives HEAD, 0.0.0-<short sha>), or with
#      --build built here for the native architecture and loaded into the node
#   4. hack/agent-sandbox.sh bundled (controller and CRDs; skipped when they exist)
#   5. the namespace, random Secrets (never printed) and charts/pi-postgres
#      Expose (default): ingest.expose and OneCLI's expose add NodePort Services (externalTrafficPolicy Local) and one
#      NetworkPolicy source each: the IPv4 gateway of the Docker network `kind`, as a /32 (docker network inspect),
#      which is where the host's localhost connections arrive from. Sandboxes are not admitted
#      (docs/decisions/0022-bundled-onecli.md, addendum). --no-expose: no mappings, no Services, port-forward as before
#   6. hack/install.sh with charts/pi-durable/values-kind.yaml: runc (allowInsecureRuntime), kindnet with the standard
#      network policies, OneCLI disabled (or, with --onecli, bundled: install.sh runs hack/onecli.sh first), the scripted
#      model only
#   7. reads the isolation probe (hack/kind-smoke.sh --status), checks that the admin console (charts' console.enabled,
#      on in values-kind.yaml), the session API and, with --onecli, the OneCLI dashboard answer, and ends with a summary:
#      the URLs and whether each is ready, how to sign in (commands that read the Secrets; no secret is printed), the
#      warnings and the next steps. An endpoint that does not answer fails the run after the summary
#
# --cni cilium (issue #139) creates the cluster without kindnet (networking.disableDefaultCNI), installs Cilium (chart
# version pinned below, from helm.cilium.io) and installs pi-durable with networkPolicy.provider=cilium. kindnet does not
# filter traffic to hostNetwork Pods (API server, kubelet), so the isolation probe reports not-enforced there; Cilium does,
# so on this lane the probe must report enforced: NETPOL_ENFORCED defaults to 1 and hack/kind-smoke.sh fails a sandbox
# that reaches the node. Slower to start (Cilium's images, about two minutes) and the node needs the images from quay.io.
# kindnet stays the fast default. The CNI is fixed when the cluster is created: a reused cluster must match --cni.
#
# --onecli installs the bundled OneCLI (docs/decisions/0022-bundled-onecli.md) with its externalUrl http://localhost:10254,
# which the exposed port serves (or a port-forward, with --no-expose). It needs the OneCLI images from ghcr.io/onecli (the node pulls them) and adds three to five minutes. The
# scripted model still needs no credential; hack/kind-smoke.sh --onecli proves a session's orchestrator routes through the
# gateway. A real model: docs/model-credentials.md.
#
# --egress-proxy (epic #50, docs/decisions/0035-egress-proxy-runtime.md) turns on the egress proxy: the bundled Postgres
# creates the read-only role pi_egress (auth.egressReader), this script makes the Secret pi-egress-database with its URI,
# and the install sets egressProxy.enabled, the database Secret and a client admission for the namespace pi-egress-test
# (where hack/egress-smoke.sh runs its test pods). --set key=value (repeatable) is passed to hack/install.sh as it is,
# after everything this script sets, for example --set egressProxy.rules.staleAfter=30s.
#
# Images: IMAGE_TAG (default as above) applies to all of them; ORCH_IMAGE, INGEST_IMAGE, SANDBOX_IMAGE and
# EGRESS_PROXY_IMAGE (a tag or digest reference, for example ghcr.io/gscode1/pi-ingest@sha256:...) override one image. IMAGE_REPO (default ghcr.io/gscode1)
# is the registry prefix. NETPOL_ENFORCED=1 fails the run unless the isolation probe says enforced (CI sets it).
# Run the smoke test afterwards: hack/kind-smoke.sh. Remove everything: hack/kind-down.sh.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=${KIND_CLUSTER_NAME:-pi-durable}
namespace=pi-durable
timeout=10m
build=0
onecli=0
egress_proxy=0
user_sets=()
expose=1
repo=${IMAGE_REPO:-ghcr.io/gscode1}
min_kind=0.24.0
cni=kindnet
# Upgrade on purpose, with a kind run of this lane (hack/kind-up.sh --cni cilium, then hack/kind-smoke.sh).
cilium_version=1.20.5
verbose=0
[[ -z ${CI:-} ]] || verbose=1 # a CI job log should hold everything

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--build] [--onecli] [--egress-proxy] [--no-expose] [--cni kindnet|cilium] [--set key=value]... [--timeout 10m] [--verbose]" >&2
  echo "  env: IMAGE_TAG, ORCH_IMAGE, INGEST_IMAGE, SANDBOX_IMAGE, EGRESS_PROXY_IMAGE, IMAGE_REPO, NETPOL_ENFORCED=1, CI (implies --verbose)" >&2
  exit 64
}
die() {
  echo "kind-up: $*" >&2
  exit 1
}
t0=$SECONDS

while [[ $# -gt 0 ]]; do
  case $1 in
  -v | --verbose) verbose=1; shift ;;
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --build) build=1; shift ;;
  --onecli) onecli=1; shift ;;
  --egress-proxy) egress_proxy=1; shift ;;
  --set) [[ $# -ge 2 ]] || usage; user_sets+=(--set "$2"); shift 2 ;;
  --no-expose) expose=0; shift ;;
  --cni) [[ $# -ge 2 ]] || usage; cni=$2; shift 2 ;;
  --timeout) [[ $# -ge 2 ]] || usage; timeout=$2; shift 2 ;;
  -h | --help) usage ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad namespace '$namespace'"
[[ $cni == kindnet || $cni == cilium ]] || die "bad --cni '$cni' (kindnet or cilium)"
# On Cilium the probe must say enforced; kind-smoke.sh reads the same variable.
[[ $cni == kindnet ]] || export NETPOL_ENFORCED=${NETPOL_ENFORCED:-1}

# ------------------------------------------------------------------ output
# Quiet mode moves stdout and stderr to the log for the length of a step (the terminal is kept on fds 3 and 4), so a
# command's output never needs its own redirect and `set -e` still stops at the first failure; the EXIT trap then shows
# the failed step's last lines.
tty=0
[[ ! -t 1 ]] || tty=1
if [[ $tty -eq 1 && -z ${NO_COLOR:-} ]]; then
  bold=$'\e[1m' dim=$'\e[2m' red=$'\e[31m' green=$'\e[32m' yellow=$'\e[33m' off=$'\e[0m'
else
  bold="" dim="" red="" green="" yellow="" off=""
fi
log_file=""
if [[ $verbose -eq 0 ]]; then
  tmp_root=${TMPDIR:-/tmp}
  log_file=$(mktemp "${tmp_root%/}/kind-up-$name.XXXXXX")
fi
step_title=""
step_t0=0
step_line=0
step_end() {
  [[ -n $step_title ]] || return 0
  if [[ $verbose -eq 0 ]]; then
    exec 1>&3 2>&4 3>&- 4>&-
    [[ $tty -eq 0 ]] || printf '\r\e[K'
    printf '  %s✓%s %s %s(%ss)%s\n' "$green" "$off" "$step_title" "$dim" "$((SECONDS - step_t0))" "$off"
  fi
  step_title=""
}
step() { # title: what follows, up to the next step or step_end, is one step
  step_end
  step_title=$1
  step_t0=$SECONDS
  if [[ $verbose -eq 1 ]]; then
    printf '\n## %s (%ss)\n' "$1" "$((SECONDS - t0))"
    return 0
  fi
  printf '\n## %s\n' "$1" >>"$log_file"
  step_line=$(wc -l <"$log_file")
  [[ $tty -eq 0 ]] || printf '  %s… %s%s' "$dim" "$1" "$off"
  exec 3>&1 4>&2 >>"$log_file" 2>&1
}
tmp=""
on_exit() {
  local rc=$?
  [[ -z $tmp ]] || rm -rf "$tmp"
  [[ $rc -ne 0 && -n $step_title && $verbose -eq 0 ]] || return 0
  exec 1>&3 2>&4
  [[ $tty -eq 0 ]] || printf '\r\e[K'
  {
    printf '  %s✗ %s failed%s (%ss). Its last lines:\n\n' "$red" "$step_title" "$off" "$((SECONDS - step_t0))"
    tail -n "+$((step_line + 1))" "$log_file" | tail -n 40 | sed 's/^/    /'
    printf '\n  Full log: %s\n' "$log_file"
  } >&2
}
trap on_exit EXIT
[[ -z $log_file ]] || printf '%spi-durable on kind: cluster %s, namespace %s%s  %s(log: %s)%s\n\n' \
  "$bold" "$name" "$namespace" "$off" "$dim" "$log_file" "$off"

# ------------------------------------------------------------------ 1. tools
step "check the tools and the images"
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
ref_egress_proxy=${EGRESS_PROXY_IMAGE:-$repo/pi-egress-proxy:$tag}
set_args=()
extra_args=()
[[ $onecli -eq 0 ]] || extra_args+=(--set onecli.mode=bundled)
[[ $cni == kindnet ]] || extra_args+=(--set networkPolicy.provider=cilium)
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
[[ $egress_proxy -eq 0 && $build -eq 0 ]] || add_image_sets egressProxy "$ref_egress_proxy"
manifest_ok() { # the registry can be slow: three tries
  for _ in 1 2 3; do
    docker manifest inspect "$1" >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}
if [[ $build -eq 0 ]]; then
  # Fail now, not after a 3 minute install, when the images were not published for this commit.
  refs=("$ref_orchestrator" "$ref_ingest" "$ref_sandbox")
  [[ $egress_proxy -eq 0 ]] || refs+=("$ref_egress_proxy")
  for ref in "${refs[@]}"; do
    manifest_ok "$ref" ||
      die "image $ref cannot be pulled. Set IMAGE_TAG (or ORCH_IMAGE, INGEST_IMAGE, SANDBOX_IMAGE, EGRESS_PROXY_IMAGE) to published images, or use --build to build them here."
  done
fi

# ------------------------------------------------------------------ 2. the cluster
step "kind cluster $name"
if kind get clusters 2>/dev/null | grep -qx -- "$name"; then
  echo "cluster $name exists, reused"
  if [[ $expose -eq 1 ]]; then
    # Port mappings are fixed when the node container is created. Say so instead of installing something unreachable.
    [[ -n $(docker port "$name-control-plane" 30080/tcp 2>/dev/null) ]] ||
      die "cluster $name exists without the localhost port mappings (8080, 10254, 10256), and kind cannot add them later. Run hack/kind-down.sh --name $name and start again, or pass --no-expose to keep this cluster and use port-forward."
  fi
else
  config=$(mktemp -d)/kind-config.yaml
  if [[ $expose -eq 0 ]]; then
    sed '/# expose:begin/,/# expose:end/d' "$root/hack/kind-config.yaml" >"$config"
  else
    cp "$root/hack/kind-config.yaml" "$config"
  fi
  if [[ $cni == kindnet ]]; then
    kind create cluster --name "$name" --config "$config" --wait 180s
  else
    # No CNI yet, so the node stays NotReady until Cilium runs: waiting here would only time out.
    printf 'networking:\n  disableDefaultCNI: true\n' >>"$config"
    kind create cluster --name "$name" --config "$config"
  fi
fi
expose_cidr=""
if [[ $expose -eq 1 ]]; then
  # Where connections to the published ports come from, as the pods see them: the gateway of the kind Docker network
  # (measured on Docker Desktop for Mac and on Linux). The first entry may be IPv6, so pick the IPv4 one. A /32: the node
  # and the Pod network must not be admitted, a sandbox can reach both.
  gateways=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' 2>/dev/null || true)
  for gateway in $gateways; do
    if [[ $gateway =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then expose_cidr=$gateway/32; break; fi
  done
  [[ -n $expose_cidr ]] || die "cannot read the IPv4 gateway of the Docker network 'kind' (got: '${gateways:-nothing}'). Pass --no-expose to skip the localhost ports."
  echo "localhost ports: 8080 (session API)$([[ $onecli -eq 0 ]] || echo ", 10254 and 10256 (OneCLI)"), admitted from $expose_cidr only"
  # extra_args, not set_args: --build rebuilds set_args from scratch.
  extra_args+=(--set ingest.expose.enabled=true --set "ingest.expose.sourceCidr=$expose_cidr")
  [[ $onecli -eq 0 ]] || extra_args+=(--onecli-expose-cidr "$expose_cidr")
fi
# Everything below names its context. The current context of the user's kubeconfig is never used.
k get nodes >/dev/null || die "cannot reach the cluster through context $ctx"
has_cilium=0
[[ -z $(k -n kube-system get daemonset cilium --ignore-not-found -o name) ]] || has_cilium=1
has_kindnet=0
[[ -z $(k -n kube-system get daemonset kindnet --ignore-not-found -o name) ]] || has_kindnet=1
if [[ $cni == cilium && $has_kindnet -eq 1 ]]; then
  die "cluster $name runs kindnet, and the CNI cannot be changed later. Run hack/kind-down.sh --name $name and start again with --cni cilium, or use another --name."
fi
if [[ $cni == kindnet && $has_cilium -eq 1 ]]; then
  die "cluster $name runs Cilium: pass --cni cilium to reuse it (the chart needs networkPolicy.provider=cilium there)."
fi

# ------------------------------------------------------------------ 2b. Cilium
if [[ $cni == cilium ]]; then
  step "Cilium $cilium_version"
  # Defaults otherwise: kube-proxy stays (kind runs it), cluster-pool IPAM, VXLAN. Cilium's CIDR rules do not select the
  # node or other nodes (policy-cidr-match-mode is empty), so the sandbox policy's internet ipBlock cannot open the node.
  # Its own empty repository config and cache: --repo still reads the user's repositories, and a stale entry there fails it.
  helm_home=$(mktemp -d)
  HELM_REPOSITORY_CONFIG=$helm_home/repositories.yaml HELM_REPOSITORY_CACHE=$helm_home/cache \
    helm --kube-context "$ctx" upgrade --install cilium cilium --repo https://helm.cilium.io --version "$cilium_version" \
    --namespace kube-system --set image.pullPolicy=IfNotPresent --set operator.replicas=1 --wait --timeout "$timeout"
  rm -rf "$helm_home"
  k -n kube-system rollout status daemonset/cilium --timeout "$timeout"
  k wait --for=condition=Ready nodes --all --timeout "$timeout"
fi

# ------------------------------------------------------------------ 3. images
if [[ $build -eq 1 ]]; then
  step "build the images (native architecture) and load them into the node"
  case $(uname -m) in aarch64 | arm64) platform=linux/arm64 ;; *) platform=linux/amd64 ;; esac
  for image in orchestrator ingest sandbox egress-proxy; do
    IMAGE_REPO=$repo "$root/images/build.sh" "$image" --platform "$platform" >/dev/null
  done
  # build.sh names them <repo>/pi-<image>:<version>-<short sha>; the install refs must be exactly those.
  built=$version-$(git -C "$root" rev-parse --short HEAD)
  for image in orchestrator ingest sandbox egress-proxy; do
    kind load docker-image "$repo/pi-$image:$built" --name "$name"
  done
  set_args=()
  for image in orchestrator ingest sandbox; do
    add_image_sets "$image" "$repo/pi-$image:$built"
  done
  add_image_sets egressProxy "$repo/pi-egress-proxy:$built"
  # IfNotPresent would be enough, Never makes a missing load a clear error instead of a pull of a tag nobody published.
  for image in orchestrator ingest sandbox egressProxy; do set_args+=(--set "images.$image.pullPolicy=Never"); done
fi

# ------------------------------------------------------------------ 4. agent-sandbox
step "agent-sandbox"
if [[ -n $(k get crd sandboxes.agents.x-k8s.io --ignore-not-found -o name) ]]; then
  KUBE_CONTEXT=$ctx "$root/hack/agent-sandbox.sh" external
else
  KUBE_CONTEXT=$ctx "$root/hack/agent-sandbox.sh" bundled
fi

# ------------------------------------------------------------------ 5. namespace, secrets, postgres
step "namespace $namespace and the bundled Postgres"
umask 077
tmp=$(mktemp -d)
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
  for key in postgres-password pi-password onecli-password egress-password; do
    openssl rand -hex 24 | tr -d '\n' >"$tmp/$key"
  done
  kn create secret generic pi-postgres-auth --from-file=postgres-password="$tmp/postgres-password" \
    --from-file=pi-password="$tmp/pi-password" --from-file=onecli-password="$tmp/onecli-password" \
    --from-file=egress-password="$tmp/egress-password" >/dev/null
  echo "pi-postgres-auth: created (random passwords)"
else
  echo "pi-postgres-auth: exists, kept"
fi
pg_args=()
if [[ $egress_proxy -eq 1 ]]; then
  # The read-only role of the egress proxy (the app's database user cannot create roles). A Secret kept from an older run
  # has no egress-password: add it, once.
  if [[ -z $(kn get secret pi-postgres-auth -o jsonpath='{.data.egress-password}') ]]; then
    openssl rand -hex 24 | tr -d '\n' >"$tmp/egress-password"
    printf '{"data":{"egress-password":"%s"}}' "$(base64 <"$tmp/egress-password" | tr -d '\n')" >"$tmp/patch.json"
    kn patch secret pi-postgres-auth --type merge --patch-file "$tmp/patch.json" >/dev/null
  fi
  pg_args+=(--set auth.egressReader.enabled=true)
fi
helm --kube-context "$ctx" upgrade --install pi-postgres "$root/charts/pi-postgres" --namespace "$namespace" \
  --set persistence.storageClass=standard --set persistence.size=2Gi ${pg_args[@]+"${pg_args[@]}"} --wait --timeout "$timeout"

# The URI of the app's database for install.sh, which creates the Secret pi-database once (and keeps an existing one).
pi_password=$(kn get secret pi-postgres-auth -o jsonpath='{.data.pi-password}' | base64 -d)
DATABASE_URL="postgres://pi:$pi_password@pi-postgres.$namespace.svc:5432/pi"
export DATABASE_URL
if [[ $egress_proxy -eq 1 ]]; then
  # The proxy's own Secret: the URI of the read-only role. Written through a file, never argv or stdout; kept if it exists.
  if [[ -z $(kn get secret pi-egress-database --ignore-not-found -o name) ]]; then
    egress_password=$(kn get secret pi-postgres-auth -o jsonpath='{.data.egress-password}' | base64 -d)
    printf 'postgres://pi_egress:%s@pi-postgres.%s.svc:5432/pi' "$egress_password" "$namespace" >"$tmp/egress-uri"
    kn create secret generic pi-egress-database --from-file=uri="$tmp/egress-uri" >/dev/null
    unset egress_password
    echo "pi-egress-database: created (the URI of the read-only role pi_egress)"
  fi
  extra_args+=(--set egressProxy.enabled=true --set egressProxy.database.existingSecret=pi-egress-database
    --set 'egressProxy.clients[0].namespaceSelector.matchLabels.kubernetes\.io/metadata\.name=pi-egress-test')
  if [[ $onecli -eq 1 ]]; then
    # The key that seals the sessions' OneCLI tokens for the proxy (ADR 0037): 32 random bytes, kept if it exists
    # (a new key would leave the stored bindings unreadable until each session is bound again). Never printed.
    if [[ -z $(kn get secret pi-egress-binding --ignore-not-found -o name) ]]; then
      openssl rand -base64 32 | tr -d '\n' >"$tmp/binding-key"
      kn create secret generic pi-egress-binding --from-file=key="$tmp/binding-key" >/dev/null
      echo "pi-egress-binding: created (the key that seals OneCLI tokens for the egress proxy)"
    fi
    extra_args+=(--set egressProxy.binding.existingSecret=pi-egress-binding)
  fi
fi

# ------------------------------------------------------------------ 6. pi-durable
step "install pi-durable$([[ $onecli -eq 0 ]] || echo ' and OneCLI') (hack/install.sh)"
KUBE_CONTEXT=$ctx "$root/hack/install.sh" --namespace "$namespace" --values "$root/charts/pi-durable/values-kind.yaml" \
  ${set_args[@]+"${set_args[@]}"} ${extra_args[@]+"${extra_args[@]}"} ${user_sets[@]+"${user_sets[@]}"} --timeout "$timeout"
unset DATABASE_URL pi_password

# ------------------------------------------------------------------ 7. isolation probe
step "isolation probe (GET /admin/status)"
probe=$("$root/hack/kind-smoke.sh" --name "$name" --namespace "$namespace" --status 2>&1) || {
  printf '%s\n' "$probe"
  die "the isolation probe check failed (hack/kind-smoke.sh --status)$([[ $cni == kindnet ]] || echo '; on Cilium it must report enforced')"
}
printf '%s\n' "$probe"
probe_state=$(sed -n 's/^isolation-probe state=\([^ ]*\).*/\1/p' <<<"$probe" | head -1)
probe_reached=$(awk '$1 == "probe-target" && $5 == "reachable" { print $2 }' <<<"$probe" | paste -sd, - | sed 's/,/, /g')

# ------------------------------------------------------------------ 8. endpoints
# Ready means it answers: from this machine through the published ports (the path the user takes), or with --no-expose
# from inside the ingest pod. A failure is reported in the summary, then fails the run.
step "check the admin console, the session API$([[ $onecli -eq 0 ]] || echo ' and OneCLI')"
http_ok() { # url -> 0 once it answers 2xx or 3xx (about two minutes)
  local code
  for _ in $(seq 1 40); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$1" || true)
    echo "$1 -> $code"
    [[ $code != [23]?? ]] || return 0
    sleep 3
  done
  return 1
}
ingest_ok() { # path -> 0 once ingest answers it 2xx inside its own pod
  local probe_js='fetch("http://127.0.0.1:" + (process.env.PI_INGEST_PORT ?? "8080") + process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
  for _ in $(seq 1 40); do
    kn exec deploy/pi-ingest -c ingest -- node -e "$probe_js" "$1" && return 0
    sleep 3
  done
  return 1
}
api_state=ready console_state=ready onecli_state=ready
if [[ $expose -eq 1 ]]; then
  http_ok http://127.0.0.1:8080/healthz || api_state="not answering"
  http_ok http://127.0.0.1:8080/console/ || console_state="not answering"
  [[ $onecli -eq 0 ]] || http_ok http://127.0.0.1:10254/auth/login || onecli_state="not answering"
else
  ingest_ok /healthz || api_state="not answering"
  ingest_ok /console/ || console_state="not answering"
  # OneCLI's rollout was waited for by hack/onecli.sh; without the published port there is nothing to call from here.
fi
step_end

# ------------------------------------------------------------------ summary
total=$((SECONDS - t0))
failed=0
row() { # label url state
  if [[ $3 == ready ]]; then
    printf '  %s✓%s %-15s %s\n' "$green" "$off" "$1" "$2"
  else
    printf '  %s✗%s %-15s %s  %s%s%s\n' "$red" "$off" "$1" "$2" "$red" "$3" "$off"
    failed=1
  fi
}
heading() { printf '\n%s%s%s\n' "$bold" "$*" "$off"; }
# Secrets are read by the commands below, never by this script's output. The clipboard keeps them off the screen too.
clip=""
if command -v pbcopy >/dev/null 2>&1; then
  clip=" | pbcopy"
elif command -v wl-copy >/dev/null 2>&1; then
  clip=" | wl-copy"
elif command -v xclip >/dev/null 2>&1; then
  clip=" | xclip -selection clipboard"
fi
kubectl_ns="kubectl --context $ctx -n $namespace"
token_cmd="$kubectl_ns get secret api-auth -o jsonpath='{.data.tokens}' | base64 -d | sed -n 's/^admin://p' | tr -d '\\n'$clip"
onecli_email_cmd="$kubectl_ns get secret pi-onecli-admin -o jsonpath='{.data.email}' | base64 -d; echo"
onecli_password_cmd="$kubectl_ns get secret pi-onecli-admin -o jsonpath='{.data.password}' | base64 -d$clip"
if [[ -n $clip ]]; then to_clipboard="copies it to the clipboard"; else to_clipboard="prints it"; fi

if [[ $expose -eq 1 ]]; then
  where="published on 127.0.0.1 only"
else
  where="through kubectl port-forward, see below"
fi
printf '\n%spi-durable is up%s on kind cluster %s (context %s, namespace %s, CNI %s) in %sm%ss, %s\n\n' \
  "$bold" "$off" "$name" "$ctx" "$namespace" "$cni" "$((total / 60))" "$((total % 60))" "$where"
row "Admin console" "http://localhost:8080/console/" "$console_state"
row "Session API" "http://localhost:8080" "$api_state"
if [[ $onecli -eq 1 ]]; then
  if [[ $expose -eq 1 ]]; then
    row "OneCLI" "http://localhost:10254/auth/login" "$onecli_state"
  else
    row "OneCLI" "http://localhost:10254/auth/login" ready
  fi
fi

if [[ $expose -eq 0 ]]; then
  heading "Port-forward first (one terminal each)"
  echo "  $kubectl_ns port-forward svc/pi-ingest 8080:8080"
  if [[ $onecli -eq 1 ]]; then
    echo "  $kubectl_ns port-forward svc/onecli-web 10254:10254"
    echo "  $kubectl_ns port-forward svc/onecli-api 10256:10256"
  fi
fi

heading "Sign in to the admin console"
echo "  Open http://localhost:8080/console/ and paste the admin API token (owner admin). This $to_clipboard:"
echo "    $token_cmd"
if [[ $onecli -eq 1 ]]; then
  heading "Sign in to OneCLI"
  echo "  Open http://localhost:10254/auth/login. The email, then the password (this $to_clipboard):"
  echo "    $onecli_email_cmd"
  echo "    $onecli_password_cmd"
  echo "  Then connect a model provider there (docs/model-credentials.md) and set models in your values to use it."
fi

heading "Heads-up"
printf '  %s!%s sandboxes run under runc, not gVisor: a trial for the scripted model, never for untrusted code\n' "$yellow" "$off"
if [[ $probe_state != enforced ]]; then
  if [[ $cni == kindnet && $probe_reached == kube-api ]]; then
    printf '  %s!%s network policy %s: a sandbox reached only the Kubernetes API, which kindnet does not filter (expected on kind)\n' \
      "$yellow" "$off" "${probe_state:-unknown}"
  else
    printf '  %s!%s network policy %s%s\n' "$yellow" "$off" "${probe_state:-unknown}" "${probe_reached:+ (a sandbox reached: $probe_reached)}"
  fi
fi
[[ $onecli -eq 1 ]] || printf '  %s!%s only the scripted model works: a real model needs OneCLI, rerun with --onecli\n' "$yellow" "$off"

heading "Next"
echo "  Smoke test    hack/kind-smoke.sh --name $name --namespace $namespace$([[ $onecli -eq 0 ]] || echo ' --onecli')"
echo "  Try a session docs/session-api.md (the scripted model: the message text is the script)"
[[ $egress_proxy -eq 0 ]] || echo "  Egress proxy  hack/egress-smoke.sh --name $name --namespace $namespace"
echo "  Remove        hack/kind-down.sh --name $name"
[[ -z $log_file ]] || echo "  Full log      $log_file"
echo
[[ $failed -eq 0 ]] || die "an endpoint does not answer (marked above); the install itself finished. The log has each try."
