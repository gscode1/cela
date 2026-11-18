#!/usr/bin/env bash
# Live check that an OPEN tunnel is closed when the rules change, on a THROWAWAY kind cluster (epic #50, slice 7,
# docs/decisions/0039-egress-revocation.md). Each proxy replica re-judges its own open tunnels on every snapshot, so the
# check holds a long response open through EACH replica (the sandbox dials the replica's Pod address, not the Service),
# changes the rules, and measures how long the tunnel lives:
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy   # 2 replicas by default
#   hack/egress-revoke-smoke.sh [--name pi-egress] [--namespace pi-durable] [--echo-host httpbingo.org]
#   hack/kind-down.sh --name pi-egress
#
# The held tunnel is a node fetch of <echo-host>/drip (a response that takes minutes) from inside a real session's sandbox
# (the orchestrator image's node binary is copied into the workspace; the sandbox image has no curl). The clock is the
# sandbox's, the proxy's own `tunnel-revoked` log line (reason, session, host, port; never a token) is the second witness.
#
#   a. delete the rule that allows the tunnel (session B, route direct)                    -> closed within 10 s on both replicas
#   b. delete the session (session C, route direct)                                        -> closed within 10 s on both replicas
#   c. delete the binding of a route=onecli tunnel (session A)                              -> closed within 10 s on both replicas
#   d. stop Postgres: the proxies go stale after 2 min and close every open tunnel          -> closed within 2 min 10 s
#
# Sessions A and B keep streaming while the others are revoked (a revocation closes only what it denies). The script refuses
# the cluster pi-durable and any context that is not kind. Tokens and keys are never printed. Every check prints `ok: ...` or
# `FAIL: ...`; the first failure stops the run, the cleanup (Postgres back up, sessions deleted) still runs.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
echo_host=httpbingo.org
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--echo-host HOST]" >&2
  exit 64
}
die() {
  echo "egress-revoke-smoke: $*" >&2
  exit 1
}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --echo-host) [[ $# -ge 2 ]] || usage; echo_host=$2; shift 2 ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script creates sessions, OneCLI agents and rules. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
[[ $echo_host =~ ^[a-z0-9.-]+$ ]] || die "bad echo host"
for tool in kubectl node base64; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
contexts=$(kubectl config get-contexts -o name)
grep -qx -- "$ctx" <<<"$contexts" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }
scratch=$(mktemp -d)

ok() { echo "ok: $1"; }
fail() {
  echo "FAIL: $1" >&2
  [[ -z ${2:-} ]] || printf '%s\n' "$2" >&2
  exit 1
}
check() { # what, output, pattern
  grep -Eq -- "$3" <<<"$2" || fail "$1 (wanted /$3/)" "$2"
  ok "$1"
}

# ------------------------------------------------------------------ the APIs, from inside an ingest pod
api_js=$(
  cat <<'JS'
const [method, path, body] = process.argv.slice(1);
let token = "";
for (const entry of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) {
  const line = entry.trim();
  const at = line.indexOf(":");
  if (at > 0 && line.slice(0, at) === process.env.OWNER) token = line.slice(at + 1);
}
if (token === "") { console.error("no token for the owner"); process.exit(2); }
const res = await fetch(`http://127.0.0.1:${process.env.PI_INGEST_PORT ?? "8080"}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body,
  signal: AbortSignal.timeout(20000),
});
console.log(res.status);
console.log(await res.text());
JS
)
api() { # METHOD PATH [JSON] -> the body; fails unless the status is 2xx
  local out status
  out=$(k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e "$api_js" "$@") || fail "admin API call $1 $2 failed" "$out"
  status=$(head -1 <<<"$out")
  [[ $status == 2?? ]] || fail "admin API $1 $2 answered $status" "$(tail -n +2 <<<"$out")"
  tail -n +2 <<<"$out"
}
jq_() { node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const f = new Function("j", "return " + process.argv[1]); const v = f(j); console.log(typeof v === "object" ? JSON.stringify(v) : String(v))' "$1"; }
client_js=$(cat "$root/hack/kind-client.mjs")
kc() { k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$client_js" "$1" "$owner" "${@:2}"; }
script_json() { node -e 'console.log(JSON.stringify({ steps: [{ bash: process.argv[2], timeout: 120 }], final: process.argv[1] }))' "$1" "$2"; }
sandbox() { kc ask "$1" "$(script_json "$2" "$3")" "$2" 600; }
driver_js=$(cat "$root/hack/egress-onecli-driver.mjs")
driver() { k exec -i deploy/pi-orchestrator -- node --input-type=module -e "$driver_js" "$@"; }
pod_of() {
  local claim
  claim=$(k get sandboxclaims -l "pi-durable-k8s/session-id=$1" -o jsonpath='{.items[0].metadata.name}')
  [[ -n $claim ]] || fail "no SandboxClaim for session $1"
  echo "$claim"
}
epoch_in() { k exec "$1" -- date +%s; }

# The sandbox image has git and bash, no curl. The smoke test copies the orchestrator image's node binary into the
# workspace (a throwaway file) and uses it like a tool in the sandbox would: NODE_USE_ENV_PROXY=1 makes fetch honour
# HTTPS_PROXY, the same switch the real session env sets.
install_node() {
  k exec deploy/pi-orchestrator -- cat /usr/local/bin/node | k exec -i "$1" -- bash -c 'cat > /workspace/.smoke-node && chmod +x /workspace/.smoke-node'
}


# ------------------------------------------------------------------ helpers for held tunnels
stream_js=$(
  cat <<'JS'
// httpbingo caps a drip at about 10 s, so the tunnel is held with back-to-back drips: keep-alive reuses the one CONNECT
// tunnel, and the first failure (a closed tunnel, or a new CONNECT the proxy denies) ends the loop. One line per event,
// epoch seconds.
const now = () => Math.floor(Date.now() / 1000);
console.log("START", now());
const until = Date.now() + Number(process.argv[3]) * 1000;
let n = 0;
try {
  while (Date.now() < until) {
    const r = await fetch(process.argv[2]);
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    for await (const chunk of r.body) { n += chunk.length; console.log("DATA", now(), n); }
  }
  console.log("END-CLEAN", now(), n);
} catch (e) {
  console.log("END-ERR", now(), n, e.cause?.code ?? e.message);
}
JS
)

replica_names=()
replica_ips=()
load_replicas() {
  local line
  replica_names=()
  replica_ips=()
  while read -r pod ip; do
    [[ -n $pod ]] || continue
    replica_names+=("$pod")
    replica_ips+=("$ip")
  done < <(k get pods -l app.kubernetes.io/name=pi-egress-proxy --field-selector=status.phase=Running -o jsonpath='{range .items[*]}{.metadata.name} {.status.podIP}{"\n"}{end}')
  ((${#replica_names[@]} >= 2)) || fail "need 2 proxy replicas, found ${#replica_names[@]}"
}

# New session with its sandbox up; prints "<session>" and leaves its proxy URL in /workspace/.egress-url and node in /workspace.
new_session() { # tag
  local s out
  s=$(kc create | sed -n 's/^session //p')
  [[ -n $s ]] || fail "could not create a session"
  sessions+=("$s")
  out=$(sandbox "$s" "env-$1-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url; echo END")
  local pod
  pod=$(pod_of "$s")
  install_node "$pod"
  printf '%s\n' "$stream_js" | k exec -i "$pod" -- bash -c 'cat > /workspace/.rv-stream.mjs'
  echo "$s"
}
url_of() { k exec "$1" -- cat /workspace/.egress-url; } # pod

# Hold a tunnel open through ONE replica: start() POD TAG REPLICA_IP CA(0|1) SECONDS -- the session's proxy URL on stdin.
start() {
  local pod=$1 tag=$2 ip=$3 ca=$4 secs=$5 url extra=""
  read -r url
  url=$(sed "s#@[^@]*\$#@$ip:3128#" <<<"$url")
  [[ $ca != 1 ]] || extra="export NODE_EXTRA_CA_CERTS=/workspace/.onecli/ca.pem;"
  printf '%s\n' "$url" | k exec -i "$pod" -- bash -c "read -r HTTPS_PROXY; export HTTPS_PROXY NODE_USE_ENV_PROXY=1; $extra rm -f /workspace/.rv-$tag.log; nohup /workspace/.smoke-node /workspace/.rv-stream.mjs 'https://$echo_host/drip?duration=8&numbytes=8' $secs > /workspace/.rv-$tag.log 2>&1 < /dev/null &"
}
rv_log() { k exec "$1" -- cat "/workspace/.rv-$2.log" 2>/dev/null || true; } # pod tag
alive() { # pod tag: data has arrived and the stream has not ended
  local log
  log=$(rv_log "$1" "$2")
  grep -q '^DATA' <<<"$log" && ! grep -q '^END' <<<"$log"
}
wait_streaming() { # pod tag
  local i
  for i in $(seq 1 40); do
    alive "$1" "$2" && return 0
    sleep 1
  done
  fail "the held tunnel $2 never started streaming" "$(rv_log "$1" "$2")"
}
# end_epoch POD TAG BUDGET-SECONDS: waits for the END line; prints its epoch
end_epoch() {
  local log i
  for i in $(seq 1 "$3"); do
    log=$(rv_log "$1" "$2")
    if grep -q '^END' <<<"$log"; then sed -n 's/^END-[A-Z]* \([0-9]*\).*/\1/p' <<<"$log" | head -1; return 0; fi
    sleep 1
  done
  return 1
}
# revoked_epoch REPLICA SESSION REASON: epoch seconds of the proxy's tunnel-revoked event, empty if none
revoked_epoch() {
  k logs "$1" --tail=-1 2>/dev/null | grep '"tunnel-revoked"' | grep -F "\"session\":\"$2\"" | grep -F "\"reason\":\"$3\"" |
    node -e 'let t = ""; process.stdin.on("data", (d) => (t += d)).on("end", () => { const l = t.trim().split("\n").filter(Boolean); if (l.length) console.log(Math.floor(Date.parse(JSON.parse(l[0]).time) / 1000)); })'
}
# revoked_event REPLICA SESSION REASON: the event's fields (never a token)
revoked_event() {
  k logs "$1" --tail=-1 2>/dev/null | grep '"tunnel-revoked"' | grep -F "\"session\":\"$2\"" | grep -F "\"reason\":\"$3\"" | head -1 |
    node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(`session=${j.session} host=${j.host} port=${j.port} route=${j.route} reason=${j.reason}`)'
}

# The held tunnel through replica i of the pod ended with an error within the budget of t0 (sandbox clock).
expect_ended() { # what pod t0 budget tag0 tag1
  local what=$1 pod=$2 t0=$3 budget=$4 i end tag
  for i in 0 1; do
    tag=$5
    [[ $i == 0 ]] || tag=$6
    end=$(end_epoch "$pod" "$tag" $((budget + 5))) || fail "$what: the tunnel through ${replica_names[$i]} is still open $((budget + 5)) s later" "$(rv_log "$pod" "$tag" | tail -3)"
    ((end - t0 <= budget)) || fail "$what: the tunnel through ${replica_names[$i]} ended $((end - t0)) s after the change (budget $budget s)"
    grep -q '^END-ERR' <<<"$(rv_log "$pod" "$tag")" || fail "$what: the tunnel through ${replica_names[$i]} ended without an error" "$(rv_log "$pod" "$tag" | tail -2)"
    ok "$what: the tunnel through ${replica_names[$i]} ended $((end - t0)) s after the change (budget $budget s)"
  done
}
# Each replica logged tunnel-revoked for the session with the reason, within the budget of t0.
expect_logged() { # what session reason t0 budget
  local what=$1 sess=$2 reason=$3 t0=$4 budget=$5 i rev
  for i in 0 1; do
    for _ in $(seq 1 15); do
      rev=$(revoked_epoch "${replica_names[$i]}" "$sess" "$reason")
      [[ -z $rev ]] || break
      sleep 1
    done
    [[ -n $rev ]] || fail "$what: replica ${replica_names[$i]} logged no tunnel-revoked event with reason $reason for the session"
    ((rev - t0 <= budget)) || fail "$what: replica ${replica_names[$i]} logged the revocation $((rev - t0)) s after the change (budget $budget s)"
    ok "$what: ${replica_names[$i]} logged tunnel-revoked $((rev - t0)) s after the change ($(revoked_event "${replica_names[$i]}" "$sess" "$reason"))"
  done
}

# ------------------------------------------------------------------ cleanup, always
sessions=()
postgres_down=""
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  if [[ -n $postgres_down ]]; then
    k scale statefulset/pi-postgres --replicas=1 >/dev/null 2>&1
    k rollout status statefulset/pi-postgres --timeout=180s >/dev/null 2>&1
  fi
  for s in ${sessions[@]+"${sessions[@]}"}; do
    kc delete "$s" 120 >/dev/null 2>&1
    driver cleanup "$s" >/dev/null 2>&1
  done
  [[ -z ${echo_allowed:-} ]] || driver disallow-host "$echo_host" >/dev/null 2>&1
  rm -rf "$scratch"
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 0. the chain
echo "## 0. two proxy replicas serve, the OneCLI route is configured"
start_wait=$SECONDS
while true; do
  status=$(api GET /admin/egress/status)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status")
  [[ $n -ge 2 ]] && break
  ((SECONDS - start_wait < 120)) || fail "two proxy replicas serving at the current revision" "$status"
  sleep 2
done
ok "$n proxy replicas serve revision $(jq_ 'j.revision' <<<"$status")"
load_replicas
ok "replicas: ${replica_names[*]}"
upstream=$(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EGRESS_UPSTREAM_ADDR")].value}')
[[ $upstream =~ :10255$ ]] || fail "the proxy has no EGRESS_UPSTREAM_ADDR on the gateway port (was the cluster made with --onecli --egress-proxy?)" "$upstream"
m=m$RANDOM

# ------------------------------------------------------------------ 1. sessions and held tunnels
echo "## 1. sessions A (onecli route), B and C (direct route) each hold a tunnel through each replica"
driver allow-host "$echo_host" >/dev/null
echo_allowed=1
sa=$(new_session a)
pod_a=$(pod_of "$sa")
prov=$(driver provision "$sa" "$echo_host")
check "A has a binding and the onecli route for $echo_host" "$(driver facts "$sa")" "bindings 1 rules 3 principal-live 1"
kubectl --context "$ctx" -n "$namespace" get configmap pi-onecli-ca -o jsonpath='{.data.ca\.pem}' | k exec -i "$pod_a" -- bash -c 'mkdir -p /workspace/.onecli && cat > /workspace/.onecli/ca.pem'
url_a=$(url_of "$pod_a")
[[ $url_a == http://x:*@* ]] || fail "could not read A's proxy URL"

sb=$(new_session b)
pod_b=$(pod_of "$sb")
url_b=$(url_of "$pod_b")
rule_b=$(api POST "/admin/egress/sessions/$sb/rules" "{\"effect\":\"allow\",\"host\":\"$echo_host\",\"route\":\"direct\"}")
rid_b=$(jq_ 'j.id' <<<"$rule_b")

sc=$(new_session c)
pod_c=$(pod_of "$sc")
url_c=$(url_of "$pod_c")
api POST "/admin/egress/sessions/$sc/rules" "{\"effect\":\"allow\",\"host\":\"$echo_host\",\"route\":\"direct\"}" >/dev/null
sleep 6 # one poll: every replica has the rules
for i in 0 1; do
  printf '%s\n' "$url_a" | start "$pod_a" "a$i" "${replica_ips[$i]}" 1 170
  printf '%s\n' "$url_b" | start "$pod_b" "b$i" "${replica_ips[$i]}" 0 170
  printf '%s\n' "$url_c" | start "$pod_c" "c$i" "${replica_ips[$i]}" 0 170
done
for i in 0 1; do
  wait_streaming "$pod_a" "a$i"
  wait_streaming "$pod_b" "b$i"
  wait_streaming "$pod_c" "c$i"
done
ok "six tunnels are streaming: A (onecli), B and C (direct), one through each replica"

# ------------------------------------------------------------------ a. delete the rule
echo "## a. deleting the rule that allows B's tunnel"
rev=$(jq_ 'j.revision' <<<"$(api GET /admin/egress/status)")
t0=$(epoch_in "$pod_b")
api DELETE "/admin/egress/rules/$rid_b?expectedRevision=$rev" >/dev/null
expect_ended "rule delete" "$pod_b" "$t0" 10 b0 b1
expect_logged "rule delete" "$sb" rule-denied "$t0" 10
alive "$pod_a" a0 && alive "$pod_a" a1 && alive "$pod_c" c0 && alive "$pod_c" c1 || fail "a revocation closed a tunnel of another session"
ok "the tunnels of A and C are still streaming (only what the rules deny is closed)"

# ------------------------------------------------------------------ b. delete the session
echo "## b. deleting session C"
t0=$(epoch_in "$pod_c")
kc delete "$sc" 180 >/dev/null
sessions=("$sa" "$sb")
# The sandbox is destroyed by the delete, so its own log is gone: the proxies' events are the witness.
expect_logged "session delete" "$sc" principal-revoked "$t0" 10
alive "$pod_a" a0 && alive "$pod_a" a1 || fail "deleting C closed a tunnel of A"
ok "A's tunnels are still streaming"

# ------------------------------------------------------------------ c. delete the binding
echo "## c. deleting the binding of A's onecli tunnels"
t0=$(epoch_in "$pod_a")
driver unbind "$sa" >/dev/null
expect_ended "binding delete" "$pod_a" "$t0" 10 a0 a1
expect_logged "binding delete" "$sa" binding-removed "$t0" 10
driver bind "$sa" >/dev/null

# ------------------------------------------------------------------ d. Postgres down
echo "## d. stopping Postgres: the proxies go stale after 2 min and close every open tunnel"
rule_b=$(api POST "/admin/egress/sessions/$sb/rules" "{\"effect\":\"allow\",\"host\":\"$echo_host\",\"route\":\"direct\"}")
sleep 6
for i in 0 1; do
  printf '%s\n' "$url_b" | start "$pod_b" "d$i" "${replica_ips[$i]}" 0 240
done
wait_streaming "$pod_b" d0
wait_streaming "$pod_b" d1
ok "B holds a new tunnel through each replica"
t0=$(epoch_in "$pod_b")
postgres_down=1
k scale statefulset/pi-postgres --replicas=0 >/dev/null
echo "Postgres is down; waiting for the stale limit (2 min) ..."
for i in 0 1; do
  tag=d$i
  end=$(end_epoch "$pod_b" "$tag" 150) || fail "the tunnel through ${replica_names[$i]} is still open 150 s after Postgres stopped" "$(rv_log "$pod_b" "$tag" | tail -3)"
  ((end - t0 <= 130)) || fail "the tunnel through ${replica_names[$i]} ended $((end - t0)) s after Postgres stopped (budget 130 s = 2 min + 10 s)"
  ((end - t0 >= 100)) || fail "the tunnel through ${replica_names[$i]} ended after only $((end - t0)) s: it was not the stale limit"
  ok "stale: the tunnel through ${replica_names[$i]} ended $((end - t0)) s after Postgres stopped (budget 130 s)"
done
expect_logged "stale" "$sb" stale "$t0" 130
k scale statefulset/pi-postgres --replicas=1 >/dev/null
k rollout status statefulset/pi-postgres --timeout=180s >/dev/null
postgres_down=""
start_wait=$SECONDS
while true; do
  status=$(api GET /admin/egress/status 2>/dev/null) || status=""
  n=0
  [[ -z $status ]] || n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving").length' <<<"$status")
  [[ $n -ge 2 ]] && break
  ((SECONDS - start_wait < 180)) || fail "both proxy replicas serving again after Postgres came back" "$status"
  sleep 3
done
ok "Postgres is back: both replicas serve again"
echo
echo "egress-revoke-smoke: all checks passed"
