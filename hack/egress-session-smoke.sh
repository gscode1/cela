#!/usr/bin/env bash
# Live check of per-session egress tokens on a THROWAWAY kind cluster (epic #50, slice 4,
# docs/decisions/0036-egress-principals.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --egress-proxy
#   hack/egress-session-smoke.sh [--name pi-egress] [--namespace pi-durable]
#   hack/kind-down.sh --name pi-egress
#
# It creates sessions, rules and profiles (named smoke-*), checks the chart's sandbox-to-proxy NetworkPolicy and runs a Helm upgrade that turns the proxy off and on again,
# so it refuses the cluster pi-durable and any context that is not a kind cluster. It calls the APIs from inside an ingest
# pod (hack/kind-client.mjs): no API token leaves the cluster. Egress tokens are never printed: the sandbox's proxy
# variables are shown with the password masked, and a token that has to move between two Pods goes through a shell variable
# and a pipe. Every check prints `ok: ...` or `FAIL: ...`; the first failure stops the run, the cleanup still runs.
#
#   1. two sessions on profiles with different rule sets (smoke-gh: github-public, smoke-py: pypi); each sandbox has the
#      proxy variables, and a real `git ls-remote https://github.com/...` runs through the proxy in session A
#   2. a host allowed by A's profile only is allowed for A and denied for B, and the other way round
#   3. a session rule added through the admin API takes effect within 10 s
#   4. A's token used from B's sandbox is denied; from A's own sandbox it works
#   5. deleting A makes its token useless within 10 s
#   6. with egressProxy.enabled=false (the network cutover is then off, ADR 0038) a new session has no proxy variables, no
#      principal exists for it, and git works directly; the proxy is switched on again at the end
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS]" >&2
  exit 64
}
die() {
  echo "egress-session-smoke: $*" >&2
  exit 1
}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script creates sessions and turns the proxy off and on. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl helm node base64; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
kubectl config get-contexts -o name | grep -qx -- "$ctx" || die "no kubectl context $ctx (kind cluster $name)"
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
# sandbox SESSION MARKER BASH -> the tool output lines of one tool call in that session's sandbox
sandbox() { kc ask "$1" "$(script_json "$2" "$3")" "$2" 600; }

# The shell function the sandbox runs: CONNECT <host>:443 through the proxy of $HTTPS_PROXY, prints "<host> <status line>".
# It reads the token from the variable and sends it as Basic credentials; nothing is printed of it.
conn_fn='ph=${HTTPS_PROXY#*@}; pp=${ph##*:}; ph=${ph%:*}; tok=${HTTPS_PROXY#http://x:}; tok=${tok%%@*}; auth=$(printf "x:%s" "$tok" | base64 -w0);
conn() { exec 3<>/dev/tcp/$ph/$pp || { echo "$1 noconnect"; return; }; printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\nProxy-Authorization: Basic %s\r\n\r\n" "$1" "$1" "$auth" >&3; read -t 15 -r line <&3; exec 3>&-; echo "$1 ${line%$(printf "\r")}"; }'
# The token is masked and the proxy's address shortened to P (the tool output is cut at 400 characters).
mask='sed -E "s#(://x:)[^@]*@[0-9.]+:3128#\1***@P#"'
pod_of() { # session -> the sandbox Pod's name (the claim and the Sandbox share a name)
  local claim
  claim=$(k get sandboxclaims -l "pi-durable-k8s/session-id=$1" -o jsonpath='{.items[0].metadata.name}')
  [[ -n $claim ]] || fail "no SandboxClaim for session $1"
  echo "$claim"
}
epoch_in() { k exec "$1" -- date +%s; } # the clock the sandbox's own processes see

# The direct-egress gate (ADR 0038) needs the proxy: step 6 switches it off with the proxy and restores it afterwards.
gate_before=$(k get deploy pi-ingest -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_ALLOW_DIRECT_SANDBOX_EGRESS")].value}')
[[ $gate_before == true ]] || gate_before=false

# ------------------------------------------------------------------ cleanup, always
sessions=()
profiles=()
watchers=()
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for w in ${watchers[@]+"${watchers[@]}"}; do kill "$w" 2>/dev/null; done
  for s in ${sessions[@]+"${sessions[@]}"}; do kc delete "$s" 120 >/dev/null 2>&1; done
  for p in ${profiles[@]+"${profiles[@]}"}; do
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api PUT "/admin/profiles/$p" "{\"enabledForNew\":false,\"expectedRevision\":$rev}" >/dev/null 2>&1
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api DELETE "/admin/profiles/$p?expectedRevision=$rev" >/dev/null 2>&1
  done
  rm -rf "$scratch"
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 0. the proxy is up; sandboxes may reach it
echo "## 0. the proxy runs and the orchestrator knows it"
start=$SECONDS
while true; do
  status=$(api GET /admin/egress/status)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status")
  [[ $n -ge 1 ]] && break
  ((SECONDS - start < 120)) || fail "a proxy replica serving at the current revision" "$status"
  sleep 2
done
ok "the proxy serves revision $(jq_ 'j.revision' <<<"$status")"
[[ -n $(k get deploy pi-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_EGRESS_PROXY_URL")].value}') ]] || fail "the orchestrator has no PI_EGRESS_PROXY_URL (was the cluster made with --egress-proxy?)"
ok "the orchestrator has PI_EGRESS_PROXY_URL"
# The chart admits sandbox -> proxy:3128 with egressProxy.enabled (ADR 0036).
[[ -n $(k get networkpolicy sandbox-allow-egress-proxy-egress --ignore-not-found -o name) ]] ||
  fail "the chart's NetworkPolicy sandbox-allow-egress-proxy-egress is missing"
ok "the chart's NetworkPolicy admits sandbox -> proxy:3128"

# ------------------------------------------------------------------ 1. two sessions, two profiles
echo "## 1. sessions on two profiles; the sandbox has the proxy environment"
coding=$(api GET /admin/profiles/coding | jq_ 'j.definition')
# A deleted profile name is never reused, so each run takes fresh ones.
run=$(printf '%04x' "$RANDOM")
prof_gh=smoke-gh-$run
prof_py=smoke-py-$run
for pair in "$prof_gh:github-public" "$prof_py:pypi"; do
  p=${pair%%:*}
  set_=${pair##*:}
  def=$(node -e 'const d = JSON.parse(process.argv[1]); d.egressRuleSets = [process.argv[2]]; console.log(JSON.stringify({ definition: d }))' "$coding" "$set_")
  profiles+=("$p")
  api PUT "/admin/profiles/$p" "$def" >/dev/null
done
ok "profiles $prof_gh (github-public) and $prof_py (pypi) exist"
sa=$(kc create "$prof_gh" | sed -n 's/^session //p')
sessions+=("$sa")
sb=$(kc create "$prof_py" | sed -n 's/^session //p')
sessions+=("$sb")
[[ -n $sa && -n $sb ]] || fail "could not create the sessions"
m=m$RANDOM
out=$(sandbox "$sa" "env-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url; echo GIT; git ls-remote https://github.com/octocat/Hello-World.git HEAD | cut -c1-48; echo ENV; env | grep -E '^(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|NO_PROXY|NODE_USE_ENV_PROXY|GIT_CONFIG_(COUNT|KEY_0|VALUE_0))=' | sort | $mask; echo END")
printf '%s\n' "$out"
has() { grep -Eq -- "(^| )$1( |\$)" <<<"$out"; }
for var in HTTP_PROXY HTTPS_PROXY http_proxy https_proxy; do
  has "$var=http://x:\*\*\*@P" || fail "A's sandbox lacks $var pointing at the proxy with a masked token" "$out"
done
ok "A's sandbox has HTTP_PROXY, HTTPS_PROXY and both lower-case forms, each http://x:<token>@<the proxy Service address>:3128 (a proxied sandbox has no DNS, ADR 0038)"
has "NO_PROXY=localhost,127.0.0.1,::1" && has "NODE_USE_ENV_PROXY=1" || fail "NO_PROXY or NODE_USE_ENV_PROXY is missing" "$out"
ok "A's sandbox has NO_PROXY=localhost,127.0.0.1,::1 and NODE_USE_ENV_PROXY=1"
check "A's sandbox has git's http.proxyAuthMethod=basic" "$out" "GIT_CONFIG_KEY_0=http.proxyAuthMethod.*GIT_CONFIG_VALUE_0=basic"
check "a real git ls-remote https://github.com/... through the proxy worked in A's sandbox" "$out" "GIT [0-9a-f]{40} +HEAD"
! grep -Eq "x:[A-Za-z0-9_-]{20,}@" <<<"$out" || fail "the output shows an unmasked token"

# ------------------------------------------------------------------ 2. profile rule sets
echo "## 2. each session gets its profile's rule sets"
out=$(sandbox "$sa" "a2-$m" "$conn_fn; conn github.com; conn pypi.org; conn example.com; echo END")
check "A (github-public): github.com is allowed" "$out" "github.com HTTP/1.[01] 200"
check "A: pypi.org (the other profile's set) is denied" "$out" "pypi.org HTTP/1.1 407"
check "A: example.com (no rule) is denied" "$out" "example.com HTTP/1.1 407"
out=$(sandbox "$sb" "b2-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url; $conn_fn; conn pypi.org; conn github.com; echo END")
check "B (pypi): pypi.org is allowed" "$out" "pypi.org HTTP/1.[01] 200"
check "B: github.com (the other profile's set) is denied" "$out" "github.com HTTP/1.1 407"
principals=$(api GET /admin/egress/status | jq_ 'j.principals')
check "the status counts the principals with a known Pod address" "$principals" '"withPodIp":[2-9]'
why=$(api POST /admin/egress/explain "{\"host\":\"github.com\",\"sessionId\":\"$sa\"}")
check "explain with only the session id uses the principal's stored rule sets" "$why" '"profileSource":"principal".*"decision":"allow"|"decision":"allow".*"profileSource":"principal"'

# ------------------------------------------------------------------ 3. a session rule
echo "## 3. a session rule added through the admin API"
pod_a=$(pod_of "$sa")
pod_b=$(pod_of "$sb")
url_a=$(k exec "$pod_a" -- cat /workspace/.egress-url)
[[ $url_a == http://x:*@* ]] || fail "could not read A's proxy URL from its workspace"
watch() { # pod host outfile -- the proxy URL on stdin; one "<epoch> <status>" line every 0.5 s
  k exec -i "$1" -- bash -c "read -r HTTPS_PROXY; $conn_fn; while true; do echo \"\$(date +%s) \$(conn $2)\"; sleep 0.5; done" >"$3" 2>/dev/null
}
printf '%s\n' "$url_a" | watch "$pod_a" example.com "$scratch/rule.log" &
watchers+=($!)
sleep 4
check "example.com is denied for A before its session rule" "$(tail -1 "$scratch/rule.log")" "example.com HTTP/1.1 407"
t0=$(epoch_in "$pod_a")
api POST "/admin/egress/sessions/$sa/rules" '{"effect":"allow","host":"example.com"}' >/dev/null
for _ in $(seq 1 30); do
  grep -q "example.com HTTP/1.[01] 200" "$scratch/rule.log" && break
  sleep 0.5
done
t1=$(grep "example.com HTTP/1.[01] 200" "$scratch/rule.log" | head -1 | cut -d' ' -f1)
[[ -n $t1 ]] || fail "the session rule did not take effect" "$(tail -5 "$scratch/rule.log")"
((t1 - t0 <= 10)) || fail "the session rule took $((t1 - t0)) s to take effect"
ok "the session rule took effect $((t1 - t0)) s after it was added (budget 10 s)"
url_b=$(k exec "$pod_b" -- cat /workspace/.egress-url)
[[ $url_b == http://x:*@* ]] || fail "could not read B's proxy URL from its workspace"
printf '%s\n' "$url_b" | watch "$pod_b" example.com "$scratch/b-rule.log" &
watchers+=($!)
sleep 3
check "the same rule does not apply to session B" "$(tail -1 "$scratch/b-rule.log")" "example.com HTTP/1.1 407"
kill "${watchers[@]}" 2>/dev/null || true
watchers=()

# ------------------------------------------------------------------ 4. A's token from B's sandbox
echo "## 4. A's token used from B's sandbox"
one() { # pod host -- the proxy URL on stdin; prints "<host> <status line>"
  k exec -i "$1" -- bash -c "read -r HTTPS_PROXY; $conn_fn; conn $2"
}
from_b=$(printf '%s\n' "$url_a" | one "$pod_b" github.com)
check "github.com (allowed for A) with A's token from B's Pod is denied" "$from_b" "github.com HTTP/1.1 407"
from_a=$(printf '%s\n' "$url_a" | one "$pod_a" github.com)
check "the same token from A's own Pod works (control)" "$from_a" "github.com HTTP/1.[01] 200"
from_b2=$(printf '%s\n' "$url_a" | one "$pod_b" pypi.org)
check "B's own allowed host pypi.org with A's token from B's Pod is denied too" "$from_b2" "pypi.org HTTP/1.1 407"

tok_a=${url_a#http://x:}
tok_a=${tok_a%%@*}
leaked=""
for d in pi-egress-proxy pi-orchestrator pi-ingest; do
  grep -qF -- "$tok_a" < <(k logs "deploy/$d" --all-containers --tail=-1 2>/dev/null) && leaked+=" $d" || true
done
[[ -z $leaked ]] || fail "A's token appears in the logs of:$leaked"
ok "A's token appears in no log of the proxy, the orchestrator or ingest"
unset tok_a

# ------------------------------------------------------------------ 5. deleting A
echo "## 5. deleting session A"
printf '%s\n' "$url_a" | watch "$pod_a" github.com "$scratch/revoke.log" &
watchers+=($!)
sleep 4
check "before the delete the token works from A's Pod" "$(tail -1 "$scratch/revoke.log")" "github.com HTTP/1.[01] 200"
revoked_before=$(api GET /admin/egress/status | jq_ 'j.principals.revoked')
t0=$(epoch_in "$pod_a")
echo "deleting session A ..."
kc delete "$sa" 180 >/dev/null
sessions=("$sb")
sleep 1
kill "${watchers[@]}" 2>/dev/null || true
watchers=()
t1=$(grep "HTTP/1.1 407" "$scratch/revoke.log" | head -1 | cut -d' ' -f1 || true)
if [[ -n $t1 ]]; then
  ((t1 - t0 <= 10)) || fail "A's token was refused only $((t1 - t0)) s after the delete began"
  ok "A's token was refused within $((t1 - t0 + 1)) s of the delete (whole seconds of the Pod's clock; budget 10 s)"
else
  # The Pod can be gone before the next probe: then the status counts and a probe from B's Pod are the evidence.
  echo "(the sandbox went away before a 407 was logged; last lines:)"
  tail -3 "$scratch/revoke.log"
  fail "no refusal of A's token was observed between the revocation and the end of its Pod"
fi
revoked_after=$(api GET /admin/egress/status | jq_ 'j.principals.revoked')
((revoked_after == revoked_before + 1)) || fail "the status shows $revoked_after revoked principals, wanted $((revoked_before + 1))"
ok "the status shows one revoked principal more ($revoked_before -> $revoked_after)"
again=$(printf '%s\n' "$url_a" | one "$pod_b" github.com)
check "the deleted session's token is still refused afterwards" "$again" "github.com HTTP/1.1 407"

# ------------------------------------------------------------------ 6. the proxy off
echo "## 6. egressProxy.enabled=false changes nothing for a new session"
helm --kube-context "$ctx" upgrade pi-durable "$root/charts/pi-durable" --namespace "$namespace" --reuse-values \
  --set egressProxy.enabled=false --set security.allowDirectSandboxEgress=false --wait --timeout 5m >/dev/null
k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null
[[ -z $(k get deploy pi-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_EGRESS_PROXY_URL")].value}') ]] || fail "the orchestrator still has PI_EGRESS_PROXY_URL"
ok "the orchestrator has no PI_EGRESS_PROXY_URL with the proxy off"
counts_off=$(api GET /admin/egress/status | jq_ 'j.principals')
sc=$(kc create | sed -n 's/^session //p')
sessions+=("$sc")
out=$(sandbox "$sc" "off-$m" "echo ENV; env | grep -ciE '^(https?_proxy|NODE_USE_ENV_PROXY|GIT_CONFIG_COUNT)=' || true; git ls-remote https://github.com/octocat/Hello-World.git HEAD; echo END")
printf '%s\n' "$out"
check "the sandbox has no proxy variable" "$out" "ENV 0 "
check "git reaches github.com directly, as before" "$out" "[0-9a-f]{40} +HEAD"
counts_after=$(api GET /admin/egress/status | jq_ 'j.principals')
[[ $counts_off == "$counts_after" ]] || fail "a principal was created for a session with the proxy off ($counts_off -> $counts_after)"
ok "no principal was created for it ($counts_after)"
helm --kube-context "$ctx" upgrade pi-durable "$root/charts/pi-durable" --namespace "$namespace" --reuse-values \
  --set egressProxy.enabled=true --set "security.allowDirectSandboxEgress=$gate_before" --wait --timeout 5m >/dev/null
k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null
ok "the proxy is switched on again"
echo
echo "egress-session-smoke: all checks passed"
