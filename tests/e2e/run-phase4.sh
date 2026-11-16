#!/usr/bin/env bash
# Runs IN the cluster, as the e2e-driver Job started by tests/e2e/run.sh (ServiceAccount kubeconfig, no context).
# The overlay tests/e2e/deploy (base deploy/ plus test-only orchestrator switches) and the code pushes are done by
# run.sh on the Mac before the Job starts; this script only waits for them and runs the tests.
# Phase 4 acceptance tests of the session API on the real cluster: ingest + orchestrator + CNPG + sandboxes,
# scripted fake model, no LLM. All API calls run inside an ingest pod (tests/e2e/client.mjs), so API tokens never
# leave the cluster and nothing is exposed outside it.
#
#   create-send-stream   create, send, stream to completion; sandbox is created lazily
#   dedup                the same sourceEventId posted twice is one submission
#   orchestrator-down    events posted while the orchestrator is down: 202, processed in order after it returns
#   crash-before-mark    orchestrator killed between submit and "submitted": no duplicate turn
#   busy-order           three rapid messages to a busy session arrive in order
#   steer                a steer during a running turn redirects it
#   reconnect            stream resumes after a client drop and after an orchestrator restart
#   auth                 wrong token and wrong owner are rejected
#   delete               DELETE removes the SandboxClaim and the PVC
#   concurrency          two sessions run at once without cross-talk
#   recycle-on-interrupt a cancelled command's `setsid` escapee is gone after the Pod is replaced; workspace and PVC stay
#   recycle-on-restart   the same after the orchestrator is killed mid-command
#   idle-suspend         an idle sandbox is Suspended (Pod gone, PVC kept) and the next message resumes it, file intact
#   orphan-sweep         orphaned labelled claims and their PVCs are removed; unlabelled claims and live sessions stay
#
# Touches only namespace $NAMESPACE (the run namespace pi-e2e-<id>). Secrets stay in the
# cluster: nothing here reads or prints them. Throwaway sessions, claims and PVCs are deleted on exit.
# Exit code: 0 when every test passed, 1 otherwise.
set -euo pipefail

ctx=${KUBE_CONTEXT:-} # empty in the Job: kubectl then uses the in-cluster ServiceAccount config
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd) # the driver volume mirrors the repo layout: tests/e2e and deploy/gen-api-secret.sh
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"
settings_before=$work/settings-before.json # the model settings found at start, restored on exit
bg_pids=()
extra_claims_file=$work/extra_claims # claims the lifecycle tests create by hand; removed on exit if the test did not
: >"$extra_claims_file"
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }
# shellcheck source=fns.sh
. "$here/fns.sh"

pg() { k exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -v ON_ERROR_STOP=1 "$@"; }

# Sessions the suite created, as "owner id" lines. They are deleted through the API on exit (the path a user takes:
# tombstone, OneCLI revoke, claim, PVC), then their rows are dropped. Only if that does not finish in time are the
# claims and PVCs removed directly, so a failed run still leaves nothing behind.
undeleted_sessions() { # prints the ids of recorded sessions whose status is not `deleted` yet
  local list
  list=$(awk 'NF==2 {printf "%s'"'"'%s'"'"'", sep, $2; sep=","}' "$sessions_file")
  [[ -n $list ]] || return 0
  pg -c "select id from inbox.sessions where status <> 'deleted' and id in ($list)"
}
cleanup() {
  local pid owner id conv claim deadline pending
  for pid in ${bg_pids[@]+"${bg_pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  k scale deployment pi-orchestrator --replicas=1 >/dev/null 2>&1 || true
  deadline=$(($(now) + 120))
  until orch_ready 2>/dev/null || [[ $(now) -ge $deadline ]]; do sleep 2; done
  while read -r owner id; do
    [[ -n "$id" ]] || continue
    api "$owner" DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  deadline=$(($(now) + 240))
  # A failed query is not "nothing left": retry it until the deadline, and treat it as "not deleted" below.
  while [[ $(now) -lt $deadline ]]; do
    if pending=$(undeleted_sessions 2>/dev/null) && [[ -z $pending ]]; then break; fi
    sleep 3
  done
  while read -r owner id; do
    [[ -n "$id" ]] || continue
    if ! pending=$(undeleted_sessions 2>/dev/null) || grep -qx "$id" <<<"$pending"; then
      conv=$(pg -c "select conversation_id from inbox.sessions where id='$id'" 2>/dev/null || true)
      if [[ -n "$conv" ]]; then
        claim=pi-conv-$conv
        k delete sandboxclaim "$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        k delete pvc "workspace-$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true
      fi
      # Keep the rows: the orchestrator's delete (and OneCLI revoke) can still retry, and dropping them would leak.
      note "session $id was not deleted through the API; its rows are kept"
      continue
    fi
    pg -c "delete from inbox.events where session_id='$id'; delete from inbox.sessions where id='$id'" >/dev/null 2>&1 || true
  done <"$sessions_file"
  while read -r claim; do
    [[ -n "$claim" ]] && { k delete sandboxclaim "$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
  done <"$extra_claims_file"
  if [[ -s $settings_before ]]; then
    [[ $(api alice PUT /admin/settings "$(cat "$settings_before")" 2>/dev/null | jq -r '.status // empty') == 200 ]] ||
      note "WARNING: could not restore the model settings; check GET /admin/settings (saved: $(cat "$settings_before"))"
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# ---------------------------------------------------------------- assertions (exit the test's subshell)
assert() { # description command...
  local desc=$1
  shift
  if "$@" >/dev/null 2>&1; then note "ok: $desc"; else
    note "ASSERT FAILED: $desc"
    exit 1
  fi
}
assert_jq() { # description json jq-expression
  if jq -e "$3" <<<"$2" >/dev/null 2>&1; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $3"
    note "  got: $(jq -c . <<<"$2" 2>/dev/null | cut -c1-600 || printf '%s' "$2" | cut -c1-600)"
    exit 1
  fi
}
assert_eq() { # description expected actual
  if [[ "$2" == "$3" ]]; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $2"
    note "  got: $3"
    exit 1
  fi
}
wait_for() { # description timeout-seconds command...
  local desc=$1 limit=$2 deadline
  shift 2
  deadline=$(($(now) + limit))
  until "$@" >/dev/null 2>&1; do
    if [[ $(now) -ge $deadline ]]; then
      note "TIMEOUT after ${limit}s waiting for: $desc"
      exit 1
    fi
    sleep 2
  done
  note "ok: $desc"
}

# ---------------------------------------------------------------- API client (runs inside an ingest pod)
ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
client() { k exec -i "$(ingest_pod)" -c ingest -- node - "$@" <"$here/client.mjs"; }
api() { client call "$@"; } # owner method path [body] [--base URL] -> {"status":N,"body":...}

new_session() { # owner -> prints the session id
  local out id
  out=$(api "$1" POST /sessions)
  id=$(jq -r '.body.sessionId' <<<"$out")
  [[ $(jq -r '.status' <<<"$out") == 201 && -n "$id" && "$id" != null ]] || {
    note "create session failed: $out"
    return 1
  }
  printf '%s %s\n' "$1" "$id" >>"$sessions_file"
  printf '%s\n' "$id"
}
post() { # owner session kind [text] [sourceEventId] -> the API response
  local body
  body=$(jq -nc --arg k "$3" --arg t "${4:-}" --arg s "${5:-}" \
    '{kind:$k} + (if $t != "" then {text:$t} else {} end) + (if $s != "" then {sourceEventId:$s} else {} end)')
  api "$1" POST "/sessions/$2/events" "$body"
}
mkscript() { # [-f final] bash-command... -> script JSON, the text of a message
  local final=done steps='[]' cmd
  if [[ ${1:-} == -f ]]; then
    final=$2
    shift 2
  fi
  for cmd in "$@"; do steps=$(jq -c --arg b "$cmd" '. + [{bash:$b, timeout:900}]' <<<"$steps"); done
  jq -nc --argjson s "$steps" --arg f "$final" '{steps:$s, final:$f}'
}

# ---------------------------------------------------------------- reading streams
# transcript owner session until-text [timeout]: replays the whole stream from the start (no Last-Event-ID).
transcript() { client stream "$1" "$2" --until-text "$3" --timeout "${4:-300}" --reconnect || true; }
entries() { sed -n 's/^ENTRY [0-9]* //p' <<<"$1" | jq -s .; } # stream output -> JSON array of entries
entry_ids() { sed -n 's/^ENTRY \([0-9]*\) .*/\1/p' <<<"$1"; }
ids_increasing() { entry_ids "$1" | increasing; }
increasing() { awk 'NR>1 && $1<=p {bad=1} {p=$1} END{exit bad}'; } # stdin: ids, strictly increasing
users() { jq -c '[.[] | .messages[] | select(.role=="user") | .text]' <<<"$1"; }
answers() { jq -c '[.[] | .messages[] | select(.role=="assistant" and (.calls|not)) | .text]' <<<"$1"; }
results() { jq -c '[.[] | .messages[] | select(.role=="toolResult") | .text]' <<<"$1"; }

# ---------------------------------------------------------------- cluster state
conv_of() { pg -c "select conversation_id from inbox.sessions where id='$1'"; }
claim_of() { printf 'pi-conv-%s\n' "$(conv_of "$1")"; }
ev_count() { pg -c "select count(*) from inbox.events where session_id='$1' ${2:+and $2}"; }
sandbox_ps() { k exec "$1" -c sandboxd -- ps -eo pid=,pgid=,sid=,args=; }
sandbox_has() { sandbox_ps "$1" | sed 's/^ *[0-9]* *[0-9]* *[0-9]* *//' | grep -qx -- "$2"; }
file_lines() { k exec "$1" -c sandboxd -- sh -c "wc -l < $2" | tr -d ' '; }
claim_exists() { k get sandboxclaim "$1" >/dev/null 2>&1; }
pvc_exists() { k get pvc "workspace-$1" >/dev/null 2>&1; }
pod_exists() { k get pod "$1" >/dev/null 2>&1; }
claim_gone() { ! claim_exists "$1"; }
pvc_gone() { ! pvc_exists "$1"; }
pod_gone() { ! pod_exists "$1"; }
sandbox_uid() { k get pod "$1" -o jsonpath='{.metadata.uid}'; }
pvc_uid() { k get pvc "workspace-$1" -o jsonpath='{.metadata.uid}'; }
sandbox_mode() { k get sandbox "$1" -o jsonpath='{.spec.operatingMode}'; }
mode_is() { [[ $(sandbox_mode "$1") == "$2" ]]; } # claim Running|Suspended
pod_replaced_ready() { # claim old-uid: a new Pod of that name is Ready
  local uid
  uid=$(k get pod "$1" -o jsonpath='{.metadata.uid}' 2>/dev/null) || return 1
  [[ -n $uid && $uid != "$2" && $(k get pod "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}') == True ]]
}
orch_log_has() { k logs deploy/pi-orchestrator --tail=5000 2>/dev/null | grep -q -- "$1"; } # pattern
orch_log_lines() { k logs deploy/pi-orchestrator --tail=5000 2>/dev/null | grep -- "$1" | cut -c1-260 | tail -3; }
mkclaim() { # name [session-label]: a claim made by hand, with a (zero) token hash so the Pod starts
  local labels=""
  [[ -z ${2:-} ]] || labels="labels: { \"pi-durable-k8s/session-id\": \"$2\" }"
  printf '%s\n' "$1" >>"$extra_claims_file"
  k apply -f - >/dev/null <<YAML
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: $1
  $labels
spec:
  warmPoolRef: { name: pi-env-pool }
  env:
    - { name: SANDBOXD_AUTH_TOKEN_SHA256, value: "0000000000000000000000000000000000000000000000000000000000000000" }
YAML
}
orch_pods() {
  k get pods -l app.kubernetes.io/instance=pi-orchestrator -o json |
    jq -r '.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null) | .metadata.name'
}
orch_ready() { # a Running orchestrator pod answers /readyz 200 (it owns the schema)
  local pod
  for pod in $(orch_pods); do
    k exec "$pod" -c orchestrator -- node -e 'fetch("http://127.0.0.1:8081/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))' && return 0
  done
  return 1
}
wait_orch() { wait_for "the orchestrator owns the schema" "${1:-240}" orch_ready; }
restart_count() { k get pod "$1" -o jsonpath='{.status.containerStatuses[0].restartCount}'; }
restarted_beyond() { [[ $(restart_count "$1") -gt $2 ]]; }
conv_set() { [[ -n $(conv_of "$1") ]]; }
row_submitted() { [[ $(pg -c "select status from inbox.events where id=$1") == submitted ]]; }
bridge_env_clean() { # at least one bridge (cli.js) runs, and none has the orchestrator's secrets (or the sandbox master) in /proc/<pid>/environ
  k exec "$(orch_pods | head -1)" -c orchestrator -- node -e '
    const fs=require("fs");let bridges=0,leaks=0,sandboxd=0;
    for(const pid of fs.readdirSync("/proc").filter(p=>/^\d+$/.test(p))){
      try{
        const cmd=fs.readFileSync(`/proc/${pid}/cmdline`,"utf8");
        if(!/sandbox-env\/dist\/cli\.js/.test(cmd))continue;
        bridges++;
        const env=fs.readFileSync(`/proc/${pid}/environ`,"utf8");
        if(/PI_DURABLE_DATABASE_URL=|PI_API_TOKENS=|PI_SANDBOX_MASTER_KEY=/.test(env))leaks++;
        if(/PI_SANDBOX_AUTH_TOKEN=/.test(env))sandboxd++;
      }catch{}
    }
    console.log(JSON.stringify({bridges,leaks,sandboxd}));
    process.exit(bridges>0&&leaks===0&&sandboxd===bridges?0:1)'
}
orch_probe() { # both orchestrator probes answer 200
  k exec "$(orch_pods | head -1)" -c orchestrator -- node -e 'Promise.all(["healthz","readyz"].map(p=>fetch("http://127.0.0.1:8081/"+p))).then(rs=>process.exit(rs.every(r=>r.ok)?0:1)).catch(()=>process.exit(2))'
}
event_state() { pg -c "select status || ':' || attempts from inbox.events where id=$1"; }
all_submitted() { [[ $(ev_count "$1" "status<>'submitted'") == 0 && $(ev_count "$1") -ge 1 ]]; }
session_status_is() { [[ $(jq -r '.body.status' <<<"$(api "$1" GET "/sessions/$2")") == "$3" ]]; }
not() { ! "$@"; }
no_orchestrator_pod() { [[ -z $(k get pods -l app.kubernetes.io/instance=pi-orchestrator -o name) ]]; }
logged_test_fault() { k logs "$1" -c orchestrator --previous | grep -q test-fault; }
claim_and_pvc_exist() { k get sandboxclaim "$1" && k get pvc "$2"; }
sandbox_file_exists() { k exec "$1" -c sandboxd -- test -e "$2"; }
file_has() { grep -q -- "$2" "$1"; } # file pattern

# ---------------------------------------------------------------- tests
t_create_send_stream() {
  local id out claim ids s e
  out=$(api alice POST /sessions)
  id=$(jq -r '.body.sessionId' <<<"$out")
  printf 'alice %s\n' "$id" >>"$sessions_file"
  assert_jq "POST /sessions answers 201 with a sessionId" "$out" '.status==201 and (.body.sessionId|test("^[0-9a-f-]{36}$"))'
  assert_jq "GET /sessions/{id} reports an active session with a last activity time" "$(api alice GET "/sessions/$id")" \
    '.status==200 and .body.status=="active" and (.body.lastActivityAt|length>0) and .body.events.pending==0'
  out=$(api alice POST /sessions '{"reasoning":"high"}')
  printf 'alice %s\n' "$(jq -r '.body.sessionId' <<<"$out")" >>"$sessions_file"
  assert_jq "POST /sessions with reasoning high echoes it" "$out" '.status==201 and .body.reasoning=="high"'
  assert_jq "GET /sessions/{id} reports the requested reasoning" "$(api alice GET "/sessions/$(jq -r '.body.sessionId' <<<"$out")")" '.status==200 and .body.model.reasoning=="high"'
  assert_jq "an unknown reasoning level is refused with 400" "$(api alice POST /sessions '{"reasoning":"ultra"}')" '.status==400 and (.body.error|test("reasoning"))'
  assert_jq "ingest /healthz answers 200" "$(api none GET /healthz)" '.status==200'
  assert_jq "ingest /readyz answers 200" "$(api none GET /readyz)" '.status==200'
  assert "orchestrator /healthz and /readyz answer 200" orch_probe

  out=$(post alice "$id" message "$(mkscript -f all-done 'echo HELLO-FROM-SANDBOX; sleep 6; echo $((6*7))')" "client-$id")
  assert_jq "POST events answers 202 with an eventId" "$out" '.status==202 and (.body.eventId|test("^[0-9]+$"))'
  s=$(transcript alice "$id" all-done 240)
  e=$(entries "$s")
  assert "stream reached the final answer" grep -q '^DONE' <<<"$s"
  assert_jq "transcript: user script, tool call, tool result, final answer" "$e" \
    '([.[].messages[].role]|unique|sort)==["assistant","toolResult","user"] and (.[-1].messages[0].text=="all-done")'
  assert_jq "tool results came from the sandbox" "$e" '(.[]|.messages[]|select(.role=="toolResult")|.text)|contains("HELLO-FROM-SANDBOX") and contains("42")'
  ids=$(entry_ids "$s")
  assert "entry ids (the SSE cursor) strictly increase" ids_increasing "$s"
  assert "the stream carried live state while the tool ran" grep -q '^LIVE {"running":true' <<<"$s"
  claim=$(claim_of "$id")
  assert "the SandboxClaim $claim exists after the first tool call" claim_exists "$claim"
  assert_eq "the claim is labelled with the session UUID" "$id" "$(k get sandboxclaim "$claim" -o json | jq -r '.metadata.labels["pi-durable-k8s/session-id"]')"
  assert "the bridge process has no database URL or API tokens in its environment" bridge_env_clean
  assert_eq "the inbox row is submitted" "submitted" "$(pg -c "select status from inbox.events where session_id='$id'")"
  assert_jq "GET /sessions/{id} counts the submitted event" "$(api alice GET "/sessions/$id")" '.body.events.submitted==1 and .body.events.pending==0'
  note "EVIDENCE create-send-stream: session=$id claim=$claim entries=$(jq length <<<"$e") ids=$(tr '\n' ',' <<<"$ids")"
}

t_sandbox_is_lazy() { # part of test 1's claim (brief 6): no claim until the first tool call
  local id out claim
  id=$(new_session alice)
  post alice "$id" message "just chat, no tools" >/dev/null
  transcript alice "$id" "echo: just chat" 120 >/dev/null
  claim=pi-conv-$(conv_of "$id")
  assert "a session that never ran a tool has no SandboxClaim ($claim)" claim_gone "$claim"
  assert "and no PVC" pvc_gone "$claim"
  out=$(post alice "$id" message "$(mkscript -f tool-ran 'echo now-a-tool')")
  transcript alice "$id" tool-ran 240 >/dev/null
  assert "the first tool call created the SandboxClaim" claim_exists "$claim"
  note "EVIDENCE lazy-sandbox: no claim after a chat-only turn; claim $claim created by the first tool call"
}

t_dedup() {
  local id r1 r2 e s
  id=$(new_session alice)
  r1=$(post alice "$id" message "dedupe-me" "same-id-$id")
  r2=$(post alice "$id" message "dedupe-me" "same-id-$id")
  assert_jq "first post: 202, not a duplicate" "$r1" '.status==202 and .body.duplicate==false'
  assert_jq "second post: 202, flagged duplicate, same eventId" "$r2" ".status==202 and .body.duplicate==true and .body.eventId==$(jq '.body.eventId' <<<"$r1")"
  assert_eq "exactly one inbox row" 1 "$(ev_count "$id")"
  s=$(transcript alice "$id" "echo: dedupe-me" 120)
  sleep 5
  s=$(transcript alice "$id" "echo: dedupe-me" 120)
  e=$(entries "$s")
  assert_jq "exactly one submission: one user message and one answer" "$e" \
    '([.[].messages[]|select(.role=="user")]|length)==1 and ([.[].messages[]|select(.role=="assistant")]|length)==1'
  assert_jq "the same sourceEventId on another session is refused (409)" \
    "$(post alice "$(new_session alice)" message "x" "same-id-$id")" '.status==409'
  note "EVIDENCE dedup: two POSTs -> eventId $(jq -r '.body.eventId' <<<"$r1") twice, inbox rows=1, user messages=1, answers=1"
}

t_orchestrator_down() {
  local id r s e o1 o2 o3
  id=$(new_session alice)
  note "scaling the orchestrator to 0"
  k scale deployment pi-orchestrator --replicas=0 >/dev/null
  k wait --for=delete pod -l app.kubernetes.io/instance=pi-orchestrator --timeout=180s >/dev/null 2>&1 || true
  assert "no orchestrator pod is running" no_orchestrator_pod
  assert_jq "ingest is still ready" "$(api none GET /readyz)" '.status==200'
  o1=$(post alice "$id" message "down-1")
  o2=$(post alice "$id" message "down-2")
  o3=$(post alice "$id" message "down-3")
  assert_jq "all three events are accepted with 202 while the orchestrator is down" "[$o1,$o2,$o3]" 'all(.[]; .status==202)'
  assert_eq "all three rows are pending in the inbox" 3 "$(ev_count "$id" "status='pending'")"
  assert_jq "GET /sessions/{id} still answers from the inbox" "$(api alice GET "/sessions/$id")" '.status==200 and .body.events.pending==3'
  assert_jq "the stream answers 503 (retryable), not a hang" "$(api alice GET "/sessions/$id/stream")" '.status==503'
  sleep 5
  assert_eq "nothing was processed while it was down" 3 "$(ev_count "$id" "status='pending'")"
  note "scaling the orchestrator back to 1"
  k scale deployment pi-orchestrator --replicas=1 >/dev/null
  wait_orch
  s=$(transcript alice "$id" "echo: down-3" 240)
  e=$(entries "$s")
  assert_jq "processed in order: users down-1, down-2, down-3" "$(users "$e")" '.==["down-1","down-2","down-3"]'
  assert_jq "answers in order" "$(answers "$e")" '.==["echo: down-1","echo: down-2","echo: down-3"]'
  wait_for "all rows submitted" 60 all_submitted "$id"
  note "EVIDENCE orchestrator-down: 3 x 202 while down; after restart users=$(users "$e") answers=$(answers "$e")"
}

t_crash_before_mark() {
  local id claim pod rc0 payload eid s e
  pod=$(orch_pods | head -1)
  rc0=$(restart_count "$pod")
  id=$(new_session alice)
  # An inbox row only SQL can write: it asks the orchestrator to exit right after the Pi Durable submit, before
  # it marks the row submitted. The side effect (a line in a file) shows how often the turn really ran.
  payload=$(jq -nc --arg t "$(mkscript -f fault-final 'echo run >> /workspace/fault-runs.log; echo FAULT-RAN')" \
    '{text:$t, testFault:"exit-after-submit"}')
  eid=$(pg -c "insert into inbox.events (session_id, source, source_event_id, kind, payload) values ('$id','sql:e2e','fault-$id','message','${payload//\'/\'\'}'::jsonb) returning id" | head -1)
  note "inserted event $eid with testFault=exit-after-submit"
  wait_for "the orchestrator container exited between submit and mark" 180 restarted_beyond "$pod" "$rc0"
  wait_orch
  assert "it logged the fault before exiting" logged_test_fault "$pod"
  wait_orch
  s=$(transcript alice "$id" fault-final 300)
  e=$(entries "$s")
  assert "the turn completed once the orchestrator was back" grep -q '^DONE' <<<"$s"
  wait_for "the row is submitted" 60 row_submitted "$eid"
  assert_eq "the row was submitted on the first committed attempt (the crashed claim rolled back)" "submitted:1" "$(event_state "$eid")"
  assert_jq "no duplicate turn: one user message, one tool result, one answer" "$e" \
    '([.[].messages[]|select(.role=="user")]|length)==1 and ([.[].messages[]|select(.role=="toolResult")]|length)==1 and ([.[].messages[]|select(.role=="assistant" and (.calls|not))]|length)==1'
  claim=$(claim_of "$id")
  assert_eq "the command ran exactly once in the sandbox" 1 "$(file_lines "$claim" /workspace/fault-runs.log)"
  sleep 10
  assert_eq "still once 10 s later (nothing re-ran)" 1 "$(file_lines "$claim" /workspace/fault-runs.log)"
  note "EVIDENCE crash-before-mark: orchestrator $pod restarted (count $rc0 -> $(restart_count "$pod")); row $eid = $(event_state "$eid"); runs.log lines=1; results=$(results "$e")"
}

t_busy_order() {
  local id claim s e
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f first-answer 'echo BUSY-START; sleep 15; echo BUSY-END')" >/dev/null
  wait_for "the session has a conversation" 120 conv_set "$id"
  claim=$(claim_of "$id")
  wait_for "sleep 15 is running in $claim (the session is busy)" 300 sandbox_has "$claim" 'sleep 15'
  post alice "$id" message "queued-1" >/dev/null
  post alice "$id" message "queued-2" >/dev/null
  post alice "$id" message "queued-3" >/dev/null
  assert "the busy turn is still running after the three posts" sandbox_has "$claim" 'sleep 15'
  s=$(transcript alice "$id" "echo: queued-3" 300)
  e=$(entries "$s")
  assert_jq "user messages arrive in post order behind the running turn" "$(users "$e")" '(.[1:])==["queued-1","queued-2","queued-3"]'
  assert_jq "answers in order: the busy turn first, then the three" "$(answers "$e")" '.==["first-answer","echo: queued-1","echo: queued-2","echo: queued-3"]'
  assert_jq "the first tool result completed before any queued message was answered" "$(results "$e")" '(.[0]|contains("BUSY-END"))'
  assert "entry ids strictly increase" ids_increasing "$s"
  note "EVIDENCE busy-order: users=$(users "$e") answers=$(answers "$e")"
}

t_steer() {
  local id claim s e
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f original-final 'echo ORIGINAL-1; sleep 15' 'echo ORIGINAL-STEP2')" >/dev/null
  wait_for "the session has a conversation" 120 conv_set "$id"
  claim=$(claim_of "$id")
  wait_for "sleep 15 is running in $claim" 300 sandbox_has "$claim" 'sleep 15'
  post alice "$id" steer "$(mkscript -f steered-final 'echo STEERED-OK')" >/dev/null
  s=$(transcript alice "$id" steered-final 300)
  e=$(entries "$s")
  assert_jq "the steer's step ran" "$(results "$e")" 'any(.[]; contains("STEERED-OK"))'
  assert_jq "the original second step never ran" "$(results "$e")" 'all(.[]; contains("ORIGINAL-STEP2")|not)'
  assert_jq "the run ended with the steered answer, not the original one" "$(answers "$e")" '.==["steered-final"]'
  assert_jq "two tool calls in all: the interrupted-by-steer round and the steered one" "$(results "$e")" 'length==2'
  note "EVIDENCE steer: results=$(results "$e") answers=$(answers "$e")"
}

t_reconnect() {
  local id s1 s2 full a b all pod out last n
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f recon-final 'echo S1; sleep 5' 'echo S2; sleep 5' 'echo S3')" >/dev/null
  # (a) client drop: take 3 entries, hang up, come back with Last-Event-ID.
  s1=$(client stream alice "$id" --max-entries 3 --timeout 240)
  last=$(sed -n 's/^DROP last=//p' <<<"$s1")
  assert "client A received 3 entries and dropped (last id $last)" test -n "$last"
  # Wait for the turn to finish while this client is away, then resume from the cursor.
  full=$(transcript alice "$id" recon-final 240)
  s2=$(client stream alice "$id" --last-id "$last" --until-text recon-final --timeout 120 || true)
  a=$(entry_ids "$s1")
  b=$(entry_ids "$s2")
  all=$(printf '%s\n%s\n' "$a" "$b" | sed '/^$/d')
  assert "reconnect with Last-Event-ID resumed after the cursor: first id $(head -1 <<<"$b") > $last" test "$(head -1 <<<"$b")" -gt "$last"
  assert_eq "A + B is exactly the full transcript: no gap, no duplicate" "$(entry_ids "$full" | xargs)" "$(printf "%s" "$all" | xargs)"
  assert "the resumed stream says what the connection used" grep -q "^CONNECT 1 last=$last status=200" <<<"$s2"
  note "EVIDENCE reconnect-client-drop: A ids=[$(tr '\n' ' ' <<<"$a")] B ids=[$(tr '\n' ' ' <<<"$b")] full=[$(entry_ids "$full" | tr '\n' ' ')]"

  # (b) orchestrator restart under a live stream; the client reconnects by itself.
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f reconnected-final 'echo R1; sleep 25' 'echo R2-OK')" >/dev/null
  client stream alice "$id" --reconnect --until-text reconnected-final --timeout 420 >"$work/reconnect.out" 2>&1 &
  bg_pids+=($!)
  wait_for "the stream delivered the first entries" 180 file_has "$work/reconnect.out" '^ENTRY'
  wait_for "the tool call is running" 180 sandbox_has "$(claim_of "$id")" 'sleep 25'
  pod=$(orch_pods | head -1)
  note "killing orchestrator pod $pod (force, grace 0) under the open stream"
  k delete pod "$pod" --grace-period=0 --force >/dev/null 2>&1
  wait_for "the client finished after the restart" 420 file_has "$work/reconnect.out" '^DONE'
  out=$(cat "$work/reconnect.out")
  n=$(grep -c '^CONNECT' <<<"$out" || true)
  assert "the client had to reconnect ($n connections)" test "$n" -ge 2
  assert "the connection ended when the orchestrator died" grep -q '^END ' <<<"$out"
  assert "ids strictly increase across connections: nothing replayed" ids_increasing "$out"
  assert_eq "the resumed stream equals a fresh replay" "$(entry_ids "$(transcript alice "$id" reconnected-final 120)" | xargs)" "$(entry_ids "$out" | xargs)"
  e=$(entries "$out")
  assert_jq "the interrupted tool reads as interrupted, then the script continued" "$(results "$e")" '(.[0]|test("interrupt";"i")) and (.[1]|contains("R2-OK"))'
  note "EVIDENCE reconnect-orchestrator-restart: connections=$n; $(grep -E '^(CONNECT|END)' <<<"$out" | tr '\n' ';')"
}

t_auth() {
  local id out
  id=$(new_session alice)
  assert_jq "no token: 401" "$(api none POST /sessions)" '.status==401'
  assert_jq "wrong token: 401" "$(api bad POST /sessions)" '.status==401'
  assert_jq "wrong token on an existing session: 401" "$(api bad GET "/sessions/$id")" '.status==401'
  assert_jq "wrong token on events: 401" "$(post bad "$id" message hi)" '.status==401'
  assert_jq "the owner can read the session" "$(api alice GET "/sessions/$id")" '.status==200'
  assert_jq "another owner cannot read it (404, existence not revealed)" "$(api bob GET "/sessions/$id")" '.status==404'
  assert_jq "another owner cannot post events" "$(post bob "$id" message hi)" '.status==404'
  assert_jq "another owner cannot open the stream through ingest" "$(api bob GET "/sessions/$id/stream")" '.status==404'
  assert_jq "another owner cannot delete" "$(api bob DELETE "/sessions/$id")" '.status==404'
  assert_jq "the orchestrator's own stream endpoint also refuses a bad token" "$(api bad GET "/sessions/$id/stream" --base http://pi-orchestrator:8081)" '.status==401'
  assert_jq "and another owner (owner check on the orchestrator)" "$(api bob GET "/sessions/$id/stream" --base http://pi-orchestrator:8081)" '.status==404'
  assert_jq "an unknown session id is 404 for everyone" "$(api alice GET /sessions/00000000-0000-4000-8000-000000000000)" '.status==404'
  assert_eq "the rejected calls left no events behind" 0 "$(ev_count "$id")"
  assert_jq "the owner's session is untouched and active" "$(api alice GET "/sessions/$id")" '.body.status=="active"'
  out=$(post alice "$id" message "owner-ok")
  assert_jq "the owner can still post" "$out" '.status==202'
  note "EVIDENCE auth: none/bad token=401; bob on alice's session: GET/POST/stream/DELETE=404 (ingest and orchestrator)"
}

t_delete() {
  local id claim pvc out
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f del-ready 'echo keep > /workspace/keep.txt; echo HI')" >/dev/null
  transcript alice "$id" del-ready 240 >/dev/null
  claim=$(claim_of "$id")
  pvc=workspace-$claim
  assert "the claim $claim and the PVC $pvc exist before the delete" claim_and_pvc_exist "$claim" "$pvc"
  assert "the sandbox pod exists" pod_exists "$claim"
  out=$(api alice DELETE "/sessions/$id")
  assert_jq "DELETE answers 202" "$out" '.status==202'
  assert_jq "events are refused as soon as a delete is requested" "$(post alice "$id" message late)" '.status==409 or .status==410'
  wait_for "the SandboxClaim is gone" 240 claim_gone "$claim"
  wait_for "the PVC is gone" 240 pvc_gone "$claim"
  wait_for "the sandbox pod is gone" 240 pod_gone "$claim"
  wait_for "the session is marked deleted" 60 session_status_is alice "$id" deleted
  assert_jq "a second DELETE is accepted (idempotent)" "$(api alice DELETE "/sessions/$id")" '.status==202'
  assert_jq "events to a deleted session: 410" "$(post alice "$id" message after)" '.status==410'
  assert_jq "the stream of a deleted session: 410" "$(api alice GET "/sessions/$id/stream")" '.status==410'
  assert_eq "no claim was left for this session" 0 "$(k get sandboxclaim -o name | grep -c "/$claim\$" || true)"
  note "EVIDENCE delete: claim $claim, pvc $pvc and the sandbox pod removed; session status=deleted; conversation state kept for a maintenance job (docs/session-api.md)"
}

t_concurrency() {
  local a b ca cb sa sb ea eb as ae bs be
  a=$(new_session alice)
  b=$(new_session bob)
  post alice "$a" message "$(mkscript -f done-a 'echo A-START $(date +%s); echo A-SECRET > /workspace/file-a.txt; sleep 30; echo A-END $(date +%s); ls /workspace')" >/dev/null &
  post bob "$b" message "$(mkscript -f done-b 'echo B-START $(date +%s); echo B-SECRET > /workspace/file-b.txt; sleep 30; echo B-END $(date +%s); ls /workspace')" >/dev/null &
  wait
  transcript alice "$a" done-a 420 >"$work/a.out" &
  bg_pids+=($!)
  transcript bob "$b" done-b 420 >"$work/b.out" &
  bg_pids+=($!)
  wait_for "session A done" 420 file_has "$work/a.out" '^DONE'
  wait_for "session B done" 420 file_has "$work/b.out" '^DONE'
  ca=$(claim_of "$a")
  cb=$(claim_of "$b")
  sa=$(cat "$work/a.out")
  sb=$(cat "$work/b.out")
  ea=$(entries "$sa")
  eb=$(entries "$sb")
  assert "two distinct claims ($ca, $cb)" test "$ca" != "$cb"
  assert "separate sandbox pods" test "$(sandbox_uid "$ca")" != "$(sandbox_uid "$cb")"
  assert "separate PVCs" test "$(k get pvc "workspace-$ca" -o jsonpath='{.metadata.uid}')" != "$(k get pvc "workspace-$cb" -o jsonpath='{.metadata.uid}')"
  assert_jq "A's transcript has A's markers and nothing of B's" "$ea" '(tostring as $t | ($t|contains("A-START")) and ($t|contains("file-a.txt")) and (($t|contains("B-"))|not) and (($t|contains("file-b.txt"))|not))'
  assert_jq "B's transcript has B's markers and nothing of A's" "$eb" '(tostring as $t | ($t|contains("B-START")) and ($t|contains("file-b.txt")) and (($t|contains("A-"))|not) and (($t|contains("file-a.txt"))|not))'
  assert_jq "A's answer is A's and B's is B's" "[$(answers "$ea"),$(answers "$eb")]" '.==[["done-a"],["done-b"]]'
  assert "file-a.txt is not in B's sandbox" not sandbox_file_exists "$cb" /workspace/file-a.txt
  assert "file-b.txt is not in A's sandbox" not sandbox_file_exists "$ca" /workspace/file-b.txt
  as=$(jq -r '[.[].messages[]|select(.role=="toolResult")|.text][0]' <<<"$ea" | sed -n 's/^A-START //p')
  ae=$(jq -r '[.[].messages[]|select(.role=="toolResult")|.text][0]' <<<"$ea" | sed -n 's/^A-END //p')
  bs=$(jq -r '[.[].messages[]|select(.role=="toolResult")|.text][0]' <<<"$eb" | sed -n 's/^B-START //p')
  be=$(jq -r '[.[].messages[]|select(.role=="toolResult")|.text][0]' <<<"$eb" | sed -n 's/^B-END //p')
  assert "the two commands overlapped in time (A $as-$ae, B $bs-$be)" test "$as" -lt "$be" -a "$bs" -lt "$ae"
  note "EVIDENCE concurrency: A=$ca B=$cb overlap A $as-$ae B $bs-$be; A answers=$(answers "$ea") B answers=$(answers "$eb")"
}

# A command that leaves a `setsid` child behind and then waits: pi-env kills the command's process group, which the
# child escaped. $1 = file name for the marker, $2 = marker text.
escapee_command() { printf "echo %s > /workspace/%s; (setsid sh -c 'sleep 601' >/dev/null 2>&1 </dev/null &); sleep 300" "$2" "$1"; }

t_recycle_on_interrupt() {
  local id claim uid pvc out e
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f never-reached "$(escapee_command keep-b.txt before-cancel)")" >/dev/null
  wait_for "the session has a conversation" 120 conv_set "$id"
  claim=$(claim_of "$id")
  wait_for "the escapee (setsid sleep 601) runs in $claim" 300 sandbox_has "$claim" 'sleep 601'
  wait_for "the long command (sleep 300) runs" 60 sandbox_has "$claim" 'sleep 300'
  uid=$(sandbox_uid "$claim")
  pvc=$(pvc_uid "$claim")
  post alice "$id" cancel >/dev/null
  wait_for "the sandbox Pod was replaced by a Ready one (old uid $uid)" 300 pod_replaced_ready "$claim" "$uid"
  assert "the escapee is gone from the new Pod" not sandbox_has "$claim" 'sleep 601'
  assert "the long command is gone too" not sandbox_has "$claim" 'sleep 300'
  assert_eq "the workspace file written before the interrupt is still there" "before-cancel" "$(k exec "$claim" -c sandboxd -- cat /workspace/keep-b.txt)"
  assert_eq "same PVC (uid unchanged)" "$pvc" "$(pvc_uid "$claim")"
  assert "the claim was not deleted" claim_exists "$claim"
  assert_eq "the in-flight record is cleared once the Pod is clean" "" "$(pg -c "select coalesce(exec_in_flight_at::text,'') from inbox.sessions where id='$id'")"
  out=$(post alice "$id" message "$(mkscript -f after-recycle-final 'cat /workspace/keep-b.txt; echo BRIDGE-BACK')")
  assert_jq "a further message is accepted" "$out" '.status==202'
  e=$(entries "$(transcript alice "$id" after-recycle-final 300)")
  assert_jq "the next tool call works on the new Pod and sees the old file" "$(results "$e")" 'any(.[]; contains("before-cancel") and contains("BRIDGE-BACK"))'
  note "EVIDENCE recycle-on-interrupt: cancel -> Pod $uid replaced; escapee gone; keep-b.txt=before-cancel; pvc uid unchanged; $(orch_log_lines '"sandbox-recycled"' | tail -1)"
}

t_recycle_on_restart() {
  local id claim uid pvc pod e
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f restart-final "$(escapee_command keep-r.txt before-restart)" 'cat /workspace/keep-r.txt; echo CLEAN-POD')" >/dev/null
  wait_for "the session has a conversation" 120 conv_set "$id"
  claim=$(claim_of "$id")
  wait_for "the escapee runs in $claim" 300 sandbox_has "$claim" 'sleep 601'
  wait_for "the long command runs" 60 sandbox_has "$claim" 'sleep 300'
  assert_eq "a command is recorded as in flight" "1" "$(pg -c "select count(*) from inbox.sessions where id='$id' and exec_in_flight_at is not null")"
  uid=$(sandbox_uid "$claim")
  pvc=$(pvc_uid "$claim")
  pod=$(orch_pods | head -1)
  note "killing orchestrator pod $pod (force, grace 0) mid-command"
  k delete pod "$pod" --grace-period=0 --force >/dev/null 2>&1
  wait_orch
  wait_for "the sandbox Pod was replaced by a Ready one (old uid $uid)" 300 pod_replaced_ready "$claim" "$uid"
  assert "the escapee is gone" not sandbox_has "$claim" 'sleep 601'
  e=$(entries "$(transcript alice "$id" restart-final 300)")
  assert_jq "the interrupted command reads as interrupted; the run continued on the clean Pod and saw the workspace file" "$(results "$e")" \
    '(.[0]|test("interrupt";"i")) and (.[1]|contains("before-restart") and contains("CLEAN-POD"))'
  assert_eq "the workspace file survived" "before-restart" "$(k exec "$claim" -c sandboxd -- cat /workspace/keep-r.txt)"
  assert_eq "same PVC" "$pvc" "$(pvc_uid "$claim")"
  assert "the new orchestrator logged the recycle at start" orch_log_has '"recycle-at-start"'
  note "EVIDENCE recycle-on-restart: orchestrator killed mid-command; Pod $uid replaced at start; escapee gone; results=$(results "$e")"
}

t_idle_suspend() {
  local id claim uid pvc e
  id=$(new_session alice)
  post alice "$id" message "$(mkscript -f idle-ready 'echo persisted-idle > /workspace/idle.txt; echo WROTE')" >/dev/null
  transcript alice "$id" idle-ready 240 >/dev/null
  claim=$(claim_of "$id")
  assert_eq "the sandbox is Running after the tool call" Running "$(sandbox_mode "$claim")"
  uid=$(sandbox_uid "$claim")
  pvc=$(pvc_uid "$claim")
  note "waiting for the idle suspension (the test overlay suspends after 120 s idle)"
  wait_for "the Sandbox is Suspended" 420 mode_is "$claim" Suspended
  wait_for "its Pod is gone" 120 pod_gone "$claim"
  assert_eq "the PVC is kept, same uid" "$pvc" "$(pvc_uid "$claim")"
  assert "the SandboxClaim is kept" claim_exists "$claim"
  assert_eq "the session is still active" active "$(jq -r '.body.status' <<<"$(api alice GET "/sessions/$id")")"
  post alice "$id" message "$(mkscript -f resumed-final 'cat /workspace/idle.txt; echo BACK-FROM-SUSPEND')" >/dev/null
  e=$(entries "$(transcript alice "$id" resumed-final 300)")
  assert_jq "the next message resumed the sandbox and read the old workspace file" "$(results "$e")" 'any(.[]; contains("persisted-idle") and contains("BACK-FROM-SUSPEND"))'
  assert_eq "the Sandbox is Running again" Running "$(sandbox_mode "$claim")"
  assert "it runs in a new Pod" test "$(sandbox_uid "$claim")" != "$uid"
  assert_eq "same PVC after the resume" "$pvc" "$(pvc_uid "$claim")"
  note "EVIDENCE idle-suspend: Running -> Suspended (Pod $uid gone, PVC $pvc kept) -> resumed by the next message; idle.txt=persisted-idle; $(orch_log_lines '"sandbox-suspended"' | tail -1)"
}

t_orphan_sweep() {
  local live live_claim gone unknown_label t0 c
  unknown_label=$(cat /proc/sys/kernel/random/uuid)
  live=$(new_session alice)
  post alice "$live" message "$(mkscript -f live-ready 'echo live > /workspace/live.txt')" >/dev/null
  transcript alice "$live" live-ready 240 >/dev/null
  live_claim=$(claim_of "$live")
  gone=$(new_session alice)
  api alice DELETE "/sessions/$gone" >/dev/null
  wait_for "a deleted session exists to orphan a claim on" 120 session_status_is alice "$gone" deleted
  t0=$(now)
  mkclaim pi-conv-990001 "$unknown_label"
  mkclaim pi-conv-990003 "$gone"
  mkclaim pi-conv-990002
  mkclaim e2e-sweep-keep
  mkclaim pi-conv-990004 control-990004
  assert "a fresh orphan is still there right after creation (grace age 45 s)" claim_exists pi-conv-990001
  wait_for "the Sandbox of the first orphan made its PVC" 240 pvc_exists pi-conv-990001
  wait_for "the Sandbox of the second orphan made its PVC" 240 pvc_exists pi-conv-990003
  wait_for "the claim of the UNKNOWN session is swept" 300 claim_gone pi-conv-990001
  wait_for "its PVC is swept with it" 240 pvc_gone pi-conv-990001
  wait_for "the claim of the DELETED session is swept" 300 claim_gone pi-conv-990003
  wait_for "its PVC is swept with it" 240 pvc_gone pi-conv-990003
  wait_for "the swept Pods are gone" 240 pod_gone pi-conv-990001
  note "the sweep ran $(($(now) - t0)) s after the claims were made; letting two more sweeps pass over what must stay"
  sleep 40
  assert "the unlabelled pi-conv-990002 stays" claim_exists pi-conv-990002
  assert "the unlabelled e2e-sweep-keep stays" claim_exists e2e-sweep-keep
  assert "a control-session label stays" claim_exists pi-conv-990004
  assert "the claim of the live session $live stays" claim_exists "$live_claim"
  assert "and its PVC" pvc_exists "$live_claim"
  assert "the sweep logged removing the unknown-session claim" orch_log_has '"sweep-action".*"claim":"pi-conv-990001".*session-unknown'
  assert "the sweep logged removing the deleted-session claim" orch_log_has '"sweep-action".*"claim":"pi-conv-990003".*session-deleted'
  assert "the sweep never named a kept claim" not orch_log_has "\"sweep-action\".*\\(pi-conv-990002\\|pi-conv-990004\\|e2e-sweep-keep\\|$live_claim\\)"
  for c in pi-conv-990002 e2e-sweep-keep pi-conv-990004; do k delete sandboxclaim "$c" --ignore-not-found --wait=false >/dev/null; done
  note "EVIDENCE orphan-sweep: removed pi-conv-990001 (unknown session) and pi-conv-990003 (deleted session) with their PVCs; kept 2 unlabelled claims, a control-labelled claim and live claim $live_claim; $(orch_log_lines '"sweep-action"' | tail -2 | tr '\n' ' ')"
}

# ---------------------------------------------------------------- setup
if [[ ${SKIP_SETUP:-0} != 1 ]]; then
log "setup: wait for CNPG, the orchestrator and ingest (overlay and code were pushed by run.sh)"
[[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}' 2>/dev/null) ]] || {
  echo "secret sandboxd-auth has no master key: run deploy/gen-secret.sh" >&2
  exit 1
}
"$root/deploy/gen-api-secret.sh" >/dev/null
k wait --for=condition=Ready cluster.postgresql.cnpg.io/pi-pg --timeout=300s >/dev/null
k rollout status deployment/pi-orchestrator --timeout=240s >/dev/null
k rollout status deployment/pi-ingest --timeout=240s >/dev/null
fi
wait_orch

# The suite runs on the scripted default model (no OneCLI, no spend). The settings live in Postgres, so this is a call
# to the admin API (alice is in PI_API_ADMINS); no restart. The previous values come back in cleanup.
log "setup: scripted default model through PUT /admin/settings"
before=$(api alice GET /admin/settings)
assert_jq "alice can read the settings (is PI_API_ADMINS set on ingest?)" "$before" '.status==200'
jq -c '.body | {defaultModel, allowlist, reasoning, turnBudget}' <<<"$before" >"$settings_before"
assert_jq "the scripted default is set" "$(api alice PUT /admin/settings '{"defaultModel":"scripted/scripted-1","reasoning":null}')" '.status==200 and .body.defaultModel=="scripted/scripted-1"'

# ---------------------------------------------------------------- run
# ONLY="dedup,steer" runs just those tests (debugging aid); the full suite runs when unset.
# Parallel tests (see tests/e2e/fns.sh): own sessions and claims, no orchestrator kill or scale, no shared settings,
# and no counter or fixed name that another test also touches. Everything else is serial and runs after them.
e2e_settle_orch() { wait_orch >/dev/null 2>&1 || true; }
E2E_AFTER=e2e_settle_orch

e2e_parallel create-send-stream:t_create_send_stream sandbox-is-lazy:t_sandbox_is_lazy dedup:t_dedup \
  busy-order:t_busy_order steer:t_steer auth:t_auth delete:t_delete concurrency:t_concurrency
# The lifecycle tests are a second group: every open env is a bridge process in the orchestrator (1 Gi limit; it was
# OOM-killed when these ran beside the first group), and they take minutes each (idle waits, a 300 s command).
# orphan-sweep stays here although the sweep is cluster-wide: it only acts on claims it created itself (fixed names
# pi-conv-99000x, e2e-sweep-keep) and on sessions that no test of this group owns.
e2e_parallel recycle-on-interrupt:t_recycle_on_interrupt idle-suspend:t_idle_suspend orphan-sweep:t_orphan_sweep
# These kill, scale or race the orchestrator, so nothing else may run beside them.
e2e_serial orchestrator-down t_orchestrator_down
e2e_serial crash-before-mark t_crash_before_mark
e2e_serial reconnect t_reconnect
e2e_serial recycle-on-restart t_recycle_on_restart

log "RESULT"
printf '%s\n' "${summary[@]}"
grep -h -E 'EVIDENCE' "$work"/*.log | sed 's/^ */  /' || true
if [[ $failed -ne 0 ]]; then
  echo "PHASE 4: FAILED" >&2
  exit 1
fi
echo "PHASE 4: all tests passed"
