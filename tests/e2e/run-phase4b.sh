#!/usr/bin/env bash
# Phase 4b acceptance tests: per-session model, allowlist, and terminal failure on rejected model credentials.
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh phase4b` (ServiceAccount kubeconfig, no
# context); it also still runs from a Mac (MODE=cluster with a kubectl context, or MODE=local against a local stack).
#
#   models        two sessions on different allowed models are recorded correctly (API, database) and both answer
#   disallowed    a model outside the allowlist gets 400 and creates no session
#   failed-401    a simulated 401 from the model makes the session `failed` with a clear message, once: the
#                 orchestrator does not restart, nothing is retried, further input gets 409, DELETE still works
#   real-model    REAL_MODEL=1 only: OpenAI Codex models (gpt-6.1-terra, gpt-6.1-sol) answer through OneCLI after one
#                 sandbox tool call, with no provider key in the orchestrator. Runs only if Secret `pi-onecli` exists
#                 in the namespace; otherwise it says so and is reported as SKIPPED (never faked). Two real turns.
#
# ONLY="models,disallowed" runs just those tests (debugging aid). Prerequisite: the deployed ingest and orchestrator run
# this branch's code and the stored allowlist (inbox.settings; seeded from ConfigMap `pi-model-config`) allows scripted/scripted-1 and scripted/scripted-2 (the committed
# allowlist has them next to the Codex models). All API calls run inside an ingest pod, so API tokens stay in the
# cluster; nothing here reads or prints a secret value. Throwaway sessions are deleted on exit.
#
#   MODE=cluster (default)  the current kubectl context, namespace $NAMESPACE (an e2e run namespace)
#   MODE=local              a local stack: API_BASE (ingest URL), PI_API_TOKENS or API_TOKEN, LOCAL_DB_URL (psql
#                           URL), ORCH_LOG (the orchestrator's log file); the real-model test is not available
#
# Exit code: 0 when no test failed (SKIPPED is not a failure), 1 otherwise.
set -euo pipefail

mode=${MODE:-cluster}
ctx=${KUBE_CONTEXT:-} # empty in the Job: kubectl then uses the in-cluster ServiceAccount config
ns=${NAMESPACE:-} # the e2e run namespace; tests/e2e/run.sh sets it in the Job
[[ $mode == local || -n $ns ]] || { echo "NAMESPACE is not set (the e2e run namespace; tests/e2e/run.sh sets it in the Job)" >&2; exit 64; }
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"

k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }

# ---------------------------------------------------------------- adapters: cluster or local stack
ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
api() { # owner method path [body] -> {"status":N,"body":...}
  if [[ $mode == local ]]; then
    node "$here/client-4b.mjs" call "$@"
  else
    k exec -i "$(ingest_pod)" -c ingest -- node - call "$@" <"$here/client-4b.mjs"
  fi
}
answer_has() { # owner session needle seconds -> "found <tool calls>"|timeout
  if [[ $mode == local ]]; then
    node "$here/client-4b.mjs" answer "$@"
  else
    k exec -i "$(ingest_pod)" -c ingest -- node - answer "$@" <"$here/client-4b.mjs"
  fi
}
stream_has() { # owner session needle seconds -> found|timeout
  if [[ $mode == local ]]; then
    node "$here/client-4b.mjs" stream "$@"
  else
    k exec -i "$(ingest_pod)" -c ingest -- node - stream "$@" <"$here/client-4b.mjs"
  fi
}
sql() {
  if [[ $mode == local ]]; then
    psql "$LOCAL_DB_URL" -At -v ON_ERROR_STOP=1 -c "$1"
  else
    k exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -v ON_ERROR_STOP=1 -c "$1"
  fi
}
orch_restarts() {
  if [[ $mode == local ]]; then
    echo $(($(grep -c '"event":"listening"' "$ORCH_LOG") - 1))
  else
    # The live pod only: right after a rollout `items[0]` can be a terminating pod without container statuses, and
    # the failed lookup used to end the test silently under `set -e`.
    k get pods -l app.kubernetes.io/name=pi-orchestrator -o json |
      jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].status.containerStatuses[0].restartCount'
  fi
}
orch_log() {
  if [[ $mode == local ]]; then cat "$ORCH_LOG"; else k logs deploy/pi-orchestrator --tail=500; fi
}
# True when the orchestrator log matches. An unreadable log fails the test: "no match" must not come from a failed read.
orch_log_matches() { # extended regex
  local out
  out=$(orch_log) || {
    note "ASSERT FAILED: could not read the orchestrator log"
    exit 1
  }
  grep -q -E "$1" <<<"$out"
}

cleanup() {
  local id
  while read -r id; do
    [[ -n $id ]] || continue
    api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  # The delete is asynchronous (the orchestrator removes the sandbox first): wait (bounded) until every session is
  # `deleted`, then drop the rows of the sessions that got there. Dropping a row earlier would orphan a claim the
  # delete had not reached yet, so the others are reported and kept. A failed query is not "nothing left": it is
  # retried until the deadline.
  local list deadline pending status
  list=$(grep -v '^$' "$sessions_file" | sed "s/.*/'&'/" | paste -sd, - || true) # no session created: empty list
  deadline=$(($(now) + 180))
  while [[ -n $list && $(now) -lt $deadline ]]; do
    if pending=$(sql "select id from inbox.sessions where status <> 'deleted' and id in ($list)" 2>/dev/null) && [[ -z $pending ]]; then
      break
    fi
    sleep 3
  done
  while read -r id; do
    [[ -n $id ]] || continue
    if ! status=$(sql "select status from inbox.sessions where id='$id'" 2>/dev/null | tr -d ' '; exit "${PIPESTATUS[0]}"); then
      note "cleanup: could not read the status of session $id; keeping its rows"
    elif [[ -z $status || $status == deleted ]]; then
      sql "delete from inbox.events where session_id='$id'; delete from inbox.sessions where id='$id'" >/dev/null 2>&1 ||
        note "cleanup: could not delete the rows of session $id"
    else
      note "cleanup: session $id is still '$status' after the wait; keeping its rows (its claim may remain)"
    fi
  done <"$sessions_file"
  rm -rf "$work"
}
trap cleanup EXIT

# ---------------------------------------------------------------- assertions (exit the test's subshell)
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
    note "  got: $(jq -c . <<<"$2" 2>/dev/null | cut -c1-500 || printf '%s' "$2" | cut -c1-500)"
    exit 1
  fi
}
wait_status() { # owner session wanted-status timeout-seconds -> the last GET body
  local deadline=$(($(now) + $4)) out
  while :; do
    out=$(api "$1" GET "/sessions/$2")
    if [[ $(jq -r '.body.status // empty' <<<"$out") == "$3" ]]; then
      printf '%s' "$out"
      return 0
    fi
    if [[ $(now) -ge $deadline ]]; then
      note "TIMEOUT after $4s waiting for session $2 to be $3"
      printf '%s' "$out"
      return 1
    fi
    sleep 2
  done
}
new_session() { # owner [body] -> response JSON; records the id for cleanup
  local out
  # The deployed default may be a real model, so a bare call asks for the scripted one explicitly.
  local body=${2:-}
  [[ -n $body ]] || body='{"provider":"scripted","model":"scripted-1"}'
  out=$(api "$1" POST /sessions "$body")
  jq -r '.body.sessionId // empty' <<<"$out" >>"$sessions_file"
  printf '%s' "$out"
}

# ---------------------------------------------------------------- tests
t_models() {
  local a b ida idb out
  a=$(new_session alice)
  b=$(new_session alice '{"provider":"scripted","model":"scripted-2"}')
  assert_jq "default session created on scripted/scripted-1" "$a" '.status==201 and .body.provider=="scripted" and .body.model=="scripted-1"'
  assert_jq "explicit session created on scripted/scripted-2 (is it in the settings allowlist?)" "$b" '.status==201 and .body.model=="scripted-2"'
  ida=$(jq -r .body.sessionId <<<"$a")
  idb=$(jq -r .body.sessionId <<<"$b")
  assert_eq "database records the default model" "scripted/scripted-1" "$(sql "select model_provider||'/'||model_id from inbox.sessions where id='$ida'")"
  assert_eq "database records the requested model" "scripted/scripted-2" "$(sql "select model_provider||'/'||model_id from inbox.sessions where id='$idb'")"
  out=$(api alice GET "/sessions/$ida")
  assert_jq "GET reports the default model" "$out" '.body.model.provider=="scripted" and .body.model.model=="scripted-1"'
  out=$(api alice GET "/sessions/$idb")
  assert_jq "GET reports the requested model" "$out" '.body.model.model=="scripted-2"'
  api alice POST "/sessions/$ida/events" '{"kind":"message","text":"hello a"}' >/dev/null
  api alice POST "/sessions/$idb/events" '{"kind":"message","text":"hello b"}' >/dev/null
  assert_eq "session A answers on its model" found "$(stream_has alice "$ida" "echo: hello a" 60)"
  assert_eq "session B answers on its model" found "$(stream_has alice "$idb" "echo: hello b" 60)"
}

t_disallowed() {
  local before out
  before=$(sql "select count(*) from inbox.sessions")
  out=$(api alice POST /sessions '{"provider":"openai","model":"gpt-5"}')
  assert_jq "a model outside the allowlist is 400" "$out" '.status==400 and (.body.error|test("not allowed"))'
  out=$(api alice POST /sessions '{"provider":"scripted","model":"scripted-1/other"}')
  assert_jq "the model must match as a whole" "$out" '.status==400'
  out=$(api alice POST /sessions '{"provider":"scripted"}')
  assert_jq "provider without model is 400" "$out" '.status==400'
  assert_eq "no session was created" "$before" "$(sql "select count(*) from inbox.sessions")"
}

t_failed_401() {
  local c id restarts out text
  c=$(new_session alice)
  id=$(jq -r .body.sessionId <<<"$c")
  restarts=$(orch_restarts)
  text=$(jq -cn '{kind:"message", text:({steps:[], error:"401 Unauthorized: simulated rejected credentials"}|tostring)}')
  api alice POST "/sessions/$id/events" "$text" >/dev/null
  out=$(wait_status alice "$id" failed 90) || exit 1
  assert_jq "the session is failed, with a clear message" "$out" '.body.status=="failed" and (.body.failure|test("401/403")) and (.body.failure|test("OneCLI"))'
  assert_jq "the failure message does not repeat the provider's text" "$out" '(.body.failure|test("simulated")|not)'
  out=$(api alice POST "/sessions/$id/events" '{"kind":"message","text":"again"}')
  assert_jq "further input is refused with 409" "$out" '.status==409'
  sleep 15
  assert_eq "the orchestrator did not restart" "$restarts" "$(orch_restarts)"
  assert_eq "the event was submitted once, not retried" "1|submitted" "$(sql "select attempts||'|'||status from inbox.events where session_id='$id' and kind='message' and payload->>'text' like '%401%'")"
  assert_eq "the session stays failed" failed "$(sql "select status from inbox.sessions where id='$id'")"
  if orch_log_matches 'fail-closed|"event":"fatal"'; then
    note "ASSERT FAILED: the orchestrator logged a fatal or fail-closed event"
    exit 1
  fi
  note "ok: no fatal or fail-closed event in the orchestrator log"
  out=$(api alice DELETE "/sessions/$id")
  assert_jq "a failed session can still be deleted" "$out" '.status==202'
  wait_status alice "$id" deleted 60 >/dev/null || exit 1
  note "ok: the failed session was deleted"
}

t_real_model() {
  # OpenAI Codex (ChatGPT subscription) through OneCLI. The default pair is in the committed ConfigMap's allowlist.
  local models=${REAL_MODELS:-openai-codex/gpt-6.1-terra,openai-codex/gpt-6.1-sol}
  local entry provider model out id answer secret_err env_names
  if [[ $mode == local ]]; then
    note "SKIPPED: the real-model test needs the cluster (MODE=cluster)"
    return 3
  fi
  if ! secret_err=$(k get secret pi-onecli -o name 2>&1 >/dev/null); then
    if [[ $secret_err != *NotFound* ]]; then
      note "ASSERT FAILED: could not look up Secret pi-onecli: $secret_err"
      exit 1
    fi
    note "SKIPPED: Secret pi-onecli does not exist in the namespace (ExternalSecret pi-onecli, key agent-token)."
    note "  See docs/model-credentials.md, Set up."
    return 3
  fi
  note "ok: pi-onecli delivered by the ExternalSecret"
  # Names only, never values: no provider credential is in the orchestrator's environment.
  env_names=$(k exec deploy/pi-orchestrator -- sh -c 'env | cut -d= -f1') || {
    note "ASSERT FAILED: could not list the orchestrator environment"
    exit 1
  }
  if grep -q -E '^(OPENROUTER|OPENAI|ANTHROPIC)_API_KEY$' <<<"$env_names"; then
    note "ASSERT FAILED: a provider API key is in the orchestrator environment"
    exit 1
  fi
  note "ok: no provider API key in the orchestrator environment"
  for entry in ${models//,/ }; do
    provider=${entry%%/*}
    model=${entry#*/}
    out=$(new_session alice "$(jq -cn --arg p "$provider" --arg m "$model" '{provider:$p, model:$m}')")
    assert_jq "session created on $entry" "$out" '.status==201'
    id=$(jq -r .body.sessionId <<<"$out")
    # printf splits the word, so the user's own message does not contain the needle.
    api alice POST "/sessions/$id/events" \
      '{"kind":"message","text":"Run `printf \"hel%s\" lo` in the sandbox and tell me exactly what it printed."}' >/dev/null
    answer=$(answer_has alice "$id" hello 180)
    case $answer in
      found*) note "ok: $entry answered with the tool output after ${answer#found } tool call(s)" ;;
      *)
        note "ASSERT FAILED: $entry did not answer with the tool output ($answer)"
        exit 1
        ;;
    esac
    assert_jq "the session is still active" "$(api alice GET "/sessions/$id")" '.body.status=="active"'
    if orch_log_matches 'aoc_|eyJ|sk-'; then
      note "ASSERT FAILED: the orchestrator log holds something shaped like a token or key"
      exit 1
    fi
    note "ok: no aoc_, JWT or sk- shaped text in the orchestrator log"
  done
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
    # An unexpected failing command must say so; a bare `set -e` exit left no output at all.
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

run models t_models
run disallowed t_disallowed
run failed-401 t_failed_401
if [[ ${REAL_MODEL:-0} == 1 ]]; then run real-model t_real_model; fi

log "summary"
for line in "${summary[@]}"; do note "$line"; done
note "passed=$pass failed=$fail skipped=$skip"
log "RESULT"
printf '%s\n' "${summary[@]}"
if [[ $fail -ne 0 ]]; then
  echo "PHASE 4B: FAILED" >&2
  exit 1
fi
echo "PHASE 4B: all tests passed"
