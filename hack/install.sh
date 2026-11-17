#!/usr/bin/env bash
# Install the pi-durable app chart into one namespace (docs/install-plan.md, slice 4):
#
#   hack/install.sh --namespace pi-durable --values my-values.yaml [--set key=value]...
#
#   1. renders the chart with your values first (a bad value stops here, before the cluster is touched)
#   2. creates the namespace with the restricted Pod Security labels when it does not exist (helm --create-namespace
#      would set none)
#   3. creates the Secrets the chart references and that do not exist yet: sandboxd-auth and api-auth. Existing
#      Secrets are never changed or regenerated (D8): losing the sandboxd master breaks every existing sandbox. Secret
#      values are written from a private temp file and are never printed.
#   4. runs hack/agent-sandbox.sh external (read-only check; the controller and CRDs are cluster-wide and are never
#      installed or changed here)
#   4b. with onecli.mode=bundled: runs hack/onecli.sh (policies, the upstream OneCLI chart, the bootstrap), so that the
#      account, the agent token and the CA exist before the orchestrator starts
#   5. helm upgrade --install, waits for the rollout
#   6. reads GET /admin/status through ingest (waits up to 2 min for the isolation probe) and prints the runtime and
#      network-policy state; warnings do not fail
#
# The database stays external: the Secret named by database.external.existingSecret must exist, or DATABASE_URL (a
# postgres:// URI) in the environment creates it once. OneCLI is bundled (onecli.mode=bundled, step 4b), external or off.
# Bundled OneCLI needs its own database: ONECLI_DATABASE_URL, or the Secret pi-postgres-auth of charts/pi-postgres
# (hack/onecli.sh).
#
# Inputs: --namespace/-n (default pi-durable), --values/-f (repeatable), --set (repeatable, passed to helm),
# --release (default pi-durable), --timeout (default 10m), --onecli-external-url (bundled OneCLI's externalUrl, default
# http://localhost:10254, see hack/onecli.sh), --onecli-expose-cidr (kind only: passed to hack/onecli.sh as
# --expose-source-cidr); KUBE_CONTEXT selects the kubectl and helm context (unset:
# the current one); DATABASE_URL as above.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
chart=${CHART_DIR:-$root/charts/pi-durable}
namespace=pi-durable
release=pi-durable
timeout=10m
values=()
sets=()
onecli_url=""
onecli_expose_cidr=""

usage() {
  echo "usage: ${0##*/} [--namespace NS] --values FILE [--values FILE]... [--set key=value]... [--release NAME] [--timeout 10m] [--onecli-external-url URL] [--onecli-expose-cidr A.B.C.D/32]" >&2
  exit 64
}
die() {
  echo "install: $*" >&2
  exit 1
}
log() { printf '\n## %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case $1 in
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  -f | --values) [[ $# -ge 2 ]] || usage; values+=("$2"); shift 2 ;;
  --set) [[ $# -ge 2 ]] || usage; sets+=("$2"); shift 2 ;;
  --release) [[ $# -ge 2 ]] || usage; release=$2; shift 2 ;;
  --onecli-external-url) [[ $# -ge 2 ]] || usage; onecli_url=$2; shift 2 ;;
  --onecli-expose-cidr) [[ $# -ge 2 ]] || usage; onecli_expose_cidr=$2; shift 2 ;;
  --timeout) [[ $# -ge 2 ]] || usage; timeout=$2; shift 2 ;;
  -h | --help) usage ;;
  *) usage ;;
  esac
done
if [[ ${#values[@]} -eq 0 && ${#sets[@]} -eq 0 ]]; then
  echo "install: no values: pass --values FILE (images and database.external are required, see charts/pi-durable/README.md)" >&2
  usage
fi
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad namespace '$namespace'"
[[ $release =~ ^[a-z0-9]([-a-z0-9]{0,51}[a-z0-9])?$ ]] || die "bad release name '$release'"
for f in ${values[@]+"${values[@]}"}; do
  [[ -f $f ]] || die "values file not found: $f"
done
for tool in kubectl helm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
done

ctx=${KUBE_CONTEXT:-}
k() { kubectl ${ctx:+--context="$ctx"} -n "$namespace" "$@"; }
kc() { kubectl ${ctx:+--context="$ctx"} "$@"; }
helm_values_args=()
for f in ${values[@]+"${values[@]}"}; do helm_values_args+=(--values "$f"); done
for s in ${sets[@]+"${sets[@]}"}; do helm_values_args+=(--set "$s"); done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# Secret values only ever live in files created under this umask.
umask 077

# ------------------------------------------------------------------ 1. render
log "render the chart"
rendered=$tmp/rendered.yaml
helm template "$release" "$chart" --namespace "$namespace" ${helm_values_args[@]+"${helm_values_args[@]}"} >"$rendered" ||
  die "the chart does not render with these values (see the message above); nothing was changed"

# The names the chart references, read from what it rendered, so a renamed Secret in values is followed.
secret_ref() { # env var name -> the Secret it reads
  awk -v v="$1" '$0 ~ ("name: " v "$") { f = 1; next }
    f && /secretKeyRef/ { match($0, /name: [^,}]+/); print substr($0, RSTART + 6, RLENGTH - 6); exit }' "$rendered"
}
rendered_value() { # env var name -> its literal value
  sed -n "s/.*name: $1, value: \"\\([^\"]*\\)\".*/\\1/p" "$rendered" | head -1
}
sandboxd_secret=$(secret_ref PI_SANDBOX_MASTER_KEY)
api_secret=$(secret_ref PI_API_TOKENS)
database_secret=$(secret_ref PI_DURABLE_DATABASE_URL)
admins=$(rendered_value PI_API_ADMINS)
shards=$(rendered_value PI_ORCH_SHARDS)
[[ -n $sandboxd_secret && -n $api_secret && -n $database_secret && -n $admins && -n $shards ]] ||
  die "could not read the Secret names and admins from the rendered chart"

# ------------------------------------------------------------------ 2. namespace
log "namespace $namespace"
# Assigned on its own line so an unreachable cluster aborts instead of reading as "absent".
found=$(kc get namespace "$namespace" --ignore-not-found -o name)
if [[ -z $found ]]; then
  # The Pod Security version is pinned, like deploy/namespace.yaml and tests/e2e/run.sh (a unit test checks all three): a
  # cluster upgrade must not change the rules under us (docs/decisions/0019-restricted-pod-security.md).
  kc apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: $namespace
  labels:
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.36
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.36
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.36
YAML
  echo "created, with the restricted Pod Security labels"
else
  level=$(kc get namespace "$namespace" -o jsonpath='{.metadata.labels.pod-security\.kubernetes\.io/enforce}')
  if [[ $level != restricted ]]; then
    echo "WARNING: namespace $namespace exists and does not enforce Pod Security 'restricted' (enforce=${level:-unset}); it was left as it is" >&2
  else
    echo "exists"
  fi
fi

# ------------------------------------------------------------------ 3. secrets
log "secrets (missing ones are created once; existing ones are never changed)"
secret_exists() {
  local name
  name=$(k get secret "$1" --ignore-not-found -o name)
  [[ -n $name ]]
}
create_secret() { # name key file
  k create secret generic "$1" --from-file="$2=$3" >/dev/null
}
if secret_exists "$sandboxd_secret"; then
  echo "$sandboxd_secret: exists, kept"
else
  openssl rand -hex 32 | tr -d '\n' >"$tmp/master"
  create_secret "$sandboxd_secret" master "$tmp/master"
  echo "$sandboxd_secret: created (key master). Back it up: losing it breaks every existing sandbox"
fi
if secret_exists "$api_secret"; then
  echo "$api_secret: exists, kept"
  # Names only, never tokens: an admin without a token cannot call /admin/*.
  owners=$(k get secret "$api_secret" -o jsonpath='{.data.tokens}' | base64 -d | cut -d: -f1)
  for admin in $(tr ',' ' ' <<<"$admins"); do
    grep -qx -- "$admin" <<<"$owners" || echo "WARNING: $api_secret has no token for api.admins entry '$admin'" >&2
  done
else
  : >"$tmp/tokens"
  first=1
  for admin in $(tr ',' ' ' <<<"$admins"); do
    [[ $first == 1 ]] || printf '\n' >>"$tmp/tokens"
    first=0
    printf '%s:%s' "$admin" "$(openssl rand -hex 32)" >>"$tmp/tokens"
  done
  create_secret "$api_secret" tokens "$tmp/tokens"
  echo "$api_secret: created (key tokens, one token per api.admins owner: $admins)"
fi
if secret_exists "$database_secret"; then
  echo "$database_secret: exists (database, external)"
elif [[ -n ${DATABASE_URL:-} ]]; then
  # The URI goes through a file, not argv (visible in `ps`) and not through stdout.
  case $DATABASE_URL in postgres://* | postgresql://*) ;; *) die "DATABASE_URL must be a postgres:// URI" ;; esac
  uri_key=$(sed -n 's/.*name: PI_DURABLE_DATABASE_URL.*key: \([^ ,}]*\).*/\1/p' "$rendered" | head -1)
  printf '%s' "$DATABASE_URL" >"$tmp/uri"
  create_secret "$database_secret" "${uri_key:-uri}" "$tmp/uri"
  echo "$database_secret: created from DATABASE_URL"
else
  die "Secret $database_secret (the database URI) does not exist in $namespace. Create it, for example:
  kubectl -n $namespace create secret generic $database_secret --from-file=uri=<file holding the postgres:// URI>
or run again with DATABASE_URL set. Nothing was installed."
fi

# ------------------------------------------------------------------ 4. agent-sandbox
log "agent-sandbox (external: read-only check)"
KUBE_CONTEXT=$ctx "$root/hack/agent-sandbox.sh" external

# ------------------------------------------------------------------ 4b. bundled OneCLI
# The chart marks the mode on the orchestrator Deployment (read from the render, so --set and --values are both followed).
onecli_mode=$(sed -n 's/^ *pi-durable\/onecli-mode: //p' "$rendered" | head -1)
if [[ $onecli_mode == bundled ]]; then
  log "bundled OneCLI (hack/onecli.sh)"
  # The release name is the one the chart derives its URLs from: PI_ONECLI_API is http://<release>-api.<ns>.svc:10256.
  onecli_release=$(rendered_value PI_ONECLI_API | sed -n 's#^http://\(.*\)-api\..*#\1#p')
  [[ -n $onecli_release ]] || die "could not read the OneCLI release name from the rendered chart"
  KUBE_CONTEXT=$ctx "$root/hack/onecli.sh" --namespace "$namespace" --release "$onecli_release" --timeout "$timeout" \
    ${onecli_url:+--external-url "$onecli_url"} ${onecli_expose_cidr:+--expose-source-cidr "$onecli_expose_cidr"}
fi

# ------------------------------------------------------------------ 5. install
log "helm upgrade --install $release"
helm ${ctx:+--kube-context="$ctx"} upgrade --install "$release" "$chart" --namespace "$namespace" \
  ${helm_values_args[@]+"${helm_values_args[@]}"} --wait --timeout "$timeout"
for deployment in $(k get deployments -l app.kubernetes.io/part-of=pi-durable -o name); do
  k rollout status "$deployment" --timeout=300s
done

# ------------------------------------------------------------------ 6. status
# Read GET /admin/status from inside an ingest pod: the admin token is in the pod's own environment and never reaches
# this machine, and no port-forward or local port is needed.
log "runtime and network-policy state (GET /admin/status)"
admin=${admins%%,*}
reader='
const [admin, expected, final] = process.argv.slice(1);
const line = (process.env.PI_API_TOKENS ?? "").split("\n").find((l) => l.startsWith(admin + ":"));
if (line === undefined) { console.error("no token for admin " + admin); process.exit(2); }
const port = process.env.PI_INGEST_PORT ?? "8080";
const res = await fetch("http://127.0.0.1:" + port + "/admin/status", { headers: { authorization: "Bearer " + line.slice(admin.length + 1) } });
if (!res.ok) { console.error("GET /admin/status answered " + String(res.status)); process.exit(2); }
const { shards, networkPolicy } = await res.json();
if (shards.length < Number(expected)) { console.error("waiting: " + String(shards.length) + " of " + expected + " shards reported"); process.exit(3); }
// Shard 0 probes the network policies a short while after it starts; wait for it, but never fail the install on it.
if (["unknown", "running"].includes(networkPolicy.state) && final !== "1") { console.error("waiting: the isolation probe has not finished"); process.exit(3); }
for (const s of shards) console.log("shard " + String(s.shard) + " configuredRuntime=" + s.configuredRuntime + " observedRuntime=" + String(s.observedRuntime) + " networkPolicy=" + s.networkPolicy);
console.log("isolation-probe state=" + networkPolicy.state + " checkedAt=" + String(networkPolicy.checkedAt) + " reason=" + (networkPolicy.detail?.reason ?? "-"));
'
status=
for attempt in $(seq 1 60); do
  rc=0
  final=0
  [[ $attempt -lt 60 ]] || final=1
  status=$(k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$reader" "$admin" "$shards" "$final" 2>"$tmp/status.err") || rc=$?
  [[ $rc -eq 3 ]] || break
  sleep 2
done
if [[ $rc -ne 0 ]]; then
  cat "$tmp/status.err" >&2
  die "could not read GET /admin/status (exit $rc); the chart is installed, its state is unverified"
fi
printf '%s\n' "$status"
warned=0
while read -r kind shard configured _ network; do
  [[ $kind == shard ]] || continue
  if [[ ${configured#configuredRuntime=} != gvisor ]]; then
    echo "WARNING: shard $shard sandboxes run with ${configured#configuredRuntime=}, not gVisor: agent code has container isolation only" >&2
    warned=1
  fi
  if [[ ${network#networkPolicy=} != enforced ]]; then
    case ${network#networkPolicy=} in
    not-enforced) echo "WARNING: network policy is NOT ENFORCED (isolation probe): a sandbox can reach cluster services. The CNI does not enforce NetworkPolicy, or the policies are missing; nothing is blocked" >&2 ;;
    *) echo "WARNING: shard $shard network policy is ${network#networkPolicy=}: isolation is not verified. NetworkPolicies work only on a CNI that enforces them (nothing is blocked)" >&2 ;;
    esac
    warned=1
  fi
done <<<"$status"
[[ $warned -eq 0 ]] || echo "(warnings do not fail the install; see NOTES above)" >&2
echo
echo "installed $release in $namespace"
