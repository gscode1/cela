#!/usr/bin/env bash
# Smoke test of an installed pi-durable (docs/install-plan.md section 7, step 5), made for the kind cluster of
# hack/kind-up.sh and run by the kind CI job:
#
#   hack/kind-smoke.sh [--name pi-durable] [--namespace pi-durable] [--status]
#
#   1. GET /admin/status: print the runtime and the isolation probe. With NETPOL_ENFORCED=1 anything but `enforced` fails.
#      Without it the run fails when the probe finds any target reachable except the Kubernetes API, which kindnet cannot
#      protect (it does not filter traffic to hostNetwork Pods such as the API server, kubelet and etcd): a warning only
#   2. create a session on the scripted model (no LLM, no credentials)
#   3. send a plain message and read the answer (`echo: <text>`)
#   4. one tool call in the sandbox: write a marker into /workspace and read it back (runc on kind)
#   5. delete the sandbox Pod; the Sandbox controller starts another one; a second tool call reads the same marker from
#      the workspace PVC
#   6. delete the session; the SandboxClaim and the workspace PVC are gone
#
# --status runs step 1 only (kind-up.sh uses it). The API is called from inside an ingest pod (hack/kind-client.mjs): no
# port-forward, and the API token never leaves the cluster or reaches a log. Only kind contexts are used.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=${KIND_CLUSTER_NAME:-pi-durable}
namespace=pi-durable
status_only=0
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--status]   (NETPOL_ENFORCED=1: fail unless the probe says enforced)" >&2
  exit 64
}
die() {
  echo "smoke: $*" >&2
  exit 1
}
log() { printf '\n## %s\n' "$*"; }

while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --status) status_only=1; shift ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die "bad namespace '$namespace'"
command -v kubectl >/dev/null 2>&1 || die "kubectl is required"

ctx=kind-$name
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }
client_js=$(cat "$root/hack/kind-client.mjs")
# Runs one hack/kind-client.mjs command inside an ingest pod.
api() {
  k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$client_js" "$1" "$owner" "${@:2}"
}
check() { # what, output, pattern
  if grep -Eq -- "$3" <<<"$2"; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected /$3/)" >&2
    printf '%s\n' "$2" >&2
    exit 1
  fi
}
script_json() { # final bash-command -> the JSON script a message carries (hack/kind-client.mjs; packages/orchestrator/src/model.ts)
  node -e 'console.log(JSON.stringify({ steps: [{ bash: process.argv[2], timeout: 120 }], final: process.argv[1] }))' "$1" "$2"
}

# ------------------------------------------------------------------ 1. status
log "runtime and isolation probe (GET /admin/status)"
status=
for attempt in $(seq 1 60); do
  rc=0
  final=0
  [[ $attempt -lt 60 ]] || final=1
  status=$(api status "$final" 2>&1) || rc=$?
  [[ $rc -eq 3 ]] || break
  sleep 2
done
printf '%s\n' "$status"
[[ $rc -eq 0 ]] || die "could not read GET /admin/status (exit $rc)"
if ! grep -q '^isolation-probe state=enforced ' <<<"$status"; then
  if [[ ${NETPOL_ENFORCED:-} == 1 ]]; then
    die "NETPOL_ENFORCED=1 and the isolation probe did not report enforced (detail above)"
  fi
  # `probe-target <name> <address> <outcome> <verdict>`: a target a sandbox reached other than the API server is a leak.
  leaks=$(awk '$1 == "probe-target" && $5 == "reachable" && $2 != "kube-api" { print $2 }' <<<"$status")
  [[ -z $leaks ]] || die "the isolation probe found a sandbox able to reach: $(tr '\n' ' ' <<<"$leaks")(detail above)"
  echo "WARNING: the isolation probe did not report enforced (detail above). On kindnet that is expected when only the kube-api target is reachable: kindnet does not filter traffic to hostNetwork Pods (API server, kubelet, etcd)" >&2
fi
[[ $status_only -eq 0 ]] || exit 0

# ------------------------------------------------------------------ 2-3. session and a plain message
marker=kind-marker-$(openssl rand -hex 6)
log "create a session (scripted model)"
out=$(api create)
session=$(sed -n 's/^session //p' <<<"$out")
[[ -n $session ]] || die "no session id: $out"
echo "session $session"
cleanup() {
  # Best effort when a step failed: do not leave the session's sandbox and PVC behind.
  api delete "$session" 120 >/dev/null 2>&1 || true
}
trap cleanup EXIT

log "send a message, read the answer"
out=$(api ask "$session" "hello $marker" "echo: hello $marker" 180)
check "the scripted model echoed the message" "$out" "ANSWER echo: hello $marker"

# ------------------------------------------------------------------ 4. a tool call in the sandbox
log "tool call in the sandbox (first call creates the SandboxClaim, Pod and PVC)"
out=$(api ask "$session" "$(script_json "wrote-$marker" "echo $marker >/workspace/marker && cat /workspace/marker && id -u && uname -s")" "wrote-$marker" 600)
check "the tool call ran and read its workspace marker back" "$out" "TOOL .*$marker"
check "the tool call ran as a non-root user" "$out" "TOOL .*$marker [1-9][0-9]* Linux"
pod=$(k get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.ownerReferences[0].kind}{"\n"}{end}' | awk '$2 == "Sandbox" { print $1; exit }')
[[ -n $pod ]] || die "no sandbox Pod found"
runtime=$(k get pod "$pod" -o jsonpath='{.spec.runtimeClassName}')
echo "sandbox Pod $pod, runtimeClassName=${runtime:-(node default, runc)}"
claim=$(k get sandboxclaims -o name | head -1)
[[ -n $claim ]] || die "no SandboxClaim found"

# ------------------------------------------------------------------ 5. replace the Pod
log "replace the sandbox Pod; the workspace marker must survive on the PVC"
k delete pod "$pod" --wait=true >/dev/null
# The Sandbox keeps its name, so the replacement has the old Pod's name: it is the old one gone (--wait above) and a
# Running one back.
new=
for _ in $(seq 1 90); do
  new=$(k get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.ownerReferences[0].kind}{" "}{.status.phase}{"\n"}{end}' | awk '$2 == "Sandbox" && $3 == "Running" { print $1; exit }')
  [[ -z $new ]] || break
  sleep 2
done
[[ -n $new ]] || die "the Sandbox controller did not start a replacement Pod within 3 minutes"
echo "replacement Pod $new"
out=$(api ask "$session" "$(script_json "reread-$marker" "cat /workspace/marker")" "reread-$marker" 600)
check "the marker survived the Pod replacement" "$out" "TOOL .*$marker"

# ------------------------------------------------------------------ 6. delete
log "delete the session; claim and PVC must be gone"
trap - EXIT
api delete "$session" 180
claims=$(k get sandboxclaims -o name)
[[ -z $claims ]] || die "SandboxClaim still exists after the session was deleted: $claims"
pvcs=$(k get pvc -o name | grep -v 'pi-postgres' || true)
[[ -z $pvcs ]] || die "workspace PVC still exists after the session was deleted: $pvcs"
echo "ok: claim and workspace PVC are gone"
echo
echo "smoke passed"
