#!/usr/bin/env bash
# Live check of the MCP-derived egress rules, the OneCLI host-rule reconciler and the per-session MCP identity on a
# THROWAWAY kind cluster (epic #50 slice 8, docs/decisions/0040-mcp-egress-flow.md, issue #42):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy
#   hack/egress-mcp-smoke.sh [--name pi-egress] [--namespace pi-durable]
#   hack/kind-down.sh --name pi-egress
#
# It needs the internet (DeepWiki is a real public MCP server, httpbingo.org echoes request headers) and no real credential:
# the secrets it makes in OneCLI hold dummy values. The script refuses the cluster pi-durable and any context that is not
# kind, makes only objects with the prefix `smoke-` (servers, profiles, sessions, OneCLI secrets and rules) and removes
# them at the end. A key or token is never printed. Every check prints `ok: ...` or `FAIL: ...`; the first failure stops
# the run, the cleanup still runs. The OneCLI host rule for mcp.deepwiki.com that the bundled bootstrap made is removed at
# the start (an operator who never opened that host), and is not put back: use a throwaway cluster.
#
#   1. a hand-made host rule is recorded; mcp.deepwiki.com is blocked at the gateway
#   2. PUT /admin/mcp-servers/deepwiki: the gateway lets the host through within 10 s and the tools are listed; the derived
#      rule is in the read-only system set, the hand-made rule is unchanged, the terminal block is still one and last
#   3. a session whose profile names deepwiki calls its tool; one whose profile does not gets tool_unavailable and no route,
#      and the sandbox of neither can reach the host through the egress proxy
#   4. two credentialed servers (dummy secrets) and two sessions: each session's OneCLI agent holds exactly its own secret,
#      the origin sees only that session's credential, and deleting a session removes its agent
#   5. the reconciler is idempotent (a second look, 35 s later, changes nothing)
#   6. deleting the servers closes the doors: blocked again within 10 s, the host rules and derived rules are gone
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
owner=${PI_SMOKE_OWNER:-admin}
limit_ms=10000

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS]" >&2
  exit 64
}
die() {
  echo "egress-mcp-smoke: $*" >&2
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
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script creates sessions, OneCLI agents and rules. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl node jq; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
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
refute() { # what, output, pattern
  ! grep -Eq -- "$3" <<<"$2" || fail "$1 (must not match /$3/)" "$2"
  ok "$1"
}
now_ms() { node -e 'console.log(Date.now())'; }

# ------------------------------------------------------------------ the APIs, from inside the cluster
client=$root/tests/e2e/client-4b.mjs
ingest_pod() { k get pods -l app.kubernetes.io/name=pi-ingest -o jsonpath='{.items[0].metadata.name}'; }
api() { # METHOD PATH [JSON] -> {"status":N,"body":...}
  k exec -i "$(ingest_pod)" -c ingest -- node - call "$owner" "$@" <"$client"
}
api_ok() { # METHOD PATH [JSON] -> the body; fails unless the status is 2xx
  local out
  out=$(api "$@")
  jq -e '.status >= 200 and .status < 300' <<<"$out" >/dev/null || fail "admin API $1 $2 answered $(jq -c '{status, error: .body.error}' <<<"$out")"
  jq -c '.body' <<<"$out"
}
results() { k exec -i "$(ingest_pod)" -c ingest -- node - results "$owner" "$@" <"$client"; }
driver_js=$(cat "$root/hack/egress-mcp-driver.mjs")
driver() { k exec -i deploy/pi-orchestrator -- node --input-type=module -e "$driver_js" "$@"; }
orch_log() { k logs deploy/pi-orchestrator --tail=3000; }
log_time() { # event server -> epoch ms of the last such log line, or empty
  orch_log | grep "\"event\":\"$1\",\"server\":\"$2\"" | tail -1 | jq -r '.t' | xargs -I{} node -e 'console.log(Date.parse(process.argv[1]))' {} 2>/dev/null || true
}
new_session() { # [profile] -> prints the id
  local body='{"provider":"scripted","model":"scripted-1"}' out
  [[ -z ${1:-} ]] || body=$(jq -c --arg p "$1" '. + {profile:$p}' <<<"$body")
  out=$(api POST /sessions "$body")
  jq -e '.status == 201' <<<"$out" >/dev/null || fail "could not create a session" "$out"
  jq -r '.body.sessionId' <<<"$out"
}
send_script() { # session needle steps-json -> the results JSON
  local script
  script=$(jq -nc --argjson s "$3" --arg f "$2" '{steps:$s, final:$f}')
  api POST "/sessions/$1/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  results "$1" "$2" 120
}

sessions=()
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for s in ${sessions[@]+"${sessions[@]}"}; do api DELETE "/sessions/$s" >/dev/null 2>&1; done
  for p in smoke-with smoke-a smoke-b; do api PUT "/admin/profiles/$p" '{"enabledForNew":false}' >/dev/null 2>&1; done
  for s in deepwiki smoke-echo-a smoke-echo-b; do
    rev=$(api GET "/admin/mcp-servers/$s" 2>/dev/null | jq -r '.body.revision // empty')
    [[ -z $rev ]] || api DELETE "/admin/mcp-servers/$s?expectedRevision=$rev" >/dev/null 2>&1
  done
  sleep 8
  driver drop-rule smoke-handmade-allow >/dev/null 2>&1
  driver drop-secret smoke-key-a >/dev/null 2>&1
  driver drop-secret smoke-key-b >/dev/null 2>&1
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 0. what the cluster must have
echo "## 0. the cluster reconciles host rules and the proxy serves"
[[ $(k get deploy pi-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="PI_ONECLI_HOST_RULES")].value}') == reconcile ]] ||
  fail "the orchestrator has no PI_ONECLI_HOST_RULES=reconcile (was the cluster made with --onecli --egress-proxy by this checkout?)"
ok "PI_ONECLI_HOST_RULES=reconcile"
status=$(api_ok GET /admin/egress/status)
jq -e '.proxy.replicas | map(select(.state == "serving")) | length >= 1' <<<"$status" >/dev/null || fail "no proxy replica is serving" "$status"
ok "a proxy replica serves"

# ------------------------------------------------------------------ 1. before
echo "## 1. before: a hand-made rule, and mcp.deepwiki.com blocked at the gateway"
driver drop-rule pi-allow-mcp.deepwiki.com
driver handmade smoke-handmade-allow handmade.smoke.example
sleep 2
rules_before=$(driver rules)
hand_before=$(grep ' smoke-handmade-allow ' <<<"$rules_before")
[[ -n $hand_before ]] || fail "the hand-made rule is not there" "$rules_before"
ok "hand-made rule: $hand_before"
check "the gateway blocks mcp.deepwiki.com" "$(driver probe mcp.deepwiki.com)" "^blocked$"

# ------------------------------------------------------------------ 2. catalog PUT
echo "## 2. PUT /admin/mcp-servers/deepwiki: reachable within 10 s"
t0=$(now_ms)
api_ok PUT /admin/mcp-servers/deepwiki '{"url":"https://mcp.deepwiki.com/mcp","readOnly":true}' >/dev/null
reached=""
while true; do
  p=$(driver probe mcp.deepwiki.com)
  elapsed=$(($(now_ms) - t0))
  if [[ $p == reachable* ]]; then
    reached=$elapsed
    break
  fi
  ((elapsed < 60000)) || fail "mcp.deepwiki.com is still blocked after 60 s"
  sleep 0.3
done
echo "  the gateway let mcp.deepwiki.com through $reached ms after the PUT returned (including the probe's own ~0.4 s)"
((reached < limit_ms)) || fail "reachable only after $reached ms (the epic's bar is 10 s)"
ok "reachable within $((limit_ms / 1000)) s ($reached ms)"
tools_by=$((t0 + 20000))
while [[ -z $(log_time mcp-tools-ready deepwiki) ]] && (($(now_ms) < tools_by)); do sleep 0.5; done
added=$(log_time mcp-server-added deepwiki)
ready=$(log_time mcp-tools-ready deepwiki)
[[ -n $added && -n $ready ]] || fail "the orchestrator logged no mcp-server-added / mcp-tools-ready for deepwiki"
echo "  mcp-server-added to mcp-tools-ready in the orchestrator's log: $((ready - added)) ms"
((ready - added < limit_ms)) || fail "the tools were listed only $((ready - added)) ms after the orchestrator saw the change"
ok "the tools were listed within $((limit_ms / 1000)) s of the orchestrator learning of the server"

set_json=$(api_ok GET /admin/egress/rule-sets/mcp-catalog)
check "the derived set is a system set" "$set_json" '"system":true'
check "it holds a direct rule for mcp.deepwiki.com" "$(jq -c '.rules | map({host, route})' <<<"$set_json")" '"host":"mcp.deepwiki.com","route":"direct"'
res=$(api PUT /admin/egress/rule-sets/mcp-catalog '{"appliesToAll":true}')
check "a hand edit of the derived set is a 409" "$res" '"status":409'
rule_id=$(jq -r '.rules[0].id' <<<"$set_json")
res=$(api PUT "/admin/egress/rules/$rule_id" '{"host":"evil.example.com"}')
check "so is a hand edit of one of its rules" "$res" '"status":409'
res=$(api PUT /admin/profiles/smoke-bad '{"definition":{"egressRuleSets":["mcp-catalog"]}}')
check "a profile cannot name it" "$res" '"status":400'

rules_now=$(driver rules)
check "the reconciler made one pi-egress-allow rule for the host" "$(grep -c ' pi-egress-allow-mcp.deepwiki.com ' <<<"$rules_now" || true)" "^1$"
[[ $(grep ' smoke-handmade-allow ' <<<"$rules_now") == "$hand_before" ]] || fail "the hand-made rule changed" "$rules_now"
ok "the hand-made rule is unchanged (same priority, action, name and host)"
blocks=$(grep -c ' block ' <<<"$rules_now" || true)
check "there is still exactly one terminal block" "$blocks" "^1$"
last=$(tail -1 <<<"$rules_now")
check "and it is the last rule, behind the new allow" "$last" " block pi-block-all \*$"

# ------------------------------------------------------------------ 3. sessions
echo "## 3. a session whose profile names deepwiki calls it; one whose profile does not cannot"
api_ok PUT /admin/profiles/smoke-with '{"definition":{"mcpServers":["deepwiki"]},"enabledForNew":true}' >/dev/null
s_with=$(new_session smoke-with)
sessions+=("$s_with")
s_without=$(new_session)
sessions+=("$s_without")
res=$(send_script "$s_with" mcp-done '[{"tool":"tool_search","args":{"query":"read wiki structure of a repository"}},{"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}]')
check "the session whose profile names deepwiki got its tool result" "$res" '"found":true'
jq -e '.results | length >= 2 and (.[1].isError | not)' <<<"$res" >/dev/null || fail "the MCP call returned an error" "$(cut -c1-400 <<<"$res")"
ok "and the call was a real, non-error result from DeepWiki"
res=$(send_script "$s_without" mcp-none '[{"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}]')
jq -e '.results[0].isError == true and (.results[0].text | test("not available"))' <<<"$res" >/dev/null || fail "the session without the profile did not get tool_unavailable" "$(cut -c1-400 <<<"$res")"
ok "the session whose profile does not name it gets tool_unavailable"
why=$(api_ok POST /admin/egress/explain "{\"host\":\"mcp.deepwiki.com\",\"sessionId\":\"$s_without\"}")
check "explain: no rule lets that session's sandbox reach the host" "$why" '"decision":"deny"'
check "explain lists the MCP server on the host" "$why" '"mcp":\{"ruleSet":"mcp-catalog","servers":\[\{"name":"deepwiki"'
check "explain with the naming profile says so" "$(api_ok POST /admin/egress/explain '{"host":"mcp.deepwiki.com","profile":"smoke-with"}')" '"namedByProfile":true'
check "and says not for the profile that does not" "$(api_ok POST /admin/egress/explain '{"host":"mcp.deepwiki.com","profile":"coding"}')" '"namedByProfile":false'
# The sandbox's own connection: the proxy judges it by the session's rule sets; the derived set applies to nobody.
send_script "$s_with" sbx-done '[{"bash":"printf %s \"$HTTPS_PROXY\" > /workspace/.egress-url","timeout":60}]' >/dev/null
claim=$(k get sandboxclaims -l "pi-durable-k8s/session-id=$s_with" -o jsonpath='{.items[0].metadata.name}')
[[ -n $claim ]] || fail "no SandboxClaim for the session"
conn_fn='ph=${HTTPS_PROXY#*@}; pp=${ph##*:}; ph=${ph%:*}; tok=${HTTPS_PROXY#http://x:}; tok=${tok%%@*}; auth=$(printf "x:%s" "$tok" | base64 -w0);
exec 3<>/dev/tcp/$ph/$pp || { echo noconnect; exit 0; }; printf "CONNECT mcp.deepwiki.com:443 HTTP/1.1\r\nHost: mcp.deepwiki.com:443\r\nProxy-Authorization: Basic %s\r\n\r\n" "$auth" >&3; read -t 15 -r line <&3; echo "${line%$(printf "\r")}"'
url=$(k exec "$claim" -- cat /workspace/.egress-url)
sandbox=$(printf '%s\n' "$url" | k exec -i "$claim" -- bash -c "read -r HTTPS_PROXY; $conn_fn")
refute "the sandbox of the session whose profile names the server cannot CONNECT to it through the proxy" "$sandbox" "HTTP/1.[01] 200"
check "(the proxy refuses it: $sandbox)" "$sandbox" "HTTP/1.[01] 4[0-9][0-9]"

# ------------------------------------------------------------------ 4. per-session identity
echo "## 4. two credentialed servers: each session's OneCLI agent holds only its own secret"
driver secret smoke-key-a httpbingo.org X-Smoke-A dummy-credential-a
driver secret smoke-key-b httpbingo.org X-Smoke-B dummy-credential-b
t1=$(now_ms)
api_ok PUT /admin/mcp-servers/smoke-echo-a '{"url":"https://httpbingo.org/anything/a","readOnly":true,"onecliSecret":"smoke-key-a"}' >/dev/null
api_ok PUT /admin/mcp-servers/smoke-echo-b '{"url":"https://httpbingo.org/anything/b","readOnly":true,"onecliSecret":"smoke-key-b"}' >/dev/null
while [[ $(driver probe httpbingo.org) != reachable* ]]; do
  (($(now_ms) - t1 < 60000)) || fail "httpbingo.org is still blocked after 60 s"
  sleep 0.3
done
ok "the gateway let httpbingo.org through $(($(now_ms) - t1)) ms after the first PUT"
set_json=$(api_ok GET /admin/egress/rule-sets/mcp-catalog)
check "one derived rule for the host, route onecli, naming both servers" "$(jq -c '.rules | map(select(.host=="httpbingo.org")) | map({route, note})' <<<"$set_json")" '"route":"onecli","note":"MCP server smoke-echo-a, smoke-echo-b"'
check "a discovery agent of each credentialed server holds exactly its own secret (a)" "$(driver grants pi-session-d-smoke-echo-a)" "^smoke-key-a$"
check "(b)" "$(driver grants pi-session-d-smoke-echo-b)" "^smoke-key-b$"
api_ok PUT /admin/profiles/smoke-a '{"definition":{"mcpServers":["smoke-echo-a"]},"enabledForNew":true}' >/dev/null
api_ok PUT /admin/profiles/smoke-b '{"definition":{"mcpServers":["smoke-echo-b"]},"enabledForNew":true}' >/dev/null
sa=$(new_session smoke-a)
sessions+=("$sa")
sb=$(new_session smoke-b)
sessions+=("$sb")
# A first input runs the orchestrator's prepare step, which provisions the session's MCP agent (the servers are not real MCP
# servers, so no tool is ever listed or called: this is the identity, not the protocol).
send_script "$sa" hello-a '[{"tool":"tool_search","args":{"query":"anything"}}]' >/dev/null
send_script "$sb" hello-b '[{"tool":"tool_search","args":{"query":"anything"}}]' >/dev/null
ida=pi-session-$sa-m
idb=pi-session-$sb-m
check "session A's agent holds exactly smoke-key-a" "$(driver grants "$ida")" "^smoke-key-a$"
check "session B's agent holds exactly smoke-key-b" "$(driver grants "$idb")" "^smoke-key-b$"
check "a session whose profile names no credentialed server has no agent" "$(driver agents "pi-session-$s_with")" "^$"
fa=$(driver agent-fetch "$ida" https://httpbingo.org/anything/a)
fb=$(driver agent-fetch "$idb" https://httpbingo.org/anything/a)
check "the origin saw A's credential on A's request" "$fa" "header X-Smoke-A dummy-credential-a"
refute "and none of B's" "$fa" "X-Smoke-B"
check "the origin saw B's credential on B's request" "$fb" "header X-Smoke-B dummy-credential-b"
refute "and A's credential is not usable by B: B's agent sends none of it to the same URL" "$fb" "X-Smoke-A"

t2=$(now_ms)
api DELETE "/sessions/$sa" >/dev/null
sessions=("${sessions[@]/$sa/}")
while [[ $(driver grants "$ida") != no-agent ]]; do
  (($(now_ms) - t2 < 60000)) || fail "A's MCP agent is still there 60 s after the delete"
  sleep 0.5
done
ok "deleting session A removed its MCP agent $(($(now_ms) - t2)) ms later"
check "session B's agent is untouched" "$(driver grants "$idb")" "^smoke-key-b$"

# ------------------------------------------------------------------ 5. idempotency
echo "## 5. the reconciler is idempotent"
r1=$(driver rules)
sleep 35
r2=$(driver rules)
[[ $r1 == "$r2" ]] || fail "the host rules changed with no catalog change (priorities are creation order, so a recreated rule shows)" "$(diff <(echo "$r1") <(echo "$r2"))"
ok "35 s later the rules are identical, priorities included: nothing was recreated"
[[ $(grep ' smoke-handmade-allow ' <<<"$r2") == "$hand_before" ]] || fail "the hand-made rule changed"
ok "and the hand-made rule is still as it was"

# ------------------------------------------------------------------ 6. delete
echo "## 6. deleting the servers: blocked again within 10 s, rules gone"
# Profiles keep a server from being deleted while their current version names it (ADR 0027): publish versions without it.
for p in smoke-with smoke-a smoke-b; do api_ok PUT "/admin/profiles/$p" '{"definition":{"instructions":"no MCP"},"enabledForNew":false}' >/dev/null; done
rev=$(api_ok GET /admin/mcp-servers/deepwiki | jq -r '.revision')
t3=$(now_ms)
api_ok DELETE "/admin/mcp-servers/deepwiki?expectedRevision=$rev" >/dev/null
while [[ $(driver probe mcp.deepwiki.com) != blocked ]]; do
  (($(now_ms) - t3 < 60000)) || fail "mcp.deepwiki.com is still reachable 60 s after the delete"
  sleep 0.3
done
gone=$(($(now_ms) - t3))
echo "  the gateway blocked mcp.deepwiki.com again $gone ms after the DELETE returned"
((gone < limit_ms)) || fail "blocked only after $gone ms"
ok "unreachable within $((limit_ms / 1000)) s ($gone ms)"
res=$(send_script "$s_with" mcp-after '[{"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}]')
jq -e '.results[0].isError == true and (.results[0].text | test("not available"))' <<<"$res" >/dev/null || fail "a new call after the delete was not tool_unavailable" "$(cut -c1-300 <<<"$res")"
ok "a new call of the session that had the tool is tool_unavailable"
check "the derived rule is gone" "$(api_ok GET /admin/egress/rule-sets/mcp-catalog | jq -c '.rules | map(.host)')" '^\["httpbingo.org"\]$'
for s in smoke-echo-a smoke-echo-b; do
  rev=$(api_ok GET "/admin/mcp-servers/$s" | jq -r '.revision')
  api_ok DELETE "/admin/mcp-servers/$s?expectedRevision=$rev" >/dev/null
done
deadline=$(($(now_ms) + limit_ms))
while [[ $(driver rules | grep -c ' pi-egress-allow-' || true) != 0 ]]; do
  (($(now_ms) < deadline + 20000)) || fail "owned host rules remain" "$(driver rules)"
  sleep 0.5
done
ok "no pi-egress-allow rule is left; the hand-made one and the terminal block remain"
rules_end=$(driver rules)
[[ $(grep ' smoke-handmade-allow ' <<<"$rules_end") == "$hand_before" ]] || fail "the hand-made rule changed"
check "the terminal block is still there, once" "$(grep -c ' block ' <<<"$rules_end" || true)" "^1$"
echo
echo "all checks passed"
