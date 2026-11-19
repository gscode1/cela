#!/usr/bin/env bash
# Install the bundled OneCLI into one namespace (docs/install-plan.md slice 10, docs/decisions/0022-bundled-onecli.md):
#
#   hack/onecli.sh [--namespace pi-durable] [--external-url http://localhost:10254] [--release onecli] [--timeout 10m]
#                  [--expose-source-cidr A.B.C.D/32] [--egress-proxy on|off] [--allow-open-without-proxy]
#
#   1. creates the Secrets that do not exist yet, never regenerating one (losing SECRET_ENCRYPTION_KEY makes every stored
#      credential unreadable): onecli-database (DATABASE_URL of the `onecli` database and role) and onecli-secrets (the
#      three keys of the upstream chart). Values go through a private temp file and are never printed.
#   2. installs charts/pi-onecli (the NetworkPolicies) FIRST: the management API takes sign-ups from anyone who can reach
#      it and OneCLI has no switch to stop that, so it must never be reachable from other pods, not even for a minute.
#   3. installs the upstream chart as its own release `onecli`, pinned by version and digest, with
#      charts/pi-onecli/upstream-values.yaml (runner off, one replica, no Redis, no database of its own), and waits.
#   4. runs hack/onecli-bootstrap.sh: account, admin key, orchestrator agent token, host rules, public CA ConfigMap.
#
# OneCLI is installed OPEN (docs/decisions/0043-open-onecli-defaults.md): the gateway may reach the RFC 1918 ranges on 443
# (upstream value gateway.allowPrivateDestinations, and charts/pi-onecli gateway.privateHttps for the network). That is safe
# only while sandboxes reach the gateway through the egress proxy, which never routes a private address to it. With
# `--egress-proxy off` (hack/install.sh passes it when the pi-durable release has no proxy) sandboxes reach the gateway
# directly and a repo session holds a OneCLI token, so the script installs the HARDENED values instead: no private
# destinations, no private 443 rule. `--allow-open-without-proxy` acknowledges the risk and keeps them open. Standalone
# runs default to `--egress-proxy on`, the chart's default.
#
# Every step is idempotent: a second run upgrades in place and the bootstrap reports changed=0.
# The namespace must exist (hack/install.sh and hack/kind-up.sh create it with the restricted Pod Security labels).
#
# --external-url is OneCLI's own `externalUrl`: the origin the dashboard is reached at. The default
# http://localhost:10254 is for `kubectl port-forward` (see docs/model-credentials.md); it turns on the chart's
# allowInsecureExternalUrl. Any other http URL is refused; use an https URL of your own edge.
#
# --expose-source-cidr is for kind only (hack/kind-up.sh): it adds NodePort Services for the dashboard (30254) and the
# management API (30256), and admits that one /32 (the Docker gateway of the kind network, where the host's localhost
# connections arrive from) to them (charts/pi-onecli `expose`). Without it nothing is exposed.
#
# Environment: KUBE_CONTEXT (kubectl and helm context; unset: the current one); ONECLI_DATABASE_URL (a postgres:// URI for
# the database, used only to create onecli-database; unset: derived from the Secret pi-postgres-auth of charts/pi-postgres,
# key onecli-password, host pi-postgres.<namespace>.svc).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)

# The upstream chart. Upgrade on purpose: a chart or image bump needs the bootstrap run against it again (it fails
# loudly, never silently, when OneCLI's API changed). The digest is the OCI manifest of that version. The images are the
# chart's own (ghcr.io/onecli/onecli-{api,web,gateway,migrations}:<appVersion>), tags only: the chart cannot take a digest
# per image.
onecli_chart=oci://ghcr.io/onecli/charts/onecli
onecli_version=2.20.0
onecli_digest=sha256:0e67ea2b3311ff30868b851dc2e5622f6febd8a82855fed8fb9524e3522063ba

namespace=pi-durable
release=onecli
external_url=http://localhost:10254
timeout=10m
expose_cidr=""
egress_proxy=on
allow_open=0

usage() {
  echo "usage: ${0##*/} [--namespace NS] [--external-url URL] [--release NAME] [--timeout 10m] [--expose-source-cidr A.B.C.D/32] [--egress-proxy on|off] [--allow-open-without-proxy]" >&2
  exit 64
}
die() {
  echo "onecli: $*" >&2
  exit 1
}
log() { printf '\n## %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case $1 in
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --external-url) [[ $# -ge 2 ]] || usage; external_url=$2; shift 2 ;;
  --release) [[ $# -ge 2 ]] || usage; release=$2; shift 2 ;;
  --timeout) [[ $# -ge 2 ]] || usage; timeout=$2; shift 2 ;;
  --expose-source-cidr) [[ $# -ge 2 ]] || usage; expose_cidr=$2; shift 2 ;;
  --egress-proxy) [[ $# -ge 2 ]] || usage; egress_proxy=$2; shift 2 ;;
  --allow-open-without-proxy) allow_open=1; shift ;;
  -h | --help) usage ;;
  *) usage ;;
  esac
done
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad namespace '$namespace'"
[[ $release =~ ^[a-z0-9]([-a-z0-9]{0,40}[a-z0-9])?$ ]] || die "bad release name '$release'"
[[ $external_url =~ ^https?://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] || die "bad --external-url '$external_url' (scheme, host and optional port, no path)"
[[ -z $expose_cidr || $expose_cidr =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ ]] || die "bad --expose-source-cidr '$expose_cidr' (one IPv4 address as /32)"
[[ $egress_proxy == on || $egress_proxy == off ]] || die "bad --egress-proxy '$egress_proxy' (on or off)"
# Open unless the release has no proxy and nobody acknowledged it.
open_values=1
if [[ $egress_proxy == off && $allow_open -eq 0 ]]; then open_values=0; fi
allow_insecure=false
if [[ $external_url == http://* ]]; then
  case ${external_url#http://} in
  localhost | localhost:* | 127.0.0.1 | 127.0.0.1:*) allow_insecure=true ;;
  *) die "an http externalUrl is only accepted for localhost (port-forward); use an https URL for $external_url" ;;
  esac
fi
for tool in kubectl helm openssl base64; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

ctx=${KUBE_CONTEXT:-}
k() { kubectl ${ctx:+--context="$ctx"} -n "$namespace" "$@"; }
helm_() { helm ${ctx:+--kube-context="$ctx"} "$@"; }
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

found=$(kubectl ${ctx:+--context="$ctx"} get namespace "$namespace" --ignore-not-found -o name)
[[ -n $found ]] || die "namespace $namespace does not exist (hack/install.sh and hack/kind-up.sh create it)"

secret_exists() {
  local name
  name=$(k get secret "$1" --ignore-not-found -o name)
  [[ -n $name ]]
}

# ------------------------------------------------------------------ 1. secrets
log "secrets (missing ones are created once; existing ones are never changed)"
if secret_exists onecli-database; then
  echo "onecli-database: exists, kept"
else
  uri=${ONECLI_DATABASE_URL:-}
  if [[ -z $uri ]]; then
    secret_exists pi-postgres-auth ||
      die "no database for OneCLI: set ONECLI_DATABASE_URL (a postgres:// URI of an empty database and its owner), or create the Secret onecli-database (key DATABASE_URL) yourself"
    password=$(k get secret pi-postgres-auth -o jsonpath='{.data.onecli-password}' | base64 -d)
    [[ -n $password ]] || die "Secret pi-postgres-auth has no key onecli-password"
    uri="postgresql://onecli:$password@pi-postgres.$namespace.svc:5432/onecli"
    unset password
  fi
  case $uri in postgres://* | postgresql://*) ;; *) die "the database URI must be a postgres:// URI" ;; esac
  printf '%s' "$uri" >"$tmp/uri"
  unset uri
  k create secret generic onecli-database --from-file=DATABASE_URL="$tmp/uri" >/dev/null
  echo "onecli-database: created"
fi
unset ONECLI_DATABASE_URL
if secret_exists onecli-secrets; then
  echo "onecli-secrets: exists, kept"
else
  for key in BETTER_AUTH_SECRET SECRET_ENCRYPTION_KEY GATEWAY_INTERNAL_SECRET; do
    head -c 32 /dev/urandom | base64 | tr -d '\n' >"$tmp/$key"
  done
  k create secret generic onecli-secrets --from-file=BETTER_AUTH_SECRET="$tmp/BETTER_AUTH_SECRET" \
    --from-file=SECRET_ENCRYPTION_KEY="$tmp/SECRET_ENCRYPTION_KEY" \
    --from-file=GATEWAY_INTERNAL_SECRET="$tmp/GATEWAY_INTERNAL_SECRET" >/dev/null
  echo "onecli-secrets: created. Back it up: losing SECRET_ENCRYPTION_KEY makes every stored credential unreadable"
fi

# ------------------------------------------------------------------ 2. policies
log "network policies (charts/pi-onecli)"
if [[ $open_values -eq 1 ]]; then
  [[ $egress_proxy == on ]] || echo "OneCLI: private destinations stay OPEN without an egress proxy (--allow-open-without-proxy): a sandbox can reach private HTTPS hosts through the gateway" >&2
else
  echo "OneCLI: no egress proxy in this release, so OneCLI is installed HARDENED (no private destinations; --allow-open-without-proxy keeps them open)" >&2
fi
hardened_policy=()
hardened_gateway=()
if [[ $open_values -eq 0 ]]; then
  hardened_policy=(--set gateway.privateHttps.enabled=false)
  hardened_gateway=(--set gateway.allowPrivateDestinations=)
fi
helm_ upgrade --install pi-onecli "$root/charts/pi-onecli" --namespace "$namespace" --set "release=$release" \
  ${hardened_policy[@]+"${hardened_policy[@]}"} ${expose_cidr:+--set expose.enabled=true --set "expose.sourceCidr=$expose_cidr"} --wait --timeout "$timeout"

# ------------------------------------------------------------------ 3. the upstream chart
log "OneCLI $onecli_version (upstream chart, release $release)"
helm_ upgrade --install "$release" "$onecli_chart:$onecli_version@$onecli_digest" --namespace "$namespace" \
  --values "$root/charts/pi-onecli/upstream-values.yaml" \
  ${hardened_gateway[@]+"${hardened_gateway[@]}"} --set "externalUrl=$external_url" --set "allowInsecureExternalUrl=$allow_insecure" --wait --timeout "$timeout"
# The api and gateway pods wait for the CA that a Job mints and restart themselves once: --wait covers it, the rollout
# checks make a failure name the Deployment.
for component in api web gateway; do
  k rollout status "deployment/$release-$component" --timeout=300s
done

# ------------------------------------------------------------------ 4. bootstrap
log "bootstrap (account, admin key, agent token, host rules, CA)"
ONECLI_RELEASE=$release KUBE_CONTEXT=$ctx "$root/hack/onecli-bootstrap.sh" -n "$namespace"

echo
if [[ -n $expose_cidr ]]; then
  echo "OneCLI is installed in $namespace. The dashboard and the API are on the host's localhost:10254 and :10256 (kind only)."
else
  echo "OneCLI is installed in $namespace. The dashboard is not exposed: docs/model-credentials.md says how to sign in."
fi
