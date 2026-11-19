#!/usr/bin/env bash
# The bake-off of the chain sandbox -> egress proxy -> OneCLI gateway -> origin, on a THROWAWAY kind cluster (epic #50, issue #264,
# results in docs/research/egress-bakeoff.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy
#   hack/egress-bakeoff.sh [--name pi-egress] [--namespace pi-durable] [--skip-revoke]
#   hack/kind-down.sh --name pi-egress
#
# Two real sessions, A and B, each with a OneCLI agent, a sealed binding and session rules (hack/egress-onecli-driver.mjs, run in
# the orchestrator pod), and public echo servers as origins: httpbingo.org and postman-echo.com (they answer with the headers they
# received), echo.websocket.org (a WebSocket echo), and badssl.com (bad certificates). Every credential is a dummy value made up
# by this script; no real credential is read or used, and a dummy that OneCLI injects is only ever sent to those echo hosts. The
# client of each probe is hack/egress-bakeoff-probe.mjs, run in the session's sandbox like a tool would run.
#
# Cases (the numbers are the epic's list, docs/research/egress-bakeoff.md):
#   1. repo A/B isolation: two bindings with different pathPatterns on one host, 45 parallel requests each, both sessions at once
#   2. (not run) Codex refresh under concurrency: needs a real Codex login. Source analysis only
#   3. HTTP/2 and WebSockets, direct and onecli route; injection on the upgrade request
#   4. upstream certificate rejection, onecli and direct route
#   5. revocation time: hack/egress-revoke-smoke.sh (rule delete, session delete, binding delete, both replicas)
#   6. credential echo: the origin echoes the injected credential and the sandbox reads it
#   7. redirects: the credential stays with its host; a redirect to a denied host is refused by the proxy
#
# The script refuses the cluster pi-durable and any context that is not kind. A check prints `ok: ...` or `FAIL: ...` and the run
# goes on (a bake-off wants every observation); `note:` lines are observations that carry no verdict. The exit status is 1 when
# any check failed. Tokens and keys are never printed. The cleanup (sessions, OneCLI agents, secrets and allow rules) always runs.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
owner=${PI_SMOKE_OWNER:-admin}
skip_revoke=0
http_host=httpbingo.org
echo_host=postman-echo.com
ws_host=echo.websocket.org
bad_hosts=(self-signed.badssl.com expired.badssl.com wrong.host.badssl.com)

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--skip-revoke]" >&2
  exit 64
}
die() {
  echo "egress-bakeoff: $*" >&2
  exit 1
}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --skip-revoke) skip_revoke=1; shift ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script creates sessions, OneCLI agents and rules. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl node base64 openssl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
contexts=$(kubectl config get-contexts -o name)
grep -qx -- "$ctx" <<<"$contexts" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }
scratch=$(mktemp -d)

failures=0
ok() { echo "ok: $1"; }
bad() {
  echo "FAIL: $1" >&2
  [[ -z ${2:-} ]] || printf '%s\n' "$2" | cut -c1-300 >&2
  failures=$((failures + 1))
}
note() { echo "note: $1"; }
check() { # what, output, pattern
  if grep -Eq -- "$3" <<<"$2"; then ok "$1"; else bad "$1 (wanted /$3/)" "$2"; fi
}
refuse() { # what, output, pattern that must NOT be there
  if grep -Eq -- "$3" <<<"$2"; then bad "$1 (found /$3/)" "$2"; else ok "$1"; fi
}
count() { grep -Ec -- "$2" <<<"$1" || true; }

# ------------------------------------------------------------------ the APIs, from inside pods (as in hack/egress-onecli-smoke.sh)
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
api() { # METHOD PATH [JSON] -> the body; stops the run unless the status is 2xx
  local out status
  out=$(k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e "$api_js" "$@") || die "admin API call $1 $2 failed: $out"
  status=$(head -1 <<<"$out")
  [[ $status == 2?? ]] || die "admin API $1 $2 answered $status: $(tail -n +2 <<<"$out")"
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
  [[ -n $claim ]] || die "no SandboxClaim for session $1"
  echo "$claim"
}

# The probe, in a sandbox: the proxy URL (with the egress token) arrives on stdin and is never an argument.
probe_js=$(cat "$root/hack/egress-bakeoff-probe.mjs")
probe() { # pod proxy-url args...
  local pod=$1 url=$2
  shift 2
  printf '%s\n' "$url" | k exec -i "$pod" -- bash -c 'read -r HTTPS_PROXY; export HTTPS_PROXY NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/workspace/.onecli/ca.pem; timeout 120 /workspace/.smoke-node /workspace/.probe.mjs "$@" 2>&1' _ "$@" || true
}
prepare_sandbox() { # pod
  k exec deploy/pi-orchestrator -- cat /usr/local/bin/node | k exec -i "$1" -- bash -c 'cat > /workspace/.smoke-node && chmod +x /workspace/.smoke-node'
  printf '%s\n' "$probe_js" | k exec -i "$1" -- bash -c 'cat > /workspace/.probe.mjs'
  printf '%s\n' "$ca" | k exec -i "$1" -- bash -c 'mkdir -p /workspace/.onecli && cat > /workspace/.onecli/ca.pem'
}

# ------------------------------------------------------------------ cleanup, always
sessions=()
allowed_hosts=()
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for s in ${sessions[@]+"${sessions[@]}"}; do
    kc delete "$s" 120 >/dev/null 2>&1
    driver cleanup "$s" >/dev/null 2>&1
  done
  for h in ${allowed_hosts[@]+"${allowed_hosts[@]}"}; do driver disallow-host "$h" >/dev/null 2>&1; done
  rm -rf "$scratch"
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ versions and set-up
echo "## 0. versions and set-up"
start=$SECONDS
while true; do
  status=$(api GET /admin/egress/status)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status")
  [[ $n -ge 1 ]] && break
  ((SECONDS - start < 120)) || die "no proxy replica serves the current revision (was the cluster made with --onecli --egress-proxy?): $status"
  sleep 2
done
replicas=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving").length' <<<"$status")
note "proxy replicas serving: $replicas"
note "OneCLI images: $(k get deploy -l app.kubernetes.io/name=onecli -o jsonpath='{range .items[*]}{range .spec.template.spec.containers[*]}{.image}{" "}{end}{end}' | tr -s ' ')"
note "egress proxy image: $(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].image}')"
note "go.mod: $(grep -E '^(go |toolchain |.*smokescreen)' "$root/packages/egress-proxy/go.mod" | tr -s '[:space:]' ' ')"
note "client node: $(k exec deploy/pi-orchestrator -- node --version)"
note "date: $(date -u +%Y-%m-%d)"
gw_env=$(k get deploy -l app.kubernetes.io/name=onecli -o yaml | grep -cE 'GATEWAY_DANGER_ACCEPT_INVALID_CERTS|GATEWAY_SKIP_VERIFY_HOSTS' || true)
check "OneCLI's gateway runs without GATEWAY_DANGER_ACCEPT_INVALID_CERTS and GATEWAY_SKIP_VERIFY_HOSTS" "$gw_env" "^0$"

ca=$(k get configmap pi-onecli-ca -o jsonpath='{.data.ca\.pem}')
[[ -n $ca ]] || die "no OneCLI CA in the ConfigMap pi-onecli-ca"

# A hardened OneCLI (ONECLI_HOSTS) blocks every host that was not allowed: the test hosts need an allow rule (a no-op when open).
for h in "$http_host" "$echo_host" "$ws_host" "${bad_hosts[@]}"; do
  driver allow-host "$h" >/dev/null
  allowed_hosts+=("$h")
done
ok "OneCLI allow rules for the test hosts (removed again at the end)"

sa=$(kc create | sed -n 's/^session //p')
sessions+=("$sa")
sb=$(kc create | sed -n 's/^session //p')
sessions+=("$sb")
[[ -n $sa && -n $sb ]] || die "could not create the sessions"
m=m$RANDOM
sandbox "$sa" "envA-$m" 'printf %s "$HTTPS_PROXY" > /workspace/.egress-url; echo END' >/dev/null
sandbox "$sb" "envB-$m" 'printf %s "$HTTPS_PROXY" > /workspace/.egress-url; echo END' >/dev/null
pod_a=$(pod_of "$sa")
pod_b=$(pod_of "$sb")
url_a=$(k exec "$pod_a" -- cat /workspace/.egress-url)
url_b=$(k exec "$pod_b" -- cat /workspace/.egress-url)
[[ $url_a == http://x:*@* && $url_b == http://x:*@* ]] || die "could not read the sessions' proxy URLs"
prepare_sandbox "$pod_a"
prepare_sandbox "$pod_b"
ok "sessions A and B run; each sandbox has the probe, a node binary and the OneCLI CA"

# Dummy credentials. A's secret on the HTTP echo host only matches /anything/repo-a*, B's /anything/repo-b* (OneCLI's pathPattern).
tok_a=smoke-a-$(openssl rand -hex 6)
tok_b=smoke-b-$(openssl rand -hex 6)
tok_e=smoke-e-$(openssl rand -hex 6)
tok_w=smoke-w-$(openssl rand -hex 6)
tok_r=smoke-r-$(openssl rand -hex 6)
tok_x=smoke-x-$(openssl rand -hex 6)
driver bind-hosts "$sa" "$http_host,$echo_host,$ws_host,${bad_hosts[0]},${bad_hosts[1]},${bad_hosts[2]}" >/dev/null
driver bind-hosts "$sb" "$http_host" >/dev/null
driver secret "$sa" repo-a "$http_host" X-Smoke-Credential "$tok_a" '/anything/repo-a*' >/dev/null
driver secret "$sb" repo-b "$http_host" X-Smoke-Credential "$tok_b" '/anything/repo-b*' >/dev/null
driver secret "$sa" redirect "$http_host" X-Smoke-Credential "$tok_r" '/redirect-to*' >/dev/null
driver secret "$sa" echo "$echo_host" X-Smoke-Credential "$tok_e" >/dev/null
driver secret "$sa" ws "$ws_host" X-Smoke-Credential "$tok_w" >/dev/null
for h in "${bad_hosts[@]}"; do driver secret "$sa" "bad-${h%%.*}" "$h" X-Smoke-Credential "$tok_x" >/dev/null; done
# B: direct rules (the credential-free hosts), so the same hosts can be compared on both routes.
for h in "$echo_host" "$ws_host" "${bad_hosts[@]}"; do driver direct-rule "$sb" "$h" >/dev/null; done
sleep 8
ok "A: onecli rules and secrets (repo-a path, echo, ws, bad-cert hosts); B: onecli rule and repo-b secret on $http_host, direct rules elsewhere"

# ------------------------------------------------------------------ 1. repo A/B isolation
echo "## 1. repo A/B isolation: one host, two sessions, different pathPatterns, parallel"
urls_for() { # n
  local i
  for i in $(seq 1 "$1"); do
    echo "https://$http_host/anything/repo-a/$i https://$http_host/anything/repo-b/$i"
  done | tr ' ' '\n'
}
# the 5 repo-ab URLs show the prefix reach of "repo-a*"
read -r -a urls <<<"$(urls_for 20 | tr '\n' ' ') $(for i in 1 2 3 4 5; do printf 'https://%s/anything/repo-ab/%s ' "$http_host" "$i"; done)"
t0=$SECONDS
probe "$pod_a" "$url_a" fetch follow "${urls[@]}" >"$scratch/a.out" &
pa=$!
probe "$pod_b" "$url_b" fetch follow "${urls[@]}" >"$scratch/b.out" &
pb=$!
wait "$pa" "$pb" || true
out_a=$(cat "$scratch/a.out")
out_b=$(cat "$scratch/b.out")
note "45 + 45 requests, both sessions at once, took $((SECONDS - t0)) s"
check "A: all 45 requests answered 200" "$(count "$out_a" 'status=200')" "^45$"
check "B: all 45 requests answered 200" "$(count "$out_b" 'status=200')" "^45$"
check "A: all 20 requests under /anything/repo-a carried A's credential and no other" "$(count "$out_a" "url=https://$http_host/anything/repo-a/[0-9]+ tokens=$tok_a\$")" "^20$"
check "A: none of the 20 requests under /anything/repo-b carried a credential" "$(count "$out_a" "url=https://$http_host/anything/repo-b/[0-9]+ tokens=none\$")" "^20$"
check "B: all 20 requests under /anything/repo-b carried B's credential and no other" "$(count "$out_b" "url=https://$http_host/anything/repo-b/[0-9]+ tokens=$tok_b\$")" "^20$"
check "B: none of the 20 requests under /anything/repo-a carried a credential" "$(count "$out_b" "url=https://$http_host/anything/repo-a/[0-9]+ tokens=none\$")" "^20$"
refuse "B's credential appears nowhere in A's responses" "$out_a" "$tok_b"
refuse "A's credential appears nowhere in B's responses" "$out_b" "$tok_a"
note "A on /anything/repo-ab (outside the repo, inside the glob 'repo-a*'): $(count "$out_a" "repo-ab/[0-9]+ tokens=$tok_a\$") of 5 carried A's credential (a pathPattern is a prefix glob, not a path boundary)"
check "B on /anything/repo-ab: none carried a credential" "$(count "$out_b" "repo-ab/[0-9]+ tokens=none\$")" "^5$"
check "A's egress token used from B's Pod is refused by the proxy" "$(probe "$pod_b" "$url_a" conn "$http_host" 443)" "conn status=407"

# ------------------------------------------------------------------ 3. HTTP/2 and WebSockets
echo "## 3. HTTP/2 and WebSockets, direct route (B) and onecli route (A)"
direct_tls=$(probe "$pod_b" "$url_b" tls "$echo_host")
check "direct: the client sees the origin's own certificate (not OneCLI's)" "$direct_tls" "verified=true "
refuse "direct: issuer is not OneCLI" "$direct_tls" "issuer=OneCLI"
check "direct: h2 is negotiated end to end" "$direct_tls" "alpn=h2 "
direct_h2=$(probe "$pod_b" "$url_b" h2 "$echo_host" /headers)
check "direct: an HTTP/2 request works" "$direct_h2" "h2 status=200"
onecli_tls=$(probe "$pod_a" "$url_a" tls "$echo_host")
check "onecli: the client sees OneCLI's certificate (it terminates TLS)" "$onecli_tls" "issuer=OneCLI"
note "onecli: ALPN negotiated with the client: $(grep -o 'alpn=[^ ]*' <<<"$onecli_tls")"
check "onecli: h2 is NOT negotiated (OneCLI speaks http/1.1 to the client)" "$onecli_tls" "alpn=http/1.1"
onecli_h1=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/headers")
check "onecli: a client that offers h2 falls back and the request works, with injection" "$onecli_h1" "status=200.*tokens=$tok_e"
ws_direct=$(probe "$pod_b" "$url_b" ws "$ws_host" /)
check "direct: a wss upgrade works (101) and a frame is echoed" "$ws_direct" "ws status=101 echoed=true"
ws_onecli=$(probe "$pod_a" "$url_a" ws "$ws_host" /)
check "onecli: a wss upgrade works (101) and a frame is echoed" "$ws_onecli" "ws status=101 echoed=true"
# No public WebSocket server echoes its handshake headers, so the proof that the upgrade request is injected is OneCLI's own log:
# one line per upgrade with the number of injections it applied (httpbingo.org would show the headers, but it refuses an upgrade).
sleep 2
gw_ws=$(kubectl --context "$ctx" -n "$namespace" logs -l app.kubernetes.io/name=onecli,app.kubernetes.io/component=gateway --all-containers --tail=-1 --since=5m 2>/dev/null | grep '"WebSocket upgrade"' || true)
check "onecli: the gateway logged A's upgrade to $ws_host with one injection applied" "$(grep -c "\"host\":\"$ws_host:443\".*\"injections_applied\":1" <<<"$gw_ws" || true)" "^[1-9]"

# ------------------------------------------------------------------ 4. upstream certificate rejection
echo "## 4. upstream certificate rejection"
for h in "${bad_hosts[@]}"; do
  via=$(probe "$pod_a" "$url_a" fetch follow "https://$h/")
  check "onecli: $h is refused (the sandbox gets no page from it): $(grep -o 'status=[0-9]*' <<<"$via" | head -1) $(grep -o 'error=[A-Za-z_]*' <<<"$via" | head -1)" "$via" "status=(000|50[0-9]) "
  refuse "onecli: the body of $h never reaches the sandbox" "$via" "status=200"
  d=$(probe "$pod_b" "$url_b" tls "$h")
  check "direct: the client itself is shown the bad certificate of $h ($(grep -o 'reason=[A-Z_]*' <<<"$d"))" "$d" "verified=false"
  df=$(probe "$pod_b" "$url_b" fetch follow "https://$h/")
  check "direct: a verifying client fails on $h" "$df" "status=000 error=(DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)"
done
gw_log=$(kubectl --context "$ctx" -n "$namespace" logs -l app.kubernetes.io/name=onecli,app.kubernetes.io/component=gateway --all-containers --tail=-1 --since=15m 2>/dev/null || true)
note "OneCLI's gateway log on the bad hosts: $(grep -iE 'badssl' <<<"$gw_log" | grep -iE 'cert|tls|invalid|unknown|expired|verify' | head -2 | cut -c1-220 | tr '\n' '|')"

# ------------------------------------------------------------------ 6. credential echo
echo "## 6. credential echo: the origin returns the injected credential in the response body"
echo_out=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/headers")
check "the sandbox reads the injected credential in the response body (inherent to injection)" "$echo_out" "tokens=$tok_e"
note "the same sandbox never held that value before the response: its env and workspace hold only the egress token"
held=$(k exec "$pod_a" -- bash -c "env; cat /workspace/.egress-url; ls -a /workspace" | grep -c -e "$tok_e" -e "$tok_a" -e "$tok_r" || true)
check "before/outside the echo, no injected credential is in A's env or workspace listing" "$held" "^0$"

# ------------------------------------------------------------------ 7. redirects
echo "## 7. redirects"
# A holds secret r only on /redirect-to* of the HTTP echo host, secret e on the other echo host, nothing on example.org.
red_manual=$(probe "$pod_a" "$url_a" fetch manual "https://$echo_host/redirect-to?url=https://$http_host/headers&status_code=302")
check "onecli: the gateway hands the 302 to the client (it does not follow redirects itself)" "$red_manual" "status=302 location=https://$http_host/headers"
red_follow=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/redirect-to?url=https://$http_host/headers&status_code=302")
check "onecli: followed to another credentialed host, the response is that host's /headers" "$red_follow" "status=200 .*url=https://$http_host/headers"
refuse "onecli: the first host's credential did not follow the redirect" "$red_follow" "smoke-[a-z]-"
red_same=$(probe "$pod_a" "$url_a" fetch follow "https://$http_host/redirect-to?url=https://$http_host/headers&status_code=302")
check "onecli: a redirect to another path of the same host is judged again (no credential on /headers)" "$red_same" "status=200 .*tokens=none\$"
red_b=$(probe "$pod_b" "$url_b" fetch follow "https://$echo_host/redirect-to?url=https://$http_host/headers&status_code=302")
check "B following the same redirect through its own routes gets no credential" "$red_b" "status=200 .*tokens=none\$"
red_denied=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/redirect-to?url=https://example.org/&status_code=302")
check "a redirect to a denied host is refused by the proxy (the client's next CONNECT fails)" "$red_denied" "status=000"
check "and the proxy answers the CONNECT to that host with 407" "$(probe "$pod_a" "$url_a" conn example.org 443)" "conn status=407"
red_cluster=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/redirect-to?url=https://kubernetes.default.svc/&status_code=302")
check "a redirect into the cluster is refused" "$red_cluster" "status=000"
red_http=$(probe "$pod_a" "$url_a" fetch follow "https://$echo_host/redirect-to?url=http://$http_host/headers&status_code=302")
check "a redirect to plain http cannot leave the sandbox (no proxy for http, no direct network)" "$red_http" "status=000"

# ------------------------------------------------------------------ 5. revocation time
echo "## 5. revocation time (run last: the revoke smoke test removes the allow rules it shares with this script)"
if ((skip_revoke == 1)); then
  note "skipped (--skip-revoke); the check is hack/egress-revoke-smoke.sh"
else
  # The revoke smoke builds its own sessions; it needs the cluster to itself while it stops Postgres (check d).
  if rv=$("$root/hack/egress-revoke-smoke.sh" --name "$name" --namespace "$namespace" 2>&1); then
    grep -E 'after the change|after Postgres stopped' <<<"$rv" | sed 's/^ok: /  /' || true
    ok "hack/egress-revoke-smoke.sh passed (rule delete, session delete, binding delete on every replica, stale proxies)"
  else
    bad "hack/egress-revoke-smoke.sh failed" "$(tail -8 <<<"$rv")"
  fi
fi

echo
if ((failures > 0)); then
  echo "egress-bakeoff: $failures check(s) failed" >&2
  exit 1
fi
echo "egress-bakeoff: all checks passed"
