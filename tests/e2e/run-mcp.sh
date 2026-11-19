#!/usr/bin/env bash
# MCP acceptance tests (issues #39, #40 and #41): native remote MCP tools called from the orchestrator through the OneCLI
# gateway, from a catalog in Postgres that the admin API changes at runtime, offered only to sessions whose profile
# names the server.
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh mcp`. WRITTEN, NOT YET RUN. Not part of `all`:
# it needs the internet (DeepWiki is a public server) and a live OneCLI host rule for mcp.deepwiki.com.
#
# Setup: the suite PUTs server deepwiki to /admin/mcp-servers (alice is in PI_API_ADMINS) and DELETEs it at the end, so
# nothing is restarted and no Deployment is edited. Prerequisite (otherwise the tests fail to connect, never fake a
# result): OneCLI can reach mcp.deepwiki.com (open by default; on a hardened install it must be on the allowlist: `hack/onecli-host-rules.sh --apply`, hack/onecli-policies/egress-strict.yaml).
#
#   add           PUT creates deepwiki (201); the orchestrator logs mcp-server-added and mcp-tools-ready without a restart
#   profile       PUT /admin/profiles/research {mcpServers:[deepwiki]} (profiles are never deleted: cleanup disables it)
#   call          a scripted session created with profile research calls tool_search, then
#                 mcp__deepwiki__read_wiki_structure, and gets a real, non-error result; no SandboxClaim is created and
#                 no exec marker is set
#   default       a session with the default profile (coding) has no MCP: tool_search and the MCP tool settle
#                 tool_unavailable, although deepwiki is enabled in the catalog
#   edit          a new version of research does not change the session created with version 1
#   disable       PUT enabled:false; a NEW call in the same session returns tool_unavailable ("not available"), the
#                 orchestrator pod is the same one (no restart), and mcp-server-removed was logged
#   unreachable   a row for a host that is not in the OneCLI allowlist never gets tools: mcp-discovery-failed is logged
#                 for it, and a session created after it calls into tool_unavailable
#   history       the admin history shows create, update and delete by alice
#
# ONLY="add,profile,call" runs just those tests (they depend on each other in the order above: add, profile, call,
# edit, disable). Exit code: 0
# when no test failed (SKIPPED is not a failure).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"

k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }
# shellcheck source=fns.sh
. "$here/fns.sh"
E2E_TEST_PREFIX=""
E2E_ERR_TRAP=1

ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
api() { k exec -i "$(ingest_pod)" -c ingest -- node - call "$@" <"$here/client-4b.mjs"; }
results() { k exec -i "$(ingest_pod)" -c ingest -- node - results "$@" <"$here/client-4b.mjs"; }
sql() { e2e_db -c "$1"; }
orch_log() { k logs deploy/pi-orchestrator --tail=2000; }

admin() { api alice "$@"; } # METHOD PATH [BODY]
cleanup() {
  local id
  admin DELETE /admin/mcp-servers/deepwiki >/dev/null 2>&1 || true
  admin DELETE /admin/mcp-servers/blocked >/dev/null 2>&1 || true
  # No DELETE for profiles (their versions are the audit trail): leave research disabled for new sessions.
  admin PUT /admin/profiles/research '{"enabledForNew":false}' >/dev/null 2>&1 || true
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

orch_pod() {
  k get pods -l app.kubernetes.io/name=pi-orchestrator -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
wait_log() { # description pattern seconds
  local deadline=$(($(now) + $3))
  until orch_log | grep -q "$2"; do
    [[ $(now) -lt $deadline ]] || {
      note "no log line matching $2 after $3 s ($1); last discovery failures:"
      orch_log | grep 'mcp-discovery-failed' | tail -3 | cut -c1-300 || true
      exit 1
    }
    sleep 3
  done
  note "ok: $1"
}
new_session() { # [profile] sets $id
  local out body='{"provider":"scripted","model":"scripted-1"}'
  [[ -z ${1:-} ]] || body=$(jq -c --arg p "$1" '. + {profile:$p}' <<<"$body")
  out=$(api alice POST /sessions "$body")
  assert_jq "session created" "$out" '.status==201'
  [[ -z ${1:-} ]] || assert_jq "the response echoes the profile" "$out" ".body.profile.name==\"$1\" and .body.profile.version>=1"
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
}
send_script() { # session-id needle steps-json -> prints the results JSON
  local script
  script=$(jq -nc --argjson s "$3" --arg f "$2" '{steps:$s, final:$f}')
  api alice POST "/sessions/$1/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  results alice "$1" "$2" 120
}

# ---------------------------------------------------------------- tests
t_add() {
  local out
  out=$(admin PUT /admin/mcp-servers/deepwiki '{"url":"https://mcp.deepwiki.com/mcp","readOnly":true}')
  assert_jq "the server was created (or already existed)" "$out" '.status==201 or .status==200'
  assert_jq "the row is enabled, https, streamable-http" "$out" '.body | .enabled==true and .transport=="streamable-http" and (.url|startswith("https://"))'
  orch_pod >"$work/orch_pod_before"
  wait_log "the orchestrator added the server without a restart" '"event":"mcp-server-added","server":"deepwiki"' 90
  wait_log "deepwiki tools discovered" '"event":"mcp-tools-ready","server":"deepwiki"' 120
}

t_profile() {
  local out
  out=$(admin PUT /admin/profiles/research '{"definition":{"mcpServers":["deepwiki"],"instructions":"Answer from the wiki."},"enabledForNew":true}')
  assert_jq "the profile was created or updated" "$out" '.status==201 or .status==200'
  assert_jq "it selects deepwiki" "$out" '.body.definition.mcpServers==["deepwiki"]'
  assert_jq "an MCP server that is not in the catalog is refused" "$(admin PUT /admin/profiles/bad '{"definition":{"mcpServers":["no-such-server"]}}')" '.status==400'
  assert_jq "the default profile has no MCP servers" "$(admin GET /admin/profiles/coding)" '.body.definition.mcpServers==null'
}

t_call() {
  local id res
  new_session research
  # tool_search loads the deferred tools; the next step calls one by name. Neither step touches the sandbox.
  res=$(send_script "$id" mcp-finished '[
      {"tool":"tool_search","args":{"query":"read wiki structure of a repository"}},
      {"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}
    ]')
  echo "$id" >"$work/call_session"
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

t_default() {
  local id res
  new_session
  assert_jq "the response names the default profile" "$(api alice GET "/sessions/$id")" '.body.profile.name=="coding"'
  # deepwiki is enabled in the catalog, but the coding profile selects no MCP server: nothing to search, nothing to call.
  res=$(send_script "$id" mcp-default '[
      {"tool":"tool_search","args":{"query":"read wiki structure of a repository"}},
      {"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}
    ]')
  assert_jq "tool_search is not available to a session without MCP" "$res" '.found==true and (.results[0] | .isError==true and (.text|test("not available")))'
  assert_jq "the MCP tool is not available either" "$res" '.results[1] | .isError==true and (.text|test("not available"))'
}

t_edit() {
  local id out
  id=$(cat "$work/call_session" 2>/dev/null || true)
  [[ -n $id ]] || {
    note "SKIPPED: run the call test first (it creates the session this test checks)"
    return 3
  }
  out=$(admin PUT /admin/profiles/research '{"definition":{"mcpServers":["deepwiki"],"instructions":"A different instruction."}}')
  assert_jq "the edit made a new version" "$out" '.body.currentVersion>=2 and .body.versionCreated==true'
  assert_jq "the session keeps the version it was created with" "$(api alice GET "/sessions/$id")" ".body.profile.version==$(($(jq -r .body.currentVersion <<<"$out") - 1))"
  assert_eq "its stored snapshot is unchanged" "Answer from the wiki." "$(sql "select profile_snapshot->>'instructions' from inbox.sessions where id='$id'")"
}

t_disable() {
  local id res out
  id=$(cat "$work/call_session" 2>/dev/null || true)
  [[ -n $id ]] || {
    note "SKIPPED: run the call test first (it creates the session this test calls again)"
    return 3
  }
  out=$(admin PUT /admin/mcp-servers/deepwiki '{"enabled":false}')
  assert_jq "the server is disabled" "$out" '.status==200 and .body.enabled==false'
  wait_log "the orchestrator removed the server without a restart" '"event":"mcp-server-removed","server":"deepwiki"' 90
  # The same session, a NEW call: the tool settles tool_unavailable, it does not hang and it does not run.
  res=$(send_script "$id" mcp-disabled '[{"tool":"mcp__deepwiki__read_wiki_structure","args":{"repoName":"facebook/react"}}]')
  assert_jq "the call after disabling is tool_unavailable" "$res" '.found==true and (.results|last|.isError==true and (.text|test("not available")))'
  assert_eq "the orchestrator was not restarted" "$(cat "$work/orch_pod_before")" "$(orch_pod)"
}

t_unreachable() {
  local out id res
  # A row never opens egress (docs/decisions/0009): a host outside the OneCLI allowlist is stored fine, and fails to connect.
  out=$(admin PUT /admin/mcp-servers/blocked '{"url":"https://not-allowlisted.invalid/mcp","readOnly":true}')
  assert_jq "the row is stored" "$out" '.status==201 or .status==200'
  wait_log "discovery fails for the host that is not allowlisted" '"event":"mcp-discovery-failed","server":"blocked"' 90
  new_session
  res=$(send_script "$id" mcp-blocked '[{"tool":"mcp__blocked__anything","args":{}}]')
  assert_jq "its tools are tool_unavailable" "$res" '.found==true and (.results|last|.isError==true and (.text|test("not available")))'
  admin DELETE /admin/mcp-servers/blocked >/dev/null
}

t_history() {
  local out
  admin DELETE /admin/mcp-servers/deepwiki >/dev/null 2>&1 || true
  out=$(admin GET '/admin/mcp-servers/history?name=deepwiki&limit=20')
  assert_jq "the history has create, update and delete by alice" "$out" '[.body.history[] | select(.changedBy=="alice") | .action] as $a | ($a|index("create")) != null and ($a|index("update")) != null and ($a|index("delete")) != null'
  assert_jq "the server is gone from the list" "$(admin GET /admin/mcp-servers)" '[.body.servers[].name] | index("deepwiki") == null'
}

# ---------------------------------------------------------------- driver
# The tests share the MCP catalog and the research profile, and run in the dependency order of the header. Only call and
# default are independent of each other once add and profile are done (own sessions, they only read the catalog), so
# they run side by side. Everything that edits the catalog or the profile (add, profile, edit, disable, unreachable,
# history) is serial, around them.
e2e_db_start
e2e_serial add t_add
e2e_serial profile t_profile

e2e_parallel call:t_call default:t_default
e2e_serial edit t_edit
e2e_serial disable t_disable
e2e_serial unreachable t_unreachable
e2e_serial history t_history

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
