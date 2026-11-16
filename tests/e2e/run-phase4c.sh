#!/usr/bin/env bash
# Phase 4c acceptance tests: the optional repository workspace through OneCLI and a repo-scoped GitHub App token.
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh phase4c`. WRITTEN, NOT YET RUN: it needs the new
# sandbox image (git + ca-certificates) in the SandboxTemplate, the ExternalSecrets pi-github-app and pi-onecli-admin
# synced, the OneCLI CA ConfigMap, and the NetworkPolicies that let the orchestrator reach api.github.com.
#
#   no-repo       a session without a repo is unchanged: no repo columns, no OneCLI agent or secret, no repo directory
#   clone-push    REPO_A (private): cloned before the first turn, the OneCLI agent holds exactly the session's two GitHub
#                 secrets (no LLM key, no connection), a push to a test branch works and the branch is removed again,
#                 and no GitHub token is readable in the sandbox
#   restart-skip  after an orchestrator restart the clone is found and skipped (log `workspace-present`, no
#                 `workspace-cloned`), and a file the agent wrote in the clone is still there
#   scope         the token for REPO_A cannot read REPO_B (a private repo of the same installation)
#   delete        after DELETE the OneCLI agent and both secrets are gone and the tombstone is completed
#
# REPO_A and REPO_B (owner/name) are required for the last four; without them those tests are SKIPPED, never faked.
# ONLY="no-repo,clone-push" runs just those tests. clone-push creates the shared repo session; the later tests reuse
# it, so run them together (restart-skip, scope and delete SKIP when it does not exist).
#
# All OneCLI API calls run inside the orchestrator pod (`kubectl exec ... node`), which already holds ONECLI_API_KEY:
# no key or token is read, passed or printed here. Exit code: 0 when no test failed (SKIPPED is not a failure).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
# The OneCLI name prefix of this run's orchestrator (PI_ONECLI_NAME_PREFIX, set by run.sh in the Job and in the overlay).
# The OneCLI workspace is shared with other stacks, so the suite finds only its own stack's agents and secrets by it.
onecli_prefix=${PI_ONECLI_NAME_PREFIX:?PI_ONECLI_NAME_PREFIX is the OneCLI name prefix of the run; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
repo_session_file=$work/repo-session
: >"$sessions_file"
run_id=$(date +%s)
branch="agent/pi-e2e-$run_id" # the agent ruleset (deploy/agent-ruleset.sh) only allows agent/**

k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }

ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
api() { k exec -i "$(ingest_pod)" -c ingest -- node - call "$@" <"$here/client-4b.mjs"; }
stream_has() { k exec -i "$(ingest_pod)" -c ingest -- node - stream "$@" <"$here/client-4b.mjs"; }
answer_has() { k exec -i "$(ingest_pod)" -c ingest -- node - answer "$@" <"$here/client-4b.mjs" | cut -d" " -f1; }
sql() { k exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -v ON_ERROR_STOP=1 -c "$1"; }
orch_log() { k logs deploy/pi-orchestrator --tail=2000; }

# OneCLI management API through the orchestrator pod, which holds the key. Prints the response body.
onecli() { # METHOD PATH
  k exec deploy/pi-orchestrator -c orchestrator -- node -e '
    const [method, path] = process.argv.slice(1);
    fetch((process.env.PI_ONECLI_API ?? "http://onecli.onecli:10256") + path, {
      method, headers: { authorization: `Bearer ${process.env.ONECLI_API_KEY}` } })
      .then(async (r) => {
        // An HTTP error body would parse as "nothing found" and make a negative assertion pass.
        if (!r.ok) { console.error(`OneCLI ${method} ${path}: HTTP ${r.status}`); process.exit(1); }
        process.stdout.write(await r.text() || "[]");
      })
      .catch((e) => { console.error(e.message); process.exit(1); });' "$1" "$2"
}
# Counts the objects a jq filter selects in a OneCLI listing. A failed request prints "onecli-error", never 0.
onecli_count() { # PATH jq-args... filter
  local body
  body=$(onecli GET "$1") || {
    echo onecli-error
    return 0
  }
  jq "${@:2}" <<<"$body"
}

cleanup() {
  local id
  while read -r id; do
    [[ -n $id ]] || continue
    api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  # Wait until every session is `deleted` (bounded), so the claims and OneCLI objects are gone when the run ends.
  # A failed query is not "nothing left": it is retried until the deadline.
  local list deadline pending drained=0
  list=$(grep -v '^$' "$sessions_file" | sed "s/.*/'&'/" | paste -sd, - || true) # no session created: empty list
  deadline=$(($(now) + 180))
  while [[ -n $list && $(now) -lt $deadline ]]; do
    if pending=$(sql "select id from inbox.sessions where status <> 'deleted' and id in ($list)" 2>/dev/null) && [[ -z $pending ]]; then
      drained=1
      break
    fi
    sleep 3
  done
  [[ -z $list || $drained -eq 1 ]] || note "cleanup: sessions not deleted after the wait (or status unreadable); their claims may remain"
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
wait_status() { # owner session wanted-status timeout-seconds
  local deadline=$(($(now) + $4)) out
  while :; do
    out=$(api "$1" GET "/sessions/$2")
    if [[ $(jq -r '.body.status // empty' <<<"$out") == "$3" ]]; then
      printf '%s' "$out"
      return 0
    fi
    if [[ $(now) -ge $deadline ]]; then
      note "TIMEOUT after $4s waiting for session $2 to be $3"
      return 1
    fi
    sleep 2
  done
}
script() { # final cmd... -> the scripted model's input: one bash step per command
  local final=$1 steps='[]' cmd
  shift
  for cmd in "$@"; do steps=$(jq -c --arg b "$cmd" '. + [{bash:$b, timeout:300}]' <<<"$steps"); done
  jq -nc --argjson s "$steps" --arg f "$final" '{steps:$s, final:$f}'
}
send() { # session final cmd... -> posts the script as a message
  local id=$1
  shift
  api alice POST "/sessions/$id/events" "$(jq -nc --arg t "$(script "$@")" '{kind:"message", text:$t}')" >/dev/null
}
# stream_has searches the whole stream, the user's message included. Needles inside commands are split with '' (kept
# by the outer double quotes, removed by the sandbox's bash), so only tool output contains them. Final answers are
# in the message too, so wait for them with answer_has (assistant text after a tool call).
need_repos() {
  if [[ -z ${REPO_A:-} || -z ${REPO_B:-} ]]; then
    note "SKIPPED: set REPO_A and REPO_B (owner/name, private, in the GitHub App installation) to run this test"
    return 3
  fi
}
need_repo_session() {
  need_repos || return 3
  if [[ ! -s $repo_session_file ]]; then
    note "SKIPPED: the shared repo session does not exist (run clone-push first)"
    return 3
  fi
  repo_session=$(cat "$repo_session_file")
}
repo_session=""

# ---------------------------------------------------------------- tests
t_no_repo() {
  local out id
  out=$(api alice POST /sessions '{"provider":"scripted","model":"scripted-1"}')
  assert_jq "session created" "$out" '.status==201 and (.body|has("repo")|not)'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  send "$id" plain-done "pwd" "ls -A /workspace | wc -l"
  # answer_has, not stream_has: the final answer text is also in the user's own message.
  assert_eq "the session answers" found "$(answer_has alice "$id" plain-done 90)"
  assert_eq "no repo columns, no OneCLI ids, no ready marker" "||" "$(sql "select coalesce(repo,'')||'|'||coalesce(onecli_agent_id,'')||'|'||coalesce(workspace_ready_at::text,'') from inbox.sessions where id='$id'")"
  assert_eq "no OneCLI agent exists for it" 0 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$id" '[.. | objects | select(.identifier? == $n)] | length')"
  assert_eq "no OneCLI secret exists for it" 0 "$(onecli_count /v1/secrets --arg n "${onecli_prefix}$id" '[.. | objects | select((.name? // "") | startswith($n))] | length')"
  out=$(api alice POST /sessions '{"repo":"https://github.com/a/b"}')
  assert_jq "a URL is refused" "$out" '.status==400'
  out=$(api alice POST /sessions '{"repo":"a/b","branch":"--upload-pack=x"}')
  assert_jq "an option-like branch is refused" "$out" '.status==400'
  out=$(api alice POST /sessions '{"repo":"a/../b"}')
  assert_jq "a traversal is refused" "$out" '.status==400'
}

t_clone_push() {
  local out id sid agent_id grants names
  need_repos || return 3
  out=$(api alice POST /sessions "$(jq -nc --arg r "$REPO_A" '{provider:"scripted", model:"scripted-1", repo:$r}')")
  assert_jq "repo session created" "$out" '.status==201 and .body.repo!=null'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  echo "$id" >"$repo_session_file"
  sid=$id
  # Everything in one script: clone present, sentinel for the restart test, token checks, push, ls-remote, remove branch.
  send "$id" clone-push-finished \
    "test -d /workspace/repo/.git && echo CLONE_O''K" \
    "test -f /workspace/.pi-workspace.json && echo MARKER_O''K" \
    "echo sentinel >/workspace/repo/.e2e-sentinel" \
    "! env | grep -q -E 'ghs[_]|github_pat[_]' && echo ENV_CLE''AN_OK" \
    "! grep -r -q -E 'ghs[_]|github_pat[_]' /workspace/repo/.git/config && { [ ! -e /workspace/.onecli ] || ! grep -r -q -E 'ghs[_]|github_pat[_]' /workspace/.onecli; } && echo FILES_CLE''AN_OK" \
    "cd /workspace/repo && git checkout -q -b $branch && date >e2e-$run_id.txt && git add e2e-$run_id.txt && git commit -q -m 'e2e $run_id' && git push -q origin HEAD:refs/heads/$branch && echo PUSH_O''K" \
    "cd /workspace/repo && git ls-remote origin refs/heads/$branch | wc -l" \
    "cd /workspace/repo && git push -q origin --delete $branch && echo BRANCH_REMO''VED"
  assert_eq "the session ran its script" found "$(answer_has alice "$id" clone-push-finished 240)"
  for needle in CLONE_OK MARKER_OK ENV_CLEAN_OK FILES_CLEAN_OK PUSH_OK BRANCH_REMOVED; do
    assert_eq "tool output has $needle" found "$(stream_has alice "$id" "$needle" 20)"
  done
  assert_jq "the session is still active" "$(api alice GET "/sessions/$id")" '.body.status=="active"'
  assert_eq "the clone is recorded as ready" t "$(sql "select (workspace_ready_at is not null) from inbox.sessions where id='$id'" | tr -d ' ')"
  assert_eq "the orchestrator logged one clone" 1 "$(orch_log | grep -c "\"event\":\"workspace-cloned\".*$id")"

  agent_id=$(sql "select onecli_agent_id from inbox.sessions where id='$id'")
  [[ -n $agent_id ]] || {
    note "ASSERT FAILED: no OneCLI agent id stored"
    exit 1
  }
  grants=$(onecli GET "/v1/agents/$agent_id/grants")
  note "grants shape (ids only): $(jq -c '[.. | objects | keys] | add | unique' <<<"$grants" 2>/dev/null || echo unreadable)"
  names=$(onecli GET /v1/secrets | jq -r --arg n "${onecli_prefix}$sid" '[.. | objects | select((.name? // "") | startswith($n)) | .name] | sort | join(",")')
  assert_eq "exactly this session's two GitHub secrets exist" "${onecli_prefix}$sid-api,${onecli_prefix}$sid-git" "$names"
  # Narrow grants: the count of every id in the answer is 2 (the two secrets) and no connection appears.
  assert_eq "the agent holds exactly two grants and no connection" 2 "$(jq '[.. | objects | select(has("id") or has("secretId") or has("connectionId"))] | length' <<<"$grants")"
  assert_jq "no LLM secret is granted" "$grants" '([.. | strings | select(test("Codex|OpenRouter|openai|anthropic";"i"))] | length) == 0'
  # UNVERIFIED: whether the effective view of the gateway matches. A model-host request through this agent's token
  # should get 401 access_restricted (docs/model-credentials.md); not automated because the sandbox has no curl.
  if orch_log | grep -q -E 'ghs_|aoc_|oc_[0-9a-f]{8}'; then
    note "ASSERT FAILED: the orchestrator log holds something shaped like a GitHub token or OneCLI key"
    exit 1
  fi
  note "ok: no token-shaped text in the orchestrator log"
}

t_restart_skip() {
  need_repo_session || return 3
  # Scale 0 -> 1 rather than rollout restart: the driver may scale but not patch Deployments.
  k scale deploy/pi-orchestrator --replicas=0 >/dev/null
  k wait --for=delete pod -l app.kubernetes.io/instance=pi-orchestrator --timeout=120s >/dev/null 2>&1 || true
  k scale deploy/pi-orchestrator --replicas=1 >/dev/null
  k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null
  # The first input after the restart prepares the workspace again: provision, re-mint, find the clone.
  send "$repo_session" after-restart "grep -qx sentinel /workspace/repo/.e2e-sentinel && echo SENTINEL_O''K" "git -C /workspace/repo rev-parse --is-inside-work-tree"
  assert_eq "the session answers after the restart" found "$(answer_has alice "$repo_session" after-restart 240)"
  assert_eq "the sentinel written before the restart is still there" found "$(stream_has alice "$repo_session" SENTINEL_OK 20)"
  assert_eq "the clone was found and skipped" 1 "$(orch_log | grep -c "\"event\":\"workspace-present\".*$repo_session")"
  assert_eq "no second clone after the restart" 0 "$(orch_log | grep -c "\"event\":\"workspace-cloned\".*$repo_session" || true)"
  assert_eq "still exactly one OneCLI agent for the session" 1 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$repo_session" '[.. | objects | select(.identifier? == $n)] | length')"
}

t_scope() {
  need_repo_session || return 3
  send "$repo_session" scope-finished \
    "cd /workspace/repo && git push --dry-run https://github.com/$REPO_B.git HEAD:refs/heads/e2e-scope-$run_id >/dev/null 2>&1 && echo B_REACH''ABLE || echo B_DEN''IED" \
    "cd /workspace/repo && git push --dry-run https://github.com/$REPO_A.git HEAD:refs/heads/e2e-scope-$run_id >/dev/null 2>&1 && echo A_REACH''ABLE || echo A_DEN''IED"
  assert_eq "the scope script ran" found "$(answer_has alice "$repo_session" scope-finished 180)"
  assert_eq "repo A accepts a push with its token (dry run)" found "$(stream_has alice "$repo_session" A_REACHABLE 20)"
  assert_eq "repo B refuses a push with A's token (dry run)" found "$(stream_has alice "$repo_session" B_DENIED 20)"
  assert_eq "repo B never answered as reachable" timeout "$(stream_has alice "$repo_session" B_REACHABLE 5)"
  # NOT covered here (needs a second pod): "rejected from another pod's IP". OneCLI v2 has no source binding.
}

t_delete() {
  local agent_id
  need_repo_session || return 3
  agent_id=$(sql "select onecli_agent_id from inbox.sessions where id='$repo_session'")
  assert_jq "DELETE is accepted" "$(api alice DELETE "/sessions/$repo_session")" '.status==202'
  wait_status alice "$repo_session" deleted 120 >/dev/null || exit 1
  assert_eq "the OneCLI agent is gone" 0 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$repo_session" '[.. | objects | select(.identifier? == $n)] | length')"
  assert_eq "its secrets are gone" 0 "$(onecli_count /v1/secrets --arg n "${onecli_prefix}$repo_session" '[.. | objects | select((.name? // "") | startswith($n))] | length')"
  assert_eq "the old agent id no longer has grants" 0 "$(onecli GET "/v1/agents/$agent_id/grants" | jq '[.. | objects | select(has("id"))] | length' 2>/dev/null || echo 0)"
  assert_eq "the tombstone was written first and completed" t "$(sql "select (completed_at is not null) from inbox.tombstones where session_id='$repo_session'" | tr -d ' ')"
  assert_eq "the claim is gone" 0 "$(k get sandboxclaims -l "pi-durable-k8s/session-id=$repo_session" -o name | wc -l | tr -d ' ')"
  : >"$repo_session_file"
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

run no-repo t_no_repo
run clone-push t_clone_push
run restart-skip t_restart_skip
run scope t_scope
run delete t_delete

log "summary"
for line in "${summary[@]}"; do note "$line"; done
note "passed=$pass failed=$fail skipped=$skip"
log "RESULT"
printf '%s\n' "${summary[@]}"
if [[ $fail -ne 0 ]]; then
  echo "PHASE 4C: FAILED" >&2
  exit 1
fi
echo "PHASE 4C: all tests passed"
