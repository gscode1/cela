#!/usr/bin/env bash
# Live check of the network cutover and the network modes on a THROWAWAY kind cluster (epic #50, slice 6,
# docs/decisions/0038-network-modes.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy \
#     --set security.allowDirectSandboxEgress=true
#   hack/egress-cutover-smoke.sh [--name pi-egress] [--namespace cela]
#   hack/kind-down.sh --name pi-egress
#
# It creates profiles and sessions (named smoke-*), runs Helm upgrades that switch the direct gate off and on again, and
# re-runs the isolation probe, so it refuses the cluster cela and any context that is not a kind cluster. The APIs are
# called from inside an ingest pod (hack/kind-client.mjs): no API token leaves the cluster. Egress tokens are never printed.
# Every check prints `ok: ...` or `FAIL: ...`; the first failure stops the run, the cleanup still runs.
#
# The bypass probes run in the sandbox of a real session of each mode (the sandbox image has bash, getent and git, no curl):
#   direct IP        TCP to 1.1.1.1:443              (bash /dev/tcp)
#   other port       TCP to 1.1.1.1:53 and :80
#   IPv6             TCP to [2606:4700:4700::1111]:443  (informational in `direct`: kind has no IPv6 route to the internet)
#   UDP/53           a DNS query over UDP to 1.1.1.1 and a reply read (bash /dev/udp)
#   DNS              getent hosts example.com
#   --noproxy        git ls-remote with `-c http.proxy=` and with NO_PROXY='*' (curl --noproxy '*' in a sandbox with curl)
#   OneCLI gateway   TCP to the gateway's ClusterIP and to the management API's
#
#   1. the chart objects of the cutover: no sandbox-allow-onecli-egress and no sandbox-allow-internet-egress, the direct
#      policy and pools with the gate on, the label on every template
#   2. a proxied session and a direct session: their mode on the API, the label and the warm pool of their Pods
#   3. proxied: every bypass probe fails, the platform is unreachable, and the proxy path works (CONNECT to an allowed host,
#      a real git ls-remote), a host without a rule is denied, DoH resolver CONNECT works once a rule allows it
#   4. direct: the internet works (IP, ports, UDP/53, DNS, --noproxy), no proxy variable, and the private ranges, the
#      metadata address, the node, the cluster Services, another sandbox and the OneCLI gateway are all unreachable
#   5. the isolation probe, run again, says enforced
#   6. the gate off (helm upgrade): a direct profile cannot be written, a session of a stored direct profile is a 400, the
#      direct policy and pools are gone and the running direct sandbox has lost the internet; the gate is switched on again
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=cela
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS]" >&2
  exit 64
}
die() {
  echo "egress-cutover-smoke: $*" >&2
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
[[ $name != cela ]] || die "refusing the cluster cela: this script creates sessions and runs Helm upgrades. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl helm node; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
kubectl config get-contexts -o name | grep -qx -- "$ctx" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }

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
api_raw() { # METHOD PATH [JSON] -> first line the status, then the body
  k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e "$api_js" "$@"
}
api() { # METHOD PATH [JSON] -> the body; fails unless the status is 2xx
  local out status
  out=$(api_raw "$@") || fail "admin API call $1 $2 failed" "$out"
  status=$(head -1 <<<"$out")
  [[ $status == 2?? ]] || fail "admin API $1 $2 answered $status" "$(tail -n +2 <<<"$out")"
  tail -n +2 <<<"$out"
}
status_of() { # METHOD PATH [JSON] -> the status code only
  local out
  out=$(api_raw "$@") || fail "admin API call $1 $2 failed" "$out"
  head -1 <<<"$out"
}
jq_() { node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const f = new Function("j", "return " + process.argv[1]); const v = f(j); console.log(typeof v === "object" ? JSON.stringify(v) : String(v))' "$1"; }
client_js=$(cat "$root/hack/kind-client.mjs")
kc() { k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$client_js" "$1" "$owner" "${@:2}"; }
script_json() { node -e 'console.log(JSON.stringify({ steps: [{ bash: process.argv[2], timeout: 170 }], final: process.argv[1] }))' "$1" "$2"; }
# sandbox SESSION MARKER BASH -> the tool output of one tool call in that session's sandbox. The client replays the
# session's earlier tool results too, so only the last `TOOL` line, the call's own, is kept.
sandbox() { kc ask "$1" "$(script_json "$2" "$3")" "$2" 600 | grep '^TOOL ' | tail -1; }
claim_of() { # session -> its SandboxClaim (also the Sandbox and the Pod name)
  local claim
  claim=$(k get sandboxclaims -l "cela/session-id=$1" -o jsonpath='{.items[0].metadata.name}')
  [[ -n $claim ]] || fail "no SandboxClaim for session $1"
  echo "$claim"
}

# ------------------------------------------------------------------ cleanup, always
sessions=()
profiles=()
gate_was=$(k get deploy pi-ingest -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_ALLOW_DIRECT_SANDBOX_EGRESS")].value}')
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for s in ${sessions[@]+"${sessions[@]}"}; do kc delete "$s" 120 >/dev/null 2>&1; done
  for p in ${profiles[@]+"${profiles[@]}"}; do
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api PUT "/admin/profiles/$p" "{\"enabledForNew\":false,\"expectedRevision\":$rev}" >/dev/null 2>&1
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api DELETE "/admin/profiles/$p?expectedRevision=$rev" >/dev/null 2>&1
  done
  if [[ $(k get deploy pi-ingest -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_ALLOW_DIRECT_SANDBOX_EGRESS")].value}' 2>/dev/null) != "$gate_was" ]]; then
    helm --kube-context "$ctx" upgrade cela "$root/charts/cela" --namespace "$namespace" --reuse-values \
      --set "security.allowDirectSandboxEgress=$gate_was" --wait --timeout 5m >/dev/null 2>&1
  fi
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 1. the chart objects
echo "## 1. the chart objects of the cutover"
[[ $gate_was == true ]] || fail "the direct gate is off: make the cluster with --set security.allowDirectSandboxEgress=true"
[[ -n $(k get deploy pi-egress-proxy -o name --ignore-not-found) ]] || fail "no egress proxy: make the cluster with --egress-proxy"
for gone in sandbox-allow-onecli-egress sandbox-allow-internet-egress; do
  [[ -z $(k get networkpolicy "$gone" --ignore-not-found -o name) ]] || fail "the NetworkPolicy $gone still exists with the proxy on"
done
ok "no sandbox-allow-onecli-egress and no sandbox-allow-internet-egress"
[[ -n $(k get networkpolicy sandbox-allow-egress-proxy-egress sandbox-direct-allow-egress -o name 2>/dev/null | sed -n 2p) ]] || fail "the proxy or the direct policy is missing"
ok "sandbox-allow-egress-proxy-egress and sandbox-direct-allow-egress exist"
dns_sel=$(k get networkpolicy allow-dns-egress -o jsonpath='{.spec.podSelector}')
check "allow-dns-egress leaves sandboxes out" "$dns_sel" 'NotIn.*pi-sandbox'
if [[ -n $(k get ciliumnetworkpolicy dns-egress-kube-dns-only --ignore-not-found -o name) ]]; then
  cdns_sel=$(k get ciliumnetworkpolicy dns-egress-kube-dns-only -o jsonpath='{.spec.endpointSelector}')
  check "dns-egress-kube-dns-only leaves sandboxes out" "$cdns_sel" 'NotIn.*pi-sandbox'
fi
modes=$(k get sandboxtemplates -o jsonpath='{range .items[*]}{.metadata.name}={.spec.podTemplate.metadata.labels.cela\.dev/network-mode}{"\n"}{end}')
check "every proxied template has the label" "$(grep -v direct <<<"$modes")" 'pi-env-template-s=proxied'
check "the direct templates have the direct label" "$modes" 'pi-env-direct-template-s=direct'
for pool in pi-env-direct-pool pi-env-direct-pool-s pi-env-pool-s; do
  [[ -n $(k get sandboxwarmpool "$pool" --ignore-not-found -o name) ]] || fail "the warm pool $pool is missing"
done
ok "the warm pools pi-env-pool-s, pi-env-direct-pool and pi-env-direct-pool-s exist"
auth=$(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EGRESS_REQUIRE_AUTH")].value}')
[[ $auth == true ]] || fail "the proxy does not require a token (EGRESS_REQUIRE_AUTH=$auth)"
ok "the proxy requires a session token"

# ------------------------------------------------------------------ 2. one session per mode
echo "## 2. a proxied and a direct session"
coding=$(api GET /admin/profiles/coding | jq_ 'j.definition')
run=$(printf '%04x' "$RANDOM")
prof_px=smoke-px-$run
prof_dr=smoke-dr-$run
def_px=$(node -e 'const d = JSON.parse(process.argv[1]); d.egressRuleSets = ["github-public"]; console.log(JSON.stringify({ definition: d }))' "$coding")
def_dr=$(node -e 'const d = JSON.parse(process.argv[1]); d.networkMode = "direct"; console.log(JSON.stringify({ definition: d }))' "$coding")
profiles+=("$prof_px" "$prof_dr")
api PUT "/admin/profiles/$prof_px" "$def_px" >/dev/null
api PUT "/admin/profiles/$prof_dr" "$def_dr" >/dev/null
ok "profiles $prof_px (proxied, github-public) and $prof_dr (direct) exist"
check "a direct profile shows up in the listing with its mode" "$(api GET "/admin/profiles/$prof_dr")" '"networkMode":"direct"'
sx=$(kc create "$prof_px" | sed -n 's/^session //p')
sessions+=("$sx")
sd=$(kc create "$prof_dr" | sed -n 's/^session //p')
sessions+=("$sd")
[[ -n $sx && -n $sd ]] || fail "could not create the sessions"
[[ $(api GET "/sessions/$sx" | jq_ 'j.networkMode') == proxied ]] || fail "the proxied session does not report networkMode proxied"
[[ $(api GET "/sessions/$sd" | jq_ 'j.networkMode') == direct ]] || fail "the direct session does not report networkMode direct"
ok "GET /sessions reports networkMode proxied and direct"
m=m$RANDOM
sandbox "$sx" "up-x-$m" "true" >/dev/null
sandbox "$sd" "up-d-$m" "true" >/dev/null
pod_x=$(claim_of "$sx")
pod_d=$(claim_of "$sd")
[[ $(k get pod "$pod_x" -o jsonpath='{.metadata.labels.cela\.dev/network-mode}') == proxied ]] || fail "the proxied session's Pod is not labelled proxied"
[[ $(k get pod "$pod_d" -o jsonpath='{.metadata.labels.cela\.dev/network-mode}') == direct ]] || fail "the direct session's Pod is not labelled direct"
ok "the Pods carry cela.dev/network-mode proxied and direct"
[[ $(k get sandboxclaim "$pod_x" -o jsonpath='{.spec.warmPoolRef.name}') == pi-env-pool-s ]] || fail "the proxied claim does not use pi-env-pool-s"
[[ $(k get sandboxclaim "$pod_d" -o jsonpath='{.spec.warmPoolRef.name}') == pi-env-direct-pool-s ]] || fail "the direct claim does not use pi-env-direct-pool-s"
ok "the claims use pi-env-pool-s and pi-env-direct-pool-s"
check "the status counts the direct session" "$(api GET /admin/status | jq_ 'j.directSessions')" '^[1-9]'
k logs deploy/pi-orchestrator --tail=-1 2>/dev/null | grep -q "direct-egress-sandbox.*$sd" || fail "the orchestrator did not log direct-egress-sandbox for the direct session"
ok "the orchestrator logged direct-egress-sandbox for it"

# Targets of the platform, as seen from the sandbox. A sandbox must reach none of them in either mode.
node_ip=$(kubectl --context "$ctx" get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')
svc_ip() { k get svc "$1" -o jsonpath='{.spec.clusterIP}'; }
kube_ip=$(kubectl --context "$ctx" -n default get svc kubernetes -o jsonpath='{.spec.clusterIP}')
other_ip_x=$(k get pod "$pod_d" -o jsonpath='{.status.podIP}')
other_ip_d=$(k get pod "$pod_x" -o jsonpath='{.status.podIP}')
gw_ip=$(svc_ip onecli-gateway)
oapi_ip=$(svc_ip onecli-api)
[[ -n $node_ip && -n $kube_ip && -n $gw_ip && -n $oapi_ip && -n $other_ip_x && -n $other_ip_d ]] || fail "could not read the platform addresses"

# probes_fn: shell functions of the battery. Each prints "<label>=R" (reached) or "<label>=B" (blocked), no spaces.
probes_fn='t() { if timeout 3 bash -c "exec 3<>/dev/tcp/$2/$3" 2>/dev/null; then printf "%s=R " "$1"; else printf "%s=B " "$1"; fi; };
u() { if exec 4<>/dev/udp/$2/53 2>/dev/null; then printf "\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x07example\x03com\x00\x00\x01\x00\x01" >&4; if [ "$(timeout 3 dd bs=1 count=1 <&4 2>/dev/null | wc -c)" = 1 ]; then printf "%s=R " "$1"; else printf "%s=B " "$1"; fi; exec 4>&-; else printf "%s=B " "$1"; fi; };
d() { if timeout 8 getent hosts example.com >/dev/null 2>&1; then printf "dns=R "; else printf "dns=B "; fi; };
g() { if timeout 25 "${@:2}" https://github.com/octocat/Hello-World.git HEAD >/dev/null 2>&1; then printf "%s=R " "$1"; else printf "%s=B " "$1"; fi; };'
# The internet probes (reached in direct, blocked in proxied), then the platform probes (blocked in both).
internet_battery="$probes_fn t ip443 1.1.1.1 443; t port80 1.1.1.1 80; t port53 1.1.1.1 53; t ipv6 2606:4700:4700::1111 443; u udp53 1.1.1.1; d; g noproxy env NO_PROXY='*' git -c http.proxy= ls-remote; g gitdirect env -u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy git ls-remote; echo; echo END"
platform_battery="$probes_fn t metadata 169.254.169.254 80; t node-kubelet $node_ip 10250; t node-api $node_ip 6443; t kube-api $kube_ip 443; t ingest $(svc_ip pi-ingest) 8080; t postgres $(svc_ip pi-postgres) 5432; t orch $(svc_ip pi-orchestrator) 8081; t gateway $gw_ip 10255; t onecli-api $oapi_ip 10256; t private10 10.255.255.1 443; t private172 172.31.255.1 443; t private192 192.168.255.1 443; t cgnat 100.127.255.1 443; echo; echo END"

# ------------------------------------------------------------------ 3. proxied
echo "## 3. proxied: every bypass fails; the proxy path works"
out=$(sandbox "$sx" "net-x-$m" "$internet_battery")
printf '%s\n' "$out"
for probe in ip443 port80 port53 ipv6 udp53 dns noproxy gitdirect; do
  check "proxied: $probe is blocked" "$out" "$probe=B"
done
out=$(sandbox "$sx" "plat-x-$m" "$platform_battery")
printf '%s\n' "$out"
! grep -q '=R' <<<"$out" || fail "a proxied sandbox reached something of the platform or a private range" "$out"
ok "proxied: the metadata address, the node, the cluster Services, the OneCLI gateway and API and the private ranges are all blocked"
# The sandbox Pod addresses are checked in the next section from the direct sandbox, and here from the proxied one.
out=$(sandbox "$sx" "peer-x-$m" "$probes_fn t other-sandbox-rest $other_ip_x 8080; t other-sandbox-grpc $other_ip_x 9090; echo; echo END")
check "proxied: another sandbox's sandboxd is blocked" "$out" 'other-sandbox-rest=B other-sandbox-grpc=B'
conn_fn='ph=${HTTPS_PROXY#*@}; pp=${ph##*:}; ph=${ph%:*}; tok=${HTTPS_PROXY#http://x:}; tok=${tok%%@*}; auth=$(printf "x:%s" "$tok" | base64 -w0);
conn() { exec 3<>/dev/tcp/$ph/$pp || { echo "$1 noconnect"; return; }; printf "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\nProxy-Authorization: Basic %s\r\n\r\n" "$1" "$1" "$auth" >&3; read -t 15 -r line <&3; exec 3>&-; echo "$1 ${line%$(printf "\r")}"; }'
out=$(sandbox "$sx" "via-x-$m" "$conn_fn; conn github.com; conn example.com; conn cloudflare-dns.com; echo; echo END")
printf '%s\n' "$out" | sed -E 's#(://x:)[^@ ]*@#\1***@#'
check "proxied: CONNECT github.com through the proxy works (the rule set allows it)" "$out" "github.com HTTP/1.[01] 200"
check "proxied: CONNECT example.com (no rule) is denied by the proxy" "$out" "example.com HTTP/1.1 407"
check "proxied: the DoH resolver is denied before a rule allows it" "$out" "cloudflare-dns.com HTTP/1.1 407"
api POST "/admin/egress/sessions/$sx/rules" '{"effect":"allow","host":"cloudflare-dns.com"}' >/dev/null
sleep 8
out=$(sandbox "$sx" "doh-x-$m" "$conn_fn; conn cloudflare-dns.com; echo; echo END")
check "proxied: with a session rule the DoH resolver is reachable through the proxy (DNS troubleshooting)" "$out" "cloudflare-dns.com HTTP/1.[01] 200"
out=$(sandbox "$sx" "git-x-$m" "git ls-remote https://github.com/octocat/Hello-World.git HEAD | cut -c1-48; echo END")
check "proxied: git ls-remote https://github.com/... through the proxy works" "$out" "[0-9a-f]{40} +HEAD"
sandbox "$sx" "tok-x-$m" "printf %s \"\$HTTPS_PROXY\" > /workspace/.egress-url" >/dev/null

# ------------------------------------------------------------------ 4. direct
echo "## 4. direct: the internet works; the platform and the private ranges do not"
out=$(sandbox "$sd" "net-d-$m" "$internet_battery")
printf '%s\n' "$out"
for probe in ip443 port80 port53 udp53 dns noproxy gitdirect; do
  check "direct: $probe works" "$out" "$probe=R"
done
if grep -q 'ipv6=R' <<<"$out"; then ok "direct: IPv6 works (this cluster has an IPv6 route)"; else echo "note: direct IPv6 is blocked here (kind has no IPv6 route to the internet); the policy only allows ::/0 minus fc00::/7, fe80::/10, ::1/128"; fi
out=$(sandbox "$sd" "plat-d-$m" "$platform_battery")
printf '%s\n' "$out"
! grep -q '=R' <<<"$out" || fail "a direct sandbox reached something of the platform or a private range" "$out"
ok "direct: the metadata address, the node, the cluster Services, the OneCLI gateway and API and the private ranges are all blocked"
out=$(sandbox "$sd" "peer-d-$m" "$probes_fn t other-sandbox-rest $other_ip_d 8080; t other-sandbox-grpc $other_ip_d 9090; echo; echo END")
check "direct: another sandbox's sandboxd is blocked" "$out" 'other-sandbox-rest=B other-sandbox-grpc=B'
out=$(sandbox "$sd" "env-d-$m" "echo ENV; env | grep -ciE '^(https?_proxy|node_use_env_proxy|git_config_count)=' || true; echo END")
check "direct: no proxy variable and no egress token in the sandbox" "$out" 'ENV 0 '
principals=$(api GET /admin/egress/status | jq_ 'j.principals')
echo "principals: $principals"
explain=$(api POST /admin/egress/explain "{\"host\":\"github.com\",\"sessionId\":\"$sd\"}")
! grep -q '"profileSource":"principal"' <<<"$explain" || fail "the direct session has a principal at the proxy"
ok "direct: the session has no principal at the proxy"
# The same token a proxied session holds is useless from a direct sandbox (and was never issued to it).
url_x=$(k exec "$pod_x" -- cat /workspace/.egress-url)
[[ $url_x == http://x:*@* ]] || fail "could not read the proxied session's proxy URL"
from_d=$(printf '%s\n' "$url_x" | k exec -i "$pod_d" -- bash -c "read -r HTTPS_PROXY; $conn_fn; conn github.com" 2>&1 | sed -E 's#(://x:)[^@ ]*@#\1***@#')
[[ $from_d != *" 200"* ]] || fail "the proxied session's token worked from the direct sandbox" "$from_d"
ok "direct: the proxied session's token does not work from the direct sandbox (got: $(tr '\n' ' ' <<<"$from_d"))"
unset url_x

# ------------------------------------------------------------------ 5. the isolation probe
echo "## 5. the isolation probe"
api POST /admin/status/probe >/dev/null
sleep 5
start=$SECONDS
state=unknown
while ((SECONDS - start < 180)); do
  state=$(api GET /admin/status | jq_ 'j.networkPolicy.state')
  [[ $state == enforced || $state == not-enforced || $state == inconclusive ]] && break
  sleep 4
done
detail=$(api GET /admin/status | jq_ 'j.networkPolicy.detail')
[[ $state == enforced ]] || fail "the isolation probe says $state" "$detail"
ok "the isolation probe says enforced (controls: $(jq_ 'j.controls' <<<"$detail"))"
check "the probe judged the OneCLI gateway as a denied target" "$detail" '"name":"onecli-gateway"[^}]*"verdict":"blocked"'
check "the probe has no DNS control (a proxied sandbox has no DNS)" "$detail" '"dns":null'

# ------------------------------------------------------------------ 6. the gate off
echo "## 6. security.allowDirectSandboxEgress=false"
helm --kube-context "$ctx" upgrade cela "$root/charts/cela" --namespace "$namespace" --reuse-values \
  --set security.allowDirectSandboxEgress=false --wait --timeout 5m >/dev/null
k rollout status deploy/pi-ingest --timeout=300s >/dev/null
[[ -z $(k get networkpolicy sandbox-direct-allow-egress --ignore-not-found -o name) ]] || fail "the direct policy still exists with the gate off"
[[ -z $(k get sandboxwarmpool pi-env-direct-pool-s --ignore-not-found -o name) ]] || fail "a direct warm pool still exists with the gate off"
[[ -z $(k get sandboxtemplates -o name | grep direct || true) ]] || fail "a direct template still exists with the gate off"
ok "no direct policy, template or warm pool is left"
code=$(status_of PUT "/admin/profiles/smoke-nope-$run" "$def_dr")
[[ $code == 400 ]] || fail "writing a direct profile answered $code with the gate off, wanted 400"
body=$(api_raw PUT "/admin/profiles/smoke-nope-$run" "$def_dr") || fail "admin API call failed" "$body"
check "the 400 names the gate" "$body" 'allowDirectSandboxEgress'
code=$(k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e '
let token = "";
for (const entry of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) { const l = entry.trim(), at = l.indexOf(":"); if (at > 0 && l.slice(0, at) === process.env.OWNER) token = l.slice(at + 1); }
const res = await fetch("http://127.0.0.1:8080/sessions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ profile: process.argv[1] }) });
console.log(res.status);' "$prof_dr")
[[ $code == 400 ]] || fail "creating a session of the stored direct profile answered $code with the gate off, wanted 400"
ok "a session of the stored direct profile is a 400 with the gate off"
sleep 10
out=$(sandbox "$sd" "off-d-$m" "$probes_fn t ip443 1.1.1.1 443; d; echo; echo END")
check "the running direct sandbox lost the internet and DNS with its policy (fail closed)" "$out" 'ip443=B dns=B'
helm --kube-context "$ctx" upgrade cela "$root/charts/cela" --namespace "$namespace" --reuse-values \
  --set security.allowDirectSandboxEgress=true --wait --timeout 5m >/dev/null
k rollout status deploy/pi-ingest --timeout=300s >/dev/null
sleep 10
out=$(sandbox "$sd" "on-d-$m" "$probes_fn t ip443 1.1.1.1 443; d; echo; echo END")
check "with the gate on again the direct sandbox has the internet back" "$out" 'ip443=R dns=R'
echo
echo "egress-cutover-smoke: all checks passed"
