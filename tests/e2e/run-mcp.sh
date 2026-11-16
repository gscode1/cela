#!/usr/bin/env bash
# MCP acceptance tests (issue #39): native remote MCP tools called from the orchestrator through the OneCLI gateway.
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh mcp`. WRITTEN, NOT YET RUN. Not part of `all`:
# it needs the internet (DeepWiki is a public server) and a live OneCLI host rule for mcp.deepwiki.com.
#
# Prerequisites (otherwise the tests SKIP, they never fake a result):
#   - the orchestrator runs with PI_MCP_SERVERS naming deepwiki: `run.sh mcp` sets it for the run (MCP_SERVERS overrides
#     the JSON, MCP_SERVERS=off leaves it empty so these tests SKIP) and restores the empty base value at the end
#   - OneCLI allows mcp.deepwiki.com: `deploy/onecli-host-rules.sh --apply` and deploy/onecli-policies/egress.yaml (Argo repo)
#
#   discovery     the orchestrator logged mcp-tools-ready for deepwiki, and its tools were never offered up front
#   call          a scripted session calls tool_search, then mcp__deepwiki__read_wiki_structure, and gets a real,
#                 non-error result; the sandbox Pod is the same one afterwards (no recycle) and no exec marker is set
#   flag-off      (manual, listed here for the record) with PI_MCP_SERVERS empty the same script's tool_search call is
#                 "not available"; covered by unit tests, not run here
#
# ONLY="discovery,call" runs just those tests. Exit code: 0 when no test failed (SKIPPED is not a failure).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"

k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }

ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
api() { k exec -i "$(ingest_pod)" -c ingest -- node - call "$@" <"$here/client-4b.mjs"; }
results() { k exec -i "$(ingest_pod)" -c ingest -- node - results "$@" <"$here/client-4b.mjs"; }
sql() { k exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -v ON_ERROR_STOP=1 -c "$1"; }
orch_log() { k logs deploy/pi-orchestrator --tail=2000; }

cleanup() {
  local id
  while read -r id; do
    [[ -n $id ]] || continue
    api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  rm -rf "$work"
}
trap cleanup EXIT

assert_eq() { # description expected actual
  if [[ $2 == "$3" ]]; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $2"
    note "  got: $3"
    exit 1
  fi
}
assert_jq() { # description json jq-expression
  if jq -e "$3" <<<"$2" >/dev/null 2>&1; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $3"
    note "  got: $(printf '%s' "$2" | cut -c1-500)"
    exit 1
  fi
}

need_deepwiki() {
  local value
  value=$(k exec deploy/pi-orchestrator -c orchestrator -- printenv PI_MCP_SERVERS 2>/dev/null || true)
  if [[ $value != *'"deepwiki"'* ]]; then
    note "SKIPPED: the orchestrator has no deepwiki in PI_MCP_SERVERS (see the header of this script)"
    return 3
  fi
}

# ---------------------------------------------------------------- tests
t_discovery() {
  need_deepwiki || return 3
  local deadline=$(($(now) + 120))
  until orch_log | grep -q '"event":"mcp-tools-ready","server":"deepwiki"'; do
    [[ $(now) -lt $deadline ]] || {
      note "no mcp-tools-ready for deepwiki after 120 s; last discovery log lines:"
      orch_log | grep 'mcp-discovery-failed' | tail -3 | cut -c1-300 || true
      exit 1
    }
    sleep 3
  done
  note "ok: deepwiki tools discovered"
}

t_call() {
  need_deepwiki || return 3
  local out id script res claim_before pod_before pod_after
  out=$(api alice POST /sessions '{"provider":"scripted","model":"scripted-1"}')
  assert_jq "session created" "$out" '.status==201'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  # tool_search loads the deferred tools; the next step calls one by name. Neither step touches the sandbox.
  script=$(jq -nc '{steps:[
      {tool:"tool_search", args:{query:"read wiki structure of a repository"}},
      {tool:"mcp__deepwiki__read_wiki_structure", args:{repoName:"facebook/react"}}
    ], final:"mcp-finished"}')
  api alice POST "/sessions/$id/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  res=$(results alice "$id" mcp-finished 120)
  assert_jq "the session answered" "$res" '.found==true'
  assert_jq "two tool results" "$res" '.results|length==2'
  # "Loaded" is only in tool_search's own output, never in the script.
  assert_jq "tool_search loaded the deepwiki tool" "$res" '.results[0] | (.isError|not) and (.text|test("Loaded [0-9]+ tools[\\s\\S]*mcp__deepwiki__read_wiki_structure"))'
  assert_jq "the DeepWiki call returned a real result" "$res" '.results[1] | (.isError|not) and (.text|length>50)'
  note "result excerpt: $(jq -r '.results[1].text' <<<"$res" | head -c 200 | tr '\n' ' ')"
  # ADR 0007 / 0003: no sandbox was needed, so no claim exists for this session and no exec marker was set.
  assert_eq "no SandboxClaim was created for the session" 0 "$(k get sandboxclaims -l "pi-durable-k8s/session-id=$id" -o name | wc -l | tr -d ' ')"
  assert_eq "no exec-in-flight marker" "0" "$(sql "select count(*) from inbox.sessions where id='$id' and exec_in_flight_at is not null" 2>/dev/null || echo 0)"
}

# ---------------------------------------------------------------- driver
pass=0 fail=0 skip=0
summary=()
run() { # name function
  local name=$1 rc
  [[ -z ${ONLY:-} || ",$ONLY," == *",$name,"* ]] || return 0
  log "$name"
  set +e
  (
    set -eE
    trap 'note "ERROR: command failed at line $LINENO (exit $?): $BASH_COMMAND"' ERR
    "$2"
  )
  rc=$?
  set -e
  case $rc in
    0)
      pass=$((pass + 1))
      summary+=("PASS  $name")
      ;;
    3)
      skip=$((skip + 1))
      summary+=("SKIP  $name")
      ;;
    *)
      fail=$((fail + 1))
      summary+=("FAIL  $name")
      ;;
  esac
}

run discovery t_discovery
run call t_call

log "summary"
for line in "${summary[@]}"; do note "$line"; done
note "passed=$pass failed=$fail skipped=$skip"
log "RESULT"
printf '%s\n' "${summary[@]}"
if [[ $fail -ne 0 ]]; then
  echo "MCP: FAILED" >&2
  exit 1
fi
echo "MCP: all tests passed"
