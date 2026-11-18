#!/usr/bin/env bash
# Live check of the OneCLI route and per-session bindings on a THROWAWAY kind cluster (epic #50, slice 5,
# docs/decisions/0037-egress-onecli-route.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy
#   hack/egress-onecli-smoke.sh [--name pi-egress] [--namespace pi-durable] [--echo-host httpbingo.org]
#   hack/kind-down.sh --name pi-egress
#
# A throwaway cluster has no GitHub App, so no real repo session can be made. The script makes a plain session and runs the
# orchestrator's own RepoAccess for it from inside the orchestrator pod (hack/egress-onecli-driver.mjs): the same code that
# makes the OneCLI agent, narrows its grants, seals its token into egress.bindings and creates the session rules for
# github.com and api.github.com, with a fake GitHub that mints a dummy token. Everything after that is the real chain:
# sandbox -> egress proxy -> OneCLI gateway -> the internet. api.github.com answers 401 "Bad credentials" only when an
# Authorization header arrives (the dummy token OneCLI injects), which proves the injection; <echo-host> returns the headers
# it received, which shows what an origin sees. The script refuses the cluster pi-durable and any context that is not kind.
# Tokens and keys are never printed (a token that must move goes through a variable and a pipe). Every check prints
# `ok: ...` or `FAIL: ...`; the first failure stops the run, the cleanup still runs.
#
#   1. before: no binding and no rule, the OneCLI hosts are denied; the sandbox env holds no OneCLI token
#   2. after RepoAccess: connections to api.github.com and the echo host are allowed with route onecli; OneCLI injects (401
#      Bad credentials from GitHub, the credential in the echo); OneCLI's log names the session's agent; the origin never
#      sees the egress token, the OneCLI token or a Proxy-Authorization header; the sandbox needs OneCLI's CA for it
#   3. the proxy's pod label reaches the OneCLI gateway port through the NetworkPolicy and nothing else of OneCLI
#   4. no binding: denied within 10 s and never direct; a binding again: allowed again
#   5. session B (a rule, no binding) is denied; A's sealed row copied onto B does not open; A's token from B's Pod is refused
#   6. deleting A removes its binding and rules and refuses its token within 10 s
# (Open tunnels are closed by the proxy itself on every snapshot, ADR 0039; hack/egress-revoke-smoke.sh checks that. The
# admin endpoint that an earlier version of this script used to close one was removed in slice 7.)
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
  echo "egress-onecli-smoke: $*" >&2
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

# CONNECT <host>:443 through the proxy of $HTTPS_PROXY; prints "<host> <status line>". The token is read from the variable.
conn_fn='ph=${HTTPS_PROXY#*@}; pp=${ph##*:}; ph=${ph%:*}; tok=${HTTPS_PROXY#http://x:}; tok=${tok%%@*}; auth=$(printf "x:%s" "$tok" | base64 -w0);
conn() { exec 3<>/dev/tcp/$ph/$pp || { echo "$1 noconnect"; return; }; printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\nProxy-Authorization: Basic %s\r\n\r\n" "$1" "$1" "$auth" >&3; read -t 15 -r line <&3; exec 3>&-; echo "$1 ${line%$(printf "\r")}"; }'
one() { # pod host -- the proxy URL on stdin
  k exec -i "$1" -- bash -c "read -r HTTPS_PROXY; $conn_fn; conn $2"
}
watch() { # pod host outfile -- the proxy URL on stdin; one "<epoch> <status>" line every 0.5 s
  k exec -i "$1" -- bash -c "read -r HTTPS_PROXY; $conn_fn; while true; do echo \"\$(date +%s) \$(conn $2)\"; sleep 0.5; done" >"$3" 2>/dev/null
}
# The sandbox image has git and bash, no curl. The smoke test copies the orchestrator image's node binary into the
# workspace (a throwaway file) and uses it like a tool in the sandbox would: NODE_USE_ENV_PROXY=1 makes fetch honour
# HTTPS_PROXY, the same switch the real session env sets. install_node POD; nfetch POD CA(0|1) URL -- the proxy URL on stdin;
# prints the body, then "STATUS <code>" (000 and "ERROR <code>" when the request failed).
install_node() {
  k exec deploy/pi-orchestrator -- cat /usr/local/bin/node | k exec -i "$1" -- bash -c 'cat > /workspace/.smoke-node && chmod +x /workspace/.smoke-node'
}
node_fetch_js='fetch(process.argv[1], { signal: AbortSignal.timeout(25000) }).then(async (r) => { console.log((await r.text()).slice(0, 3000)); console.log("STATUS", r.status); }).catch((e) => { console.log("ERROR", e.cause?.code ?? e.message); console.log("STATUS 000"); })'
nfetch() {
  local pod=$1 ca=$2 url=$3 extra=""
  [[ $ca != 1 ]] || extra="export NODE_EXTRA_CA_CERTS=/workspace/.onecli/ca.pem;"
  k exec -i "$pod" -- bash -c "read -r HTTPS_PROXY; export HTTPS_PROXY NODE_USE_ENV_PROXY=1; $extra /workspace/.smoke-node -e '$node_fetch_js' '$url' 2>&1"
}

# ------------------------------------------------------------------ cleanup, always
sessions=()
watchers=()
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for w in ${watchers[@]+"${watchers[@]}"}; do kill "$w" 2>/dev/null; done
  for s in ${sessions[@]+"${sessions[@]}"}; do
    kc delete "$s" 120 >/dev/null 2>&1
    driver cleanup "$s" >/dev/null 2>&1
  done
  [[ -z ${echo_allowed:-} ]] || driver disallow-host "$echo_host" >/dev/null 2>&1
  kubectl --context "$ctx" -n "$namespace" delete pod smoke-proxy-label --ignore-not-found --wait=false >/dev/null 2>&1
  rm -rf "$scratch"
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 0. the chain is deployed
echo "## 0. the proxy, OneCLI and the binding key are in place"
start=$SECONDS
while true; do
  status=$(api GET /admin/egress/status)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status")
  [[ $n -ge 1 ]] && break
  ((SECONDS - start < 120)) || fail "a proxy replica serving at the current revision" "$status"
  sleep 2
done
ok "the proxy serves revision $(jq_ 'j.revision' <<<"$status")"
upstream=$(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EGRESS_UPSTREAM_ADDR")].value}')
[[ $upstream =~ :10255$ ]] || fail "the proxy has no EGRESS_UPSTREAM_ADDR on the gateway port (was the cluster made with --onecli --egress-proxy?)" "$upstream"
ok "the proxy's one upstream is the OneCLI gateway ($upstream)"
[[ -n $(k get networkpolicy egress-proxy-allow-onecli-egress --ignore-not-found -o name) ]] || fail "the chart's NetworkPolicy egress-proxy-allow-onecli-egress is missing"
k get networkpolicy onecli-gateway-allow-ingress -o json | grep -q pi-egress-proxy || fail "OneCLI's gateway ingress policy does not admit the egress proxy"
ok "the proxy's egress policy and the gateway's ingress policy both name the other side"
[[ -n $(k get deploy pi-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_EGRESS_BINDING_KEY_FILE")].value}') ]] || fail "the orchestrator has no PI_EGRESS_BINDING_KEY_FILE"
ok "the orchestrator and the proxy mount the binding key"

# ------------------------------------------------------------------ 1. a session, before anything is bound
echo "## 1. before: no binding, no rule; no OneCLI token in the sandbox"
sa=$(kc create | sed -n 's/^session //p')
sessions+=("$sa")
[[ -n $sa ]] || fail "could not create session A"
m=m$RANDOM
out=$(sandbox "$sa" "env-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url; echo ENV; env | grep -c 'aoc_' || true; env | grep -ciE '^https?_proxy=.*onecli' || true; echo END")
check "A's sandbox env holds no aoc_ token and no proxy variable naming OneCLI" "$out" "ENV 0 0 "
pod_a=$(pod_of "$sa")
url_a=$(k exec "$pod_a" -- cat /workspace/.egress-url)
[[ $url_a == http://x:*@* ]] || fail "could not read A's proxy URL from its workspace"
before=$(printf '%s\n' "$url_a" | one "$pod_a" api.github.com)
check "api.github.com is denied before the session has OneCLI access" "$before" "api.github.com HTTP/1.1 407"
facts=$(driver facts "$sa")
check "no binding and no session rule yet" "$facts" "bindings 0 rules 0 principal-live 1"

# ------------------------------------------------------------------ 2. the route
echo "## 2. RepoAccess provisions the session; credentialed traffic goes sandbox -> proxy -> OneCLI -> origin"
# The bundled OneCLI blocks every host that hack/onecli-host-rules.sh did not allow; the echo host needs an allow rule
# (created before the block rule, which is then re-created last). It is removed again at the end.
driver allow-host "$echo_host" >/dev/null
echo_allowed=1
prov=$(driver provision "$sa" "$echo_host")
echo "$prov" | grep -v '^echo-credential' | sed 's/^/  driver: /'
check "RepoAccess's shell env for a repo session holds no OneCLI token" "$prov" "env-has-onecli-token no"
check "and no OneCLI gateway address" "$prov" "env-has-onecli-gateway no"
# The address of the Service, not its name: a proxied sandbox has no DNS (ADR 0038).
proxy_ip=$(k get svc pi-egress-proxy -o jsonpath='{.spec.clusterIP}')
check "and points at the egress proxy" "$prov" "env-proxy $(sed 's/\./\\./g' <<<"$proxy_ip"):3128"
cred=$(sed -n 's/^echo-credential //p' <<<"$prov")
[[ -n $cred ]] || fail "the driver did not report the echo credential"
facts=$(driver facts "$sa")
check "a binding and the session rules exist for A" "$facts" "bindings 1 rules 3 principal-live 1"
dump=$(k exec deploy/pi-orchestrator -- node --input-type=module -e 'const {createPool}=await import("/app/node_modules/@pi-durable-k8s/session-core/dist/index.js"); const {loadConfig}=await import("/app/dist/config.js"); const c=loadConfig(process.env); const p=createPool(c.databaseUrl,"smoke",1,c.databaseTls); const r=await p.query("select session_id, key_id, encode(nonce,\x27hex\x27) as nonce, length(ciphertext) as len, encode(ciphertext,\x27hex\x27) as ct from egress.bindings"); console.log(JSON.stringify(r.rows)); await p.end()')
printf '%s\n' "$dump" | node -e 'const rows = JSON.parse(require("fs").readFileSync(0, "utf8")); for (const r of rows) console.log(`  binding row: ${r.session_id} key ${r.key_id} nonce ${r.nonce} ciphertext ${r.len} bytes (${r.ct.slice(0, 16)}...)`)'
check "the stored binding is ciphertext (no aoc_ in the table)" "$(grep -c 'aoc_' <<<"$dump" || true)" "^0$"

for host in api.github.com "$echo_host"; do
  got=$(printf '%s\n' "$url_a" | one "$pod_a" "$host")
  check "CONNECT $host is allowed through the proxy" "$got" "$host HTTP/1.[01] 200"
done
why=$(api POST /admin/egress/explain "{\"host\":\"api.github.com\",\"sessionId\":\"$sa\"}")
check "explain says route onecli and that the session has a binding" "$why" '"route":"onecli"'
check "explain reports the binding" "$why" '"binding":true'
status_now=$(api GET /admin/egress/status)
check "status counts the binding" "$status_now" '"bindings":\{"total":[1-9]'

ca=$(kubectl --context "$ctx" -n "$namespace" get configmap pi-onecli-ca -o jsonpath='{.data.ca\.pem}')
[[ -n $ca ]] || fail "no OneCLI CA in the ConfigMap pi-onecli-ca"
printf '%s\n' "$ca" | k exec -i "$pod_a" -- bash -c 'mkdir -p /workspace/.onecli && cat > /workspace/.onecli/ca.pem'
install_node "$pod_a"
ok "the OneCLI CA is in A's workspace (what prepareWorkspace writes for a repo session) and a node binary is there to make requests"
nocert=$(printf '%s\n' "$url_a" | nfetch "$pod_a" 0 https://api.github.com/)
check "without OneCLI's CA the MITM'd host fails TLS verification in the sandbox" "$nocert" "ERROR [A-Z_]*(CERT|SIGNED|ISSUER)[A-Z_]*"
gh=$(printf '%s\n' "$url_a" | nfetch "$pod_a" 1 https://api.github.com/)
check "api.github.com answers 401 Bad credentials: OneCLI injected the session's token on the way" "$gh" "Bad credentials"
echo_out=$(printf '%s\n' "$url_a" | nfetch "$pod_a" 1 "https://$echo_host/headers")
check "the echo origin got the injected credential" "$echo_out" "$cred"
check "and answered 200" "$echo_out" "STATUS 200"
seen=$(printf '%s\n' "$echo_out" | driver absent "$sa")
check "the origin never saw the session's OneCLI token" "$seen" "onecli-token-in-text no"
check "nor its egress token" "$seen" "egress-token-in-text no"
check "nor a Proxy-Authorization header" "$seen" "proxy-authorization-in-text no"
agent_id=$(sed -n 's/^agent //p' <<<"$prov")
gw_log=$(kubectl --context "$ctx" -n "$namespace" logs -l app.kubernetes.io/name=onecli,app.kubernetes.io/component=gateway --all-containers --tail=-1 --since=10m 2>/dev/null || true)
if grep -q -- "$agent_id" <<<"$gw_log" || grep -q -- "pi-session-$sa" <<<"$gw_log"; then
  ok "OneCLI's gateway log names this session's agent"
else
  echo "note: OneCLI's gateway log has no line naming the agent (log format may not include it); last lines:"
  printf '%s\n' "$gw_log" | tail -5 | cut -c1-200
  gw_log_unproven=1
fi
proxy_log=$(k logs deploy/pi-egress-proxy --all-containers --tail=-1 2>/dev/null || true)
tok_a=${url_a#http://x:}
tok_a=${tok_a%%@*}
if grep -qF -- "$tok_a" <<<"$proxy_log$gw_log"; then fail "A's egress token appears in a log of the proxy or OneCLI"; fi
ok "A's egress token appears in no proxy or OneCLI log"
unset tok_a

# ------------------------------------------------------------------ 3. the network policy
echo "## 3. the proxy's pod label reaches the OneCLI gateway and nothing else of OneCLI"
sandbox_image=$(k get deploy pi-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_SANDBOX_IMAGE")].value}')
[[ -n $sandbox_image ]] || sandbox_image=$(kubectl --context "$ctx" -n "$namespace" get pod "$pod_a" -o jsonpath='{.spec.containers[0].image}')
kubectl --context "$ctx" -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: smoke-proxy-label
  labels: { app.kubernetes.io/name: pi-egress-proxy, app.kubernetes.io/part-of: pi-durable-smoke }
spec:
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: t
      image: $sandbox_image
      imagePullPolicy: IfNotPresent
      command: [sleep, "600"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
YAML
k wait --for=condition=Ready pod/smoke-proxy-label --timeout=120s >/dev/null || fail "the label-test pod did not start"
gw=$(k get svc onecli-gateway -o jsonpath='{.spec.clusterIP}')
api_ip=$(k get svc onecli-api -o jsonpath='{.spec.clusterIP}')
orch=$(k get svc pi-orchestrator -o jsonpath='{.spec.clusterIP}')
probe() { k exec smoke-proxy-label -- bash -c "timeout 4 bash -c 'exec 3<>/dev/tcp/$1/$2' 2>/dev/null && echo open || echo closed"; }
check "the OneCLI gateway ClusterIP $gw:10255 is reachable" "$(probe "$gw" 10255)" "^open$"
check "the OneCLI management API $api_ip:10256 is not" "$(probe "$api_ip" 10256)" "^closed$"
check "the orchestrator $orch:8081 is not" "$(probe "$orch" 8081)" "^closed$"

# ------------------------------------------------------------------ 4. no binding
echo "## 4. no binding: denied, never direct"
printf '%s\n' "$url_a" | watch "$pod_a" api.github.com "$scratch/bind.log" &
watchers+=($!)
sleep 3
check "before: the session reaches api.github.com" "$(tail -1 "$scratch/bind.log")" "HTTP/1.[01] 200"
t0=$(epoch_in "$pod_a")
driver unbind "$sa" >/dev/null
for _ in $(seq 1 30); do
  tail -1 "$scratch/bind.log" | grep -q "HTTP/1.1 407" && break
  sleep 0.5
done
t1=$(grep "HTTP/1.1 407" "$scratch/bind.log" | head -1 | cut -d' ' -f1 || true)
[[ -n $t1 ]] || fail "the proxy kept serving the session after its binding was deleted" "$(tail -5 "$scratch/bind.log")"
((t1 - t0 <= 10)) || fail "the denial took $((t1 - t0)) s"
ok "deleting the binding row made the proxy deny within $((t1 - t0 + 1)) s (budget 10 s)"
kill "${watchers[@]}" 2>/dev/null || true
watchers=()
direct=$(printf '%s\n' "$url_a" | nfetch "$pod_a" 1 https://api.github.com/)
if grep -q "STATUS [0-9]*[1-9]" <<<"$direct" && ! grep -q "STATUS 000" <<<"$direct"; then fail "api.github.com answered 200 without a binding: the proxy fell back to a direct connection" "$direct"; fi
ok "without a binding the request does not reach api.github.com (no direct fallback): $(grep -E '^(ERROR|STATUS)' <<<"$direct" | tr '\n' ' ')"
driver bind "$sa" >/dev/null
sleep 3
again=$(printf '%s\n' "$url_a" | one "$pod_a" api.github.com)
check "sealing the binding again restores the route" "$again" "api.github.com HTTP/1.[01] 200"

# ------------------------------------------------------------------ 5. another session
echo "## 5. session B cannot use A's binding"
sb=$(kc create | sed -n 's/^session //p')
sessions+=("$sb")
[[ -n $sb ]] || fail "could not create session B"
out=$(sandbox "$sb" "envb-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url; echo END")
pod_b=$(pod_of "$sb")
url_b=$(k exec "$pod_b" -- cat /workspace/.egress-url)
api POST "/admin/egress/sessions/$sb/rules" '{"effect":"allow","host":"api.github.com","route":"onecli"}' >/dev/null
sleep 6
check "B has a route=onecli rule and no binding: denied" "$(printf '%s\n' "$url_b" | one "$pod_b" api.github.com)" "api.github.com HTTP/1.1 407"
why=$(api POST /admin/egress/explain "{\"host\":\"api.github.com\",\"sessionId\":\"$sb\"}")
check "explain says B has no binding" "$why" '"binding":false'
driver copy-binding "$sa" "$sb" >/dev/null
sleep 6
check "A's sealed row copied onto B's session id does not open (bound to the session id)" "$(printf '%s\n' "$url_b" | one "$pod_b" api.github.com)" "api.github.com HTTP/1.1 407"
check "A's egress token used from B's Pod is refused" "$(printf '%s\n' "$url_a" | one "$pod_b" api.github.com)" "api.github.com HTTP/1.1 407"
check "A's own token from A's Pod still works" "$(printf '%s\n' "$url_a" | one "$pod_a" api.github.com)" "api.github.com HTTP/1.[01] 200"

# ------------------------------------------------------------------ 6. deleting A
echo "## 6. deleting session A revokes its binding"
printf '%s\n' "$url_a" | watch "$pod_a" api.github.com "$scratch/revoke.log" &
watchers+=($!)
sleep 4
check "before the delete the route works" "$(tail -1 "$scratch/revoke.log")" "HTTP/1.[01] 200"
t0=$(epoch_in "$pod_a")
echo "deleting session A ..."
kc delete "$sa" 180 >/dev/null
sessions=("$sb")
sleep 1
kill "${watchers[@]}" 2>/dev/null || true
watchers=()
t1=$(grep "HTTP/1.1 407" "$scratch/revoke.log" | head -1 | cut -d' ' -f1 || true)
[[ -n $t1 ]] || fail "no refusal observed between the delete and the end of A's Pod" "$(tail -3 "$scratch/revoke.log")"
((t1 - t0 <= 10)) || fail "the refusal came $((t1 - t0)) s after the delete began"
ok "A's route was refused within $((t1 - t0 + 1)) s of the delete (budget 10 s)"
facts=$(driver facts "$sa")
check "A's binding and session rules are gone and its principal is revoked" "$facts" "bindings 0 rules 0 principal-live 0"
driver cleanup "$sa" >/dev/null
ok "the OneCLI agent and secrets of A are removed (the sweep does the same for a session that is gone)"
echo
[[ -z ${gw_log_unproven:-} ]] || echo "unproven: OneCLI's gateway log line naming the agent"
echo "egress-onecli-smoke: all checks passed"
