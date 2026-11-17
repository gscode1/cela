#!/usr/bin/env bash
# Smoke test of an installed pi-durable (docs/install-plan.md section 7, step 5), made for the kind cluster of
# hack/kind-up.sh and run by the kind CI job:
#
#   hack/kind-smoke.sh [--name pi-durable] [--namespace pi-durable] [--status] [--onecli]
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
# --onecli (for hack/kind-up.sh --onecli, the bundled OneCLI) adds, without any model call or credential:
#   1b. the orchestrator's way through the gateway (hack/kind-gateway-check.mjs, inside the orchestrator pod): a CONNECT
#       without a token is refused (407); with the agent token it is accepted, the TLS handshake verifies against the CA
#       ConfigMap, and a host that is not allowed gets the gateway's own 403. The gateway log must show that agent
#   1c. the management API (:10256) answers the orchestrator and not the ingest pod (NetworkPolicy)
#   4b. in the sandbox: the gateway port is open and the API port is closed
#
# --status runs step 1 only (kind-up.sh uses it). The API is called from inside an ingest pod (hack/kind-client.mjs): no
# port-forward, and the API token never leaves the cluster or reaches a log. Only kind contexts are used.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=${KIND_CLUSTER_NAME:-pi-durable}
namespace=pi-durable
status_only=0
onecli=0
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--status] [--onecli]   (NETPOL_ENFORCED=1: fail unless the probe says enforced)" >&2
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
  --onecli) onecli=1; shift ;;
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

# ------------------------------------------------------------------ 1b-1c. bundled OneCLI
if [[ $onecli -eq 1 ]]; then
  log "the orchestrator routes through the OneCLI gateway (no model call)"
  gateway_js=$(cat "$root/hack/kind-gateway-check.mjs")
  out=$(k exec deploy/pi-orchestrator -c orchestrator -- node --input-type=module -e "$gateway_js" 2>&1) || {
    printf '%s\n' "$out" >&2
    die "the gateway check failed"
  }
  printf '%s\n' "$out"
  check "the gateway refuses a CONNECT without the agent token" "$out" "connect-without-token=407"
  check "the gateway accepts the orchestrator's agent token" "$out" "connect-with-token=200"
  check "the gateway certificate verifies against the CA ConfigMap (issued by OneCLI)" "$out" "tls-verified=true issuer=OneCLI"
  check "the gateway answered for a host that is not allowed (policy block, nothing left the cluster)" "$out" "answer-status=403"
  echo "-- gateway log (agent and rule only):"
  logs=$(k logs deploy/onecli-gateway --tail=200 2>&1 | grep -E 'agent="pi-orchestrator"|BLOCKED' | tail -5) || true
  printf '%s\n' "$logs"
  check "the gateway logged the orchestrator's agent" "$logs" 'agent="pi-orchestrator"|BLOCKED'

  log "the OneCLI management API is closed to everything but the orchestrator"
  probe='fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }).then((r) => console.log("reachable " + r.status), (e) => console.log("closed " + (e.cause?.code ?? e.name)))'
  api_url="http://onecli-api.$namespace.svc:10256/v1/health"
  from_orchestrator=$(k exec deploy/pi-orchestrator -c orchestrator -- node -e "$probe" "$api_url")
  from_ingest=$(k exec deploy/pi-ingest -c ingest -- node -e "$probe" "$api_url")
  check "the orchestrator reaches the API" "$from_orchestrator" "^reachable 200"
  check "ingest does not reach the API" "$from_ingest" "^closed"
fi

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

if [[ $onecli -eq 1 ]]; then
  log "from the sandbox: the gateway port is open, the management API port is closed"
  tcp="timeout 5 bash -c 'exec 3<>/dev/tcp/\$0/\$1' "
  cmd="if $tcp onecli-gateway.$namespace.svc 10255 2>/dev/null; then echo gw-open; else echo gw-closed; fi; if $tcp onecli-api.$namespace.svc 10256 2>/dev/null; then echo api-open; else echo api-closed; fi"
  out=$(api ask "$session" "$(script_json "net-$marker" "$cmd")" "net-$marker" 600)
  check "the sandbox reaches the OneCLI gateway" "$out" "gw-open"
  check "the sandbox does not reach the OneCLI management API" "$out" "api-closed"
fi

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
