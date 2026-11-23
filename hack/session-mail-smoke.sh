#!/usr/bin/env bash
# Live check of the session mail hook (ADR 0068, docs/session-mail.md, issue #420) against a real backend, on a THROWAWAY kind
# cluster whose chart sets sessionMail.server:
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --set sessionMail.server=smokemail
#   SESSION_MAIL_URL=https://mail.example/mcp SESSION_MAIL_OPERATOR_TOKEN=... [SESSION_MAIL_INJECT_TOKEN=...] \
#     hack/session-mail-smoke.sh [--name pi-egress] [--namespace cela] [--real]
#   hack/kind-down.sh --name pi-egress
#
# The tokens come from the environment and are never printed. The script refuses the cluster cela and any context that is not
# kind, makes only objects named smoke* (the catalog server is the chart's sessionMail.server) and removes them at the end, except
# that server, which it disables: a deleted catalog name can never be used again.
#
#   1. the mail server, credentialed by a OneCLI secret that carries the operator token, lists its tools
#   2. a browser session and a default session whose profiles name it each get an address; the two differ, and each is stable
#   3. with SESSION_MAIL_INJECT_TOKEN: a message injected for the browser session's address (the backend's test path, the same
#      store as inbound mail) is returned by its wait_for_email with the code extracted; the other session lists none and cannot
#      read it by id
#   4. with --real: prints the browser session's address and waits up to 10 minutes for real mail to reach it (send one to it)
#   5. without the operator token the backend refuses the MCP endpoint
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=cela
owner=${PI_SMOKE_OWNER:-admin}
real=0

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS] [--real]" >&2
  exit 64
}
die() {
  echo "session-mail-smoke: $*" >&2
  exit 1
}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  --real) real=1; shift ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $name != cela ]] || die "refusing the cluster cela: use a throwaway cluster"
for tool in kubectl node jq curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
[[ -n ${SESSION_MAIL_URL:-} ]] || die "SESSION_MAIL_URL is not set (the backend's MCP endpoint)"
[[ -n ${SESSION_MAIL_OPERATOR_TOKEN:-} ]] || die "SESSION_MAIL_OPERATOR_TOKEN is not set"
mail_host=$(node -e 'console.log(new URL(process.argv[1]).hostname)' "$SESSION_MAIL_URL")
mail_origin=$(node -e 'console.log(new URL(process.argv[1]).origin)' "$SESSION_MAIL_URL")
ctx=kind-$name
kubectl config get-contexts -o name | grep -qx -- "$ctx" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }

ok() { echo "ok: $1"; }
fail() {
  echo "FAIL: $1" >&2
  [[ -z ${2:-} ]] || printf '%s\n' "$2" | head -c 2000 >&2
  exit 1
}
check() { # what, output, pattern
  grep -Eq -- "$3" <<<"$2" || fail "$1 (wanted /$3/)" "$2"
  ok "$1"
}

client=$root/tests/e2e/client-4b.mjs
ingest_pod() { k get pods -l app.kubernetes.io/name=pi-ingest -o jsonpath='{.items[0].metadata.name}'; }
api() { k exec -i "$(ingest_pod)" -c ingest -- node - call "$owner" "$@" <"$client"; }
api_ok() {
  local out
  out=$(api "$@")
  jq -e '.status >= 200 and .status < 300' <<<"$out" >/dev/null || fail "admin API $1 $2 answered $(jq -c '{status, error: .body.error}' <<<"$out")"
  jq -c '.body' <<<"$out"
}
results() { k exec -i "$(ingest_pod)" -c ingest -- node - results "$owner" "$@" <"$client"; }
driver_js=$(cat "$root/hack/egress-mcp-driver.mjs")
driver() { k exec -i deploy/pi-orchestrator -- node --input-type=module -e "$driver_js" "$@"; }
new_session() { # profile -> prints the id
  local out
  out=$(api POST /sessions "$(jq -nc --arg p "$1" '{provider:"scripted",model:"scripted-1",profile:$p}')")
  jq -e '.status == 201' <<<"$out" >/dev/null || fail "could not create a session with profile $1" "$out"
  jq -r '.body.sessionId' <<<"$out"
}
send_script() { # session needle steps-json [timeout-s] -> the results JSON
  local script
  script=$(jq -nc --argjson s "$3" --arg f "$2" '{steps:$s, final:$f}')
  api POST "/sessions/$1/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  results "$1" "$2" "${4:-120}"
}
tool_json() { # results-json index (negative: from the end; the client returns every result of the session so far) -> the text, parsed
  jq -c --argjson i "$2" '.results[$i].text | fromjson? // .' <<<"$1"
}

server=$(k get deploy pi-orchestrator -o json | jq -r '.spec.template.spec.containers[0].env[]? | select(.name=="PI_SESSION_MAIL_SERVER") | .value')
[[ -n $server ]] || die "the orchestrator has no PI_SESSION_MAIL_SERVER: install with --set sessionMail.server=smokemail"
[[ $server == smoke* ]] || die "sessionMail.server is '$server'; this script only makes objects named smoke*"
secret=smoke-mail-operator
sessions=()

cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for s in ${sessions[@]+"${sessions[@]}"}; do api DELETE "/sessions/$s" >/dev/null 2>&1; done
  for p in smoke-mail-browser smoke-mail-default; do
    api PUT "/admin/profiles/$p" '{"definition":{"instructions":"no MCP"},"enabledForNew":false}' >/dev/null 2>&1
  done
  # The server is disabled, not deleted: its name is the chart's sessionMail.server, and a deleted name can never be made
  # again (ADR 0027), so the next run could not create it.
  api PUT "/admin/mcp-servers/$server" '{"enabled":false}' >/dev/null 2>&1
  driver drop-secret "$secret" >/dev/null 2>&1
  exit "$rc"
}
trap cleanup EXIT

echo "## 1. the mail server, credentialed by the operator token, lists its tools"
# The token goes to the driver as an argument of kubectl exec, never to this script's output.
driver secret "$secret" "$mail_host" Authorization "Bearer $SESSION_MAIL_OPERATOR_TOKEN" >/dev/null
api_ok PUT "/admin/mcp-servers/$server" "$(jq -nc --arg u "$SESSION_MAIL_URL" --arg s "$secret" \
  '{url:$u, readOnly:false, enabled:true, onecliSecret:$s, timeoutMs:150000}')" >/dev/null
for _ in $(seq 1 30); do
  st=$(api_ok GET "/admin/mcp-servers/$server")
  jq -e '.discovery.state == "ready" and .discovery.tools >= 4' <<<"$st" >/dev/null 2>&1 && break
  sleep 2
done
check "discovery listed the mail server's tools (no owner header)" "$st" '"toolNames":\[[^]]*"get_email_address"'

echo "## 2. a browser and a default session each get their own stable address"
api_ok PUT /admin/profiles/smoke-mail-browser "$(jq -nc --arg s "$server" '{definition:{sandboxFlavour:"browser",mcpServers:[$s]},enabledForNew:true}')" >/dev/null
ok "a browser profile may name the session mail server"
api_ok PUT /admin/profiles/smoke-mail-default "$(jq -nc --arg s "$server" '{definition:{mcpServers:[$s]},enabledForNew:true}')" >/dev/null
sa=$(new_session smoke-mail-browser)
sessions+=("$sa")
sb=$(new_session smoke-mail-default)
sessions+=("$sb")
get='[{"tool":"tool_search","args":{"query":"email address inbox"}},{"tool":"mcp__'"$server"'__get_email_address","args":{}},{"tool":"mcp__'"$server"'__get_email_address","args":{}}]'
ra=$(send_script "$sa" addr-a "$get")
rb=$(send_script "$sb" addr-b "$get")
addr_a=$(tool_json "$ra" -2 | jq -r '.address // empty')
addr_b=$(tool_json "$rb" -2 | jq -r '.address // empty')
[[ $addr_a == *@* ]] || fail "the browser session got no address" "$ra"
[[ $addr_b == *@* ]] || fail "the default session got no address" "$rb"
ok "the browser session's address: $addr_a"
ok "the default session's address: $addr_b"
[[ $addr_a != "$addr_b" ]] || fail "both sessions got the same address"
ok "the two addresses differ"
[[ $(tool_json "$ra" -1 | jq -r '.address') == "$addr_a" ]] || fail "the browser session's address changed between calls" "$ra"
ok "and an address is stable within its session"
[[ $addr_a != *"$sa"* ]] || fail "the address contains the session id"
ok "and it does not contain the session id"

if [[ -n ${SESSION_MAIL_INJECT_TOKEN:-} ]]; then
  echo "## 3. an injected message reaches only its own session"
  code=$(printf '%06d' $((RANDOM * 31 % 1000000)))
  wait='[{"tool":"tool_search","args":{"query":"wait for email"}},{"tool":"mcp__'"$server"'__wait_for_email","args":{"timeoutSeconds":60}}]'
  # The session waits first; the message goes in while its call is in flight.
  script=$(jq -nc --argjson s "$wait" '{steps:$s, final:"waited-a"}')
  api POST "/sessions/$sa/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  sleep 8
  msg=$(printf 'From: Smoke Sender <noreply@smoke.example>\r\nTo: %s\r\nSubject: Your code\r\nMessage-ID: <smoke-%s@smoke.example>\r\nDate: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nYour verification code is %s.\r\n' \
    "$addr_a" "$code" "$code" "$(date -R 2>/dev/null || date)" "$code")
  st=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$mail_origin/__test/inject?to=$(jq -rn --arg a "$addr_a" '$a|@uri')" \
    -H "Authorization: Bearer $SESSION_MAIL_INJECT_TOKEN" -H 'Content-Type: message/rfc822' --data-binary "$msg")
  [[ $st == 2* ]] || fail "the backend refused the injected message ($st)"
  ok "a message with code $code was injected for the browser session"
  rw=$(results "$sa" waited-a 120)
  got=$(tool_json "$rw" -1)
  check "the browser session's wait_for_email returned it with the code extracted" "$got" "\"codes\":\\[[^]]*\"$code\""
  id=$(jq -r '.email.id' <<<"$got")
  rl=$(send_script "$sb" list-b '[{"tool":"mcp__'"$server"'__list_emails","args":{}},{"tool":"mcp__'"$server"'__read_email","args":{"id":"'"$id"'"}}]')
  [[ $(tool_json "$rl" -2 | jq -r '.emails | length') == 0 ]] || fail "the default session lists the browser session's mail" "$rl"
  ok "the default session lists none of it"
  jq -e '.results[-1].isError == true' <<<"$rl" >/dev/null || fail "the default session could read the browser session's message by id" "$rl"
  ok "and cannot read it by id"
else
  echo "## 3. skipped: SESSION_MAIL_INJECT_TOKEN is not set"
fi

if ((real)); then
  echo "## 4. real mail: send a message to $addr_a now (waiting up to 10 minutes)"
  wait='[{"tool":"tool_search","args":{"query":"wait for email"}},{"tool":"mcp__'"$server"'__wait_for_email","args":{"timeoutSeconds":120}}]'
  got=null
  for i in 1 2 3 4 5; do
    rw=$(send_script "$sa" "real-$i" "$wait" 180)
    got=$(tool_json "$rw" -1)
    jq -e '.email != null' <<<"$got" >/dev/null 2>&1 && break
    echo "  nothing yet ($i of 5)"
  done
  jq -e '.email != null' <<<"$got" >/dev/null 2>&1 || fail "no real mail reached $addr_a within 10 minutes" "$got"
  ok "real mail reached the browser session: $(jq -c '.email | {from, subject, codes, links: (.links | length)}' <<<"$got")"
fi

echo "## 5. without the operator token the backend refuses the MCP endpoint"
st=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SESSION_MAIL_URL" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H "X-Cela-Mail-Owner: smoke-forged-m" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_emails","arguments":{}}}')
[[ $st == 401 || $st == 403 ]] || fail "the backend answered $st to a request with a forged owner and no operator token"
ok "a forged owner header without the operator token gets $st"
echo
echo "all session mail checks passed"
