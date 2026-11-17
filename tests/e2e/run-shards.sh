#!/usr/bin/env bash
# Runs IN the cluster, as the e2e-driver Job started by tests/e2e/run.sh shards (ServiceAccount kubeconfig, no context).
# run.sh has already built the stack with TWO orchestrator shards on the Mac side: the base Deployment pi-orchestrator
# (shard 0, schema durable) and pi-orchestrator-1 (shard 1, schema durable_s1) from deploy/add-shard.sh, ingest with
# PI_ORCH_SHARDS=2 and PI_ORCH_URL=http://pi-orchestrator-{shard}:8081, and the images deployed. This script only waits for
# them and runs the tests (docs/decisions/0017-schema-sharding.md). Scripted fake model, no LLM.
#
#   placement          two new sessions land on shards 0 and 1 (fewest active sessions); each runs a sandbox tool call.
#                      Claims pi-conv-<n> and pi-s1-conv-<n> carry the SAME conversation id n (each schema mints from 2):
#                      the collision that made (shard, conversation_id) the identity. Different labels, workspaces, schemas.
#   routing            streams through ingest return each session's own transcript; a stream sent straight to the wrong
#                      shard gets 421 and creates no conversation (conversation_id stays null, no row in that schema)
#   shard-down         shard 1 at 0 replicas: shard 0 keeps serving, the shard-1 event stays pending and its stream is
#                      503 with Retry-After; shard 1 back: the event completes with no new input
#   kill-shard0        shard 0 killed while shard 1 runs a command: shard 1's sandbox Pod and command are untouched
#   kill-shard1        shard 1 killed while both shards run a command: only shard 1's sandbox is recycled
#   long-command       a shard-1 command longer than the idle-suspend time survives the scans of shard 0; deleting the
#                      shard-1 session removes only its own claim and PVC
#
# Touches only namespace $NAMESPACE (the run namespace pi-e2e-<id>). Exit code: 0 when every test passed, 1 otherwise.
set -euo pipefail

ctx=${KUBE_CONTEXT:-} # empty in the Job: kubectl then uses the in-cluster ServiceAccount config
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd) # the driver image mirrors the repo layout: tests/e2e and hack/gen-api-secret.sh
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"
settings_before=$work/settings-before.json # the model settings found at start, restored on exit
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }
# shellcheck source=fns.sh
. "$here/fns.sh"

pg() { e2e_db "$@"; }

# ---------------------------------------------------------------- shard names (docs/decisions/0017)
deploy_of() { if [[ $1 -eq 0 ]]; then echo pi-orchestrator; else echo "pi-orchestrator-$1"; fi; }
schema_of() { if [[ $1 -eq 0 ]]; then echo durable; else echo "durable_s$1"; fi; }
claim_name() { if [[ $1 -eq 0 ]]; then echo "pi-conv-$2"; else echo "pi-s$1-conv-$2"; fi; } # shard conversation

undeleted_sessions() { # prints the ids of recorded sessions whose status is not `deleted` yet
  local list
  list=$(awk 'NF==2 {printf "%s'"'"'%s'"'"'", sep, $2; sep=","}' "$sessions_file")
  [[ -n $list ]] || return 0
  pg -c "select id from inbox.sessions where status <> 'deleted' and id in ($list)"
}
cleanup() {
  local owner id shard conv deadline pending
  k scale deployment pi-orchestrator pi-orchestrator-1 --replicas=1 >/dev/null 2>&1 || true
  deadline=$(($(now) + 180))
  until { orch_ready 0 && orch_ready 1; } 2>/dev/null || [[ $(now) -ge $deadline ]]; do sleep 2; done
  while read -r owner id; do
    [[ -n "$id" ]] || continue
    api "$owner" DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  deadline=$(($(now) + 240))
  while [[ $(now) -lt $deadline ]]; do
    if pending=$(undeleted_sessions 2>/dev/null) && [[ -z $pending ]]; then break; fi
    sleep 3
  done
  while read -r owner id; do
    [[ -n "$id" ]] || continue
    if ! pending=$(undeleted_sessions 2>/dev/null) || grep -qx "$id" <<<"$pending"; then
      read -r shard conv < <(pg -F ' ' -c "select shard, coalesce(conversation_id::text, '') from inbox.sessions where id='$id'" 2>/dev/null | tr '|' ' ') || true
      if [[ -n ${conv:-} ]]; then
        k delete sandboxclaim "$(claim_name "$shard" "$conv")" --ignore-not-found --wait=false >/dev/null 2>&1 || true
        k delete pvc "workspace-$(claim_name "$shard" "$conv")" --ignore-not-found --wait=false >/dev/null 2>&1 || true
      fi
      note "session $id was not deleted through the API; its rows are kept"
      continue
    fi
    pg -c "delete from inbox.events where session_id='$id'; delete from inbox.sessions where id='$id'" >/dev/null 2>&1 || true
  done <"$sessions_file"
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
not() { ! "$@"; }

# ---------------------------------------------------------------- API client (runs inside an ingest pod)
ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
client() { k exec -i "$(ingest_pod)" -c ingest -- node - "$@" <"$here/client.mjs"; }
api() { client call "$@"; } # owner method path [body] [--base URL] -> {"status":N,"body":...}

new_session() { # owner -> prints the session id (placed by ingest)
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
# A new session on a given shard. Placement itself is tested in `placement`; the other tests pin the session (before any
# event, while it has no conversation) so they do not depend on what earlier tests left active.
new_session_on() { # shard -> prints the session id
  local id
  id=$(new_session alice)
  [[ $(shard_of "$id") -eq $1 ]] || pg -c "update inbox.sessions set shard=$1 where id='$id' and conversation_id is null" >/dev/null
  [[ $(shard_of "$id") -eq $1 ]] || { note "could not place session $id on shard $1"; return 1; }
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
transcript() { client stream "$1" "$2" --until-text "$3" --timeout "${4:-300}" --reconnect || true; }
entries() { sed -n 's/^ENTRY [0-9]* //p' <<<"$1" | jq -s .; }
results() { jq -c '[.[] | .messages[] | select(.role=="toolResult") | .text]' <<<"$1"; }
users() { jq -c '[.[] | .messages[] | select(.role=="user") | .text]' <<<"$1"; }

# ---------------------------------------------------------------- cluster state
shard_of() { pg -c "select shard from inbox.sessions where id='$1'"; }
conv_of() { pg -c "select coalesce(conversation_id::text, '') from inbox.sessions where id='$1'"; }
claim_of() { claim_name "$(shard_of "$1")" "$(conv_of "$1")"; }
conv_set() { [[ -n $(conv_of "$1") ]]; }
ev_count() { pg -c "select count(*) from inbox.events where session_id='$1' ${2:+and $2}"; }
conversations_in() { pg -c "select count(*) from $(schema_of "$1").conversations"; }
sandbox_ps() { k exec "$1" -c sandboxd -- ps -eo pid=,pgid=,sid=,args=; }
sandbox_has() { sandbox_ps "$1" | sed 's/^ *[0-9]* *[0-9]* *[0-9]* *//' | grep -qx -- "$2"; }
claim_exists() { k get sandboxclaim "$1" >/dev/null 2>&1; }
pvc_exists() { k get pvc "workspace-$1" >/dev/null 2>&1; }
claim_gone() { ! claim_exists "$1"; }
pvc_gone() { ! pvc_exists "$1"; }
sandbox_uid() { k get pod "$1" -o jsonpath='{.metadata.uid}'; }
pvc_uid() { k get pvc "workspace-$1" -o jsonpath='{.metadata.uid}'; }
pod_replaced_ready() { # claim old-uid: a new Pod of that name is Ready
  local uid
  uid=$(k get pod "$1" -o jsonpath='{.metadata.uid}' 2>/dev/null) || return 1
  [[ -n $uid && $uid != "$2" && $(k get pod "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}') == True ]]
}
session_status_is() { [[ $(jq -r '.body.status' <<<"$(api "$1" GET "/sessions/$2")") == "$3" ]]; }
event_status_is() { [[ $(pg -c "select status from inbox.events where session_id='$1' order by id limit 1") == "$2" ]]; }

orch_pods() { # shard: the Running, non-terminating pods of that shard's Deployment
  k get pods -l "app.kubernetes.io/instance=$(deploy_of "$1")" -o json |
    jq -r '.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null) | .metadata.name'
}
orch_ready() { # shard: a Running pod of the shard answers /readyz 200 (it owns the shard's schema)
  local pod
  for pod in $(orch_pods "$1"); do
    k exec "$pod" -c orchestrator -- node -e 'fetch("http://127.0.0.1:8081/readyz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(2))' && return 0
  done
  return 1
}
wait_orch() { # shard [timeout]
  wait_for "shard $1 owns its schema" "${2:-240}" orch_ready "$1"
}
no_orch_pod() { [[ -z $(k get pods -l "app.kubernetes.io/instance=$(deploy_of "$1")" -o name) ]]; }
restart_count() { k get pod "$1" -o jsonpath='{.status.containerStatuses[0].restartCount}'; }
orch_log_has() { # shard pattern (grep -c, not -q: an early exit would SIGPIPE kubectl and fail the pipeline)
  local n
  n=$(k logs "deploy/$(deploy_of "$1")" --tail=5000 2>/dev/null | grep -c -- "$2" || true)
  [[ ${n:-0} -gt 0 ]]
}
# A pinned session with a conversation and a running sandbox: runs `cmd`, whose process shows in the sandbox's ps.
start_command() { # shard final-text command -> prints the session id
  local id
  id=$(new_session_on "$1")
  post alice "$id" message "$(mkscript -f "$2" "$3")" >/dev/null
  printf '%s\n' "$id"
}

# ---------------------------------------------------------------- tests
t_placement() {
  local a b ca cb la lb na nb fa fb
  assert_eq "no active session exists yet, so both shards are equally empty" 0 "$(pg -c "select count(*) from inbox.sessions where status='active'")"
  a=$(new_session alice)
  assert_eq "the first session goes to shard 0 (fewest active, ties to the lowest)" 0 "$(shard_of "$a")"
  b=$(new_session alice)
  assert_eq "the second goes to shard 1 (shard 0 has one active session)" 1 "$(shard_of "$b")"
  post alice "$a" message "$(mkscript -f done-a "echo $a > /workspace/who.txt; echo WROTE-A")" >/dev/null
  post alice "$b" message "$(mkscript -f done-b "echo $b > /workspace/who.txt; echo WROTE-B")" >/dev/null
  transcript alice "$a" done-a 240 >/dev/null
  transcript alice "$b" done-b 240 >/dev/null
  na=$(conv_of "$a")
  nb=$(conv_of "$b")
  ca=$(claim_of "$a")
  cb=$(claim_of "$b")
  assert_eq "shard 0's claim is pi-conv-<n>" "pi-conv-$na" "$ca"
  assert_eq "shard 1's claim is pi-s1-conv-<n>" "pi-s1-conv-$nb" "$cb"
  assert_eq "both shards minted the SAME conversation id (each schema starts at 2): the collision" "$na" "$nb"
  assert "both SandboxClaims exist" claim_exists "$ca"
  assert "and $cb" claim_exists "$cb"
  la=$(k get sandboxclaim "$ca" -o json | jq -r '.metadata.labels["pi-durable-k8s/session-id"]')
  lb=$(k get sandboxclaim "$cb" -o json | jq -r '.metadata.labels["pi-durable-k8s/session-id"]')
  assert_eq "claim $ca is labelled with session A" "$a" "$la"
  assert_eq "claim $cb is labelled with session B" "$b" "$lb"
  fa=$(k exec "$ca" -c sandboxd -- cat /workspace/who.txt)
  fb=$(k exec "$cb" -c sandboxd -- cat /workspace/who.txt)
  assert_eq "A's workspace holds A's file" "$a" "$fa"
  assert_eq "B's workspace holds B's file" "$b" "$fb"
  assert "the PVCs are different" test "$(pvc_uid "$ca")" != "$(pvc_uid "$cb")"
  assert "shard 0's schema holds a conversation" test "$(conversations_in 0)" -ge 1
  assert "shard 1's schema holds a conversation" test "$(conversations_in 1)" -ge 1
  note "EVIDENCE placement: A shard=0 claim=$ca label=$la; B shard=1 claim=$cb label=$lb; conversation ids $na and $nb; workspaces $fa / $fb; rows durable=$(conversations_in 0) durable_s1=$(conversations_in 1)"
}

t_routing() {
  local a b c ea eb out before0 before1
  a=$(new_session_on 0)
  b=$(new_session_on 1)
  post alice "$a" message "route-a" >/dev/null
  post alice "$b" message "route-b" >/dev/null
  ea=$(entries "$(transcript alice "$a" "echo: route-a" 240)")
  eb=$(entries "$(transcript alice "$b" "echo: route-b" 240)")
  assert_jq "the stream of A (shard 0) holds A's message only" "$(users "$ea")" '.==["route-a"]'
  assert_jq "the stream of B (shard 1) holds B's message only" "$(users "$eb")" '.==["route-b"]'
  c=$(new_session_on 1)
  before0=$(conversations_in 0)
  before1=$(conversations_in 1)
  out=$(api alice GET "/sessions/$c/stream" --base http://pi-orchestrator-0:8081)
  assert_jq "a stream sent straight to shard 0 for a shard-1 session is refused with 421" "$out" '.status==421'
  assert_eq "it created no conversation: conversation_id is still null" "" "$(conv_of "$c")"
  assert_eq "and no conversation row in shard 0's schema" "$before0" "$(conversations_in 0)"
  out=$(api alice GET "/sessions/$b/stream" --base http://pi-orchestrator-0:8081)
  assert_jq "the same for B, which has a conversation (in shard 1)" "$out" '.status==421'
  out=$(api alice GET "/sessions/$a/stream" --base http://pi-orchestrator-1:8081)
  assert_jq "and A sent to shard 1" "$out" '.status==421'
  assert_eq "shard 1's schema has no new conversation either" "$before1" "$(conversations_in 1)"
  assert_jq "the shard owner's check still comes first: another owner gets 404 on the right shard" \
    "$(api bob GET "/sessions/$b/stream" --base http://pi-orchestrator-1:8081)" '.status==404'
  note "EVIDENCE routing: ingest streams returned own transcripts; direct wrong-shard streams -> 421 x3; conversation_id of $c null; durable rows $before0 -> $(conversations_in 0), durable_s1 rows $before1 -> $(conversations_in 1)"
}

t_shard_down() {
  local a b out e
  a=$(new_session_on 0)
  b=$(new_session_on 1)
  post alice "$a" message "warm-a" >/dev/null
  post alice "$b" message "warm-b" >/dev/null
  transcript alice "$a" "echo: warm-a" 240 >/dev/null
  transcript alice "$b" "echo: warm-b" 240 >/dev/null
  note "scaling shard 1 to 0"
  k scale deployment pi-orchestrator-1 --replicas=0 >/dev/null
  k wait --for=delete pod -l app.kubernetes.io/instance=pi-orchestrator-1 --timeout=180s >/dev/null 2>&1 || true
  assert "no shard-1 pod is running" no_orch_pod 1
  assert "shard 0 is still ready" orch_ready 0
  post alice "$a" message "while-down-a" >/dev/null
  out=$(post alice "$b" message "while-down-b")
  assert_jq "an event for the shard-1 session is accepted (202) while its shard is down" "$out" '.status==202'
  e=$(entries "$(transcript alice "$a" "echo: while-down-a" 240)")
  assert_jq "the shard-0 session completes its turn" "$(users "$e")" 'any(.[]; .=="while-down-a")'
  sleep 5
  assert_eq "the shard-1 event is still pending: shard 0 does not take it" 1 "$(ev_count "$b" "status='pending'")"
  out=$(api alice GET "/sessions/$b/stream")
  assert_jq "the shard-1 stream answers 503, not a hang" "$out" '.status==503'
  assert_jq "and carries Retry-After" "$out" '.retryAfter!=null and (.retryAfter|test("^[0-9]+$"))'
  assert_jq "the shard-0 stream is unaffected (200 stream for A; checked by its completed turn above)" "$(api alice GET "/sessions/$a")" '.status==200'
  note "scaling shard 1 back to 1"
  k scale deployment pi-orchestrator-1 --replicas=1 >/dev/null
  wait_orch 1
  e=$(entries "$(transcript alice "$b" "echo: while-down-b" 240)")
  assert_jq "the shard-1 event completes after the shard returns, with no new input" "$(users "$e")" 'any(.[]; .=="while-down-b")'
  assert_eq "its row is submitted" 0 "$(ev_count "$b" "status<>'submitted'")"
  note "EVIDENCE shard-down: shard 1 at 0 -> POST 202, event pending, stream 503 retry-after=$(jq -r '.retryAfter' <<<"$out"); shard 0 session completed; shard 1 back -> event completed without new input"
}

t_kill_shard0() {
  local b cb uid pod0 pod1 rc1 e
  b=$(start_command 1 b-finished 'echo B-START; sleep 45; echo B-FINISHED')
  wait_for "B has a conversation" 120 conv_set "$b"
  cb=$(claim_of "$b")
  wait_for "B's command (sleep 45) runs in $cb" 240 sandbox_has "$cb" 'sleep 45'
  uid=$(sandbox_uid "$cb")
  pod1=$(orch_pods 1 | head -1)
  rc1=$(restart_count "$pod1")
  pod0=$(orch_pods 0 | head -1)
  note "killing shard 0's pod $pod0 (force, grace 0) while shard 1 runs a command"
  k delete pod "$pod0" --grace-period=0 --force >/dev/null 2>&1
  wait_orch 0
  assert "shard 0 has a new owner pod" test "$(orch_pods 0 | head -1)" != "$pod0"
  e=$(entries "$(transcript alice "$b" b-finished 300)")
  assert_jq "B's command finished and was not reported as interrupted" "$(results "$e")" 'any(.[]; contains("B-FINISHED")) and all(.[]; (test("interrupt";"i")|not))'
  assert_eq "B's sandbox Pod is the same (uid unchanged)" "$uid" "$(sandbox_uid "$cb")"
  assert_eq "shard 1's pod did not restart" "$rc1" "$(restart_count "$pod1")"
  assert "shard 1 logged no recycle" not orch_log_has 1 '"sandbox-recycled"'
  note "EVIDENCE kill-shard0: shard 0 pod $pod0 killed; B ($cb) Pod uid $uid unchanged, command finished: $(results "$e"); shard 1 restarts $rc1 -> $(restart_count "$pod1")"
}

t_kill_shard1() {
  local a b ca cb ua ub pod1 e
  a=$(start_command 0 a-finished 'echo A-START; sleep 60; echo A-FINISHED')
  b=$(start_command 1 b-final 'echo B-START; sleep 200')
  wait_for "A has a conversation" 120 conv_set "$a"
  wait_for "B has a conversation" 120 conv_set "$b"
  ca=$(claim_of "$a")
  cb=$(claim_of "$b")
  wait_for "A's command (sleep 60) runs in $ca" 240 sandbox_has "$ca" 'sleep 60'
  wait_for "B's command (sleep 200) runs in $cb" 240 sandbox_has "$cb" 'sleep 200'
  ua=$(sandbox_uid "$ca")
  ub=$(sandbox_uid "$cb")
  pod1=$(orch_pods 1 | head -1)
  note "killing shard 1's pod $pod1 (force, grace 0) while both shards run a command"
  k delete pod "$pod1" --grace-period=0 --force >/dev/null 2>&1
  wait_orch 1
  wait_for "B's sandbox Pod was replaced by a Ready one (old uid $ub)" 300 pod_replaced_ready "$cb" "$ub"
  assert "shard 1 logged the recycle at start" orch_log_has 1 '"recycle-at-start"'
  e=$(entries "$(transcript alice "$a" a-finished 300)")
  assert_jq "A's command finished and was not reported as interrupted" "$(results "$e")" 'any(.[]; contains("A-FINISHED")) and all(.[]; (test("interrupt";"i")|not))'
  assert_eq "A's sandbox Pod is the same (uid unchanged): shard 1 never touched shard 0's sandbox" "$ua" "$(sandbox_uid "$ca")"
  assert "shard 0 logged no recycle" not orch_log_has 0 '"sandbox-recycled"'
  e=$(entries "$(transcript alice "$b" b-final 300)")
  assert_jq "B's interrupted command reads as interrupted and the run went on" "$(results "$e")" 'any(.[]; test("interrupt";"i"))'
  note "EVIDENCE kill-shard1: shard 1 killed; B ($cb) Pod $ub replaced; A ($ca) Pod $ua unchanged and its command finished; B result: $(results "$e")"
}

t_long_command() {
  local a b ca cb ub pvca e
  a=$(new_session_on 0)
  post alice "$a" message "$(mkscript -f a-ready 'echo A-KEEP > /workspace/a.txt')" >/dev/null
  transcript alice "$a" a-ready 240 >/dev/null
  b=$(start_command 1 b-long-done 'echo B-LONG-START; sleep 170; echo B-LONG-END')
  wait_for "B has a conversation" 120 conv_set "$b"
  ca=$(claim_of "$a")
  cb=$(claim_of "$b")
  wait_for "B's command (sleep 170) runs in $cb" 240 sandbox_has "$cb" 'sleep 170'
  ub=$(sandbox_uid "$cb")
  pvca=$(pvc_uid "$ca")
  note "B runs 170 s; the suspend time is 120 s and shard 0 scans every 15 s: several scans of shard 0 pass over $cb"
  e=$(entries "$(transcript alice "$b" b-long-done 420)")
  assert_jq "B's command ran to its end without interruption" "$(results "$e")" 'any(.[]; contains("B-LONG-END")) and all(.[]; (test("interrupt";"i")|not))'
  assert_eq "B's Pod was never replaced or suspended (same uid)" "$ub" "$(sandbox_uid "$cb")"
  assert "both claims exist after the scans: $ca" claim_exists "$ca"
  assert "and $cb" claim_exists "$cb"
  assert "B's claim was never swept or suspended by shard 0" not orch_log_has 0 "$cb"
  note "deleting B's session"
  api alice DELETE "/sessions/$b" >/dev/null
  wait_for "B's session is deleted" 180 session_status_is alice "$b" deleted
  wait_for "B's claim is gone" 180 claim_gone "$cb"
  wait_for "B's PVC is gone" 180 pvc_gone "$cb"
  assert "A's claim stays" claim_exists "$ca"
  assert "A's PVC stays" pvc_exists "$ca"
  assert_eq "A's PVC is the same one (uid)" "$pvca" "$(pvc_uid "$ca")"
  # A has been idle for minutes and may be suspended (Pod gone, PVC kept), so read its file through a new message.
  post alice "$a" message "$(mkscript -f a-back 'cat /workspace/a.txt')" >/dev/null
  e=$(entries "$(transcript alice "$a" a-back 300)")
  assert_jq "A's workspace file is intact after B's deletion" "$(results "$e")" 'any(.[]; contains("A-KEEP"))'
  note "EVIDENCE long-command: B ($cb) ran 170 s past the 120 s suspend time, Pod uid $ub unchanged; deleting B removed $cb and its PVC only; A ($ca, PVC $pvca) kept with a.txt=A-KEEP"
}

# ---------------------------------------------------------------- setup
log "setup: wait for CNPG, both orchestrator shards and ingest (stack, shard 1 and code were pushed by run.sh)"
[[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}' 2>/dev/null) ]] || {
  echo "secret sandboxd-auth has no master key: run hack/gen-secret.sh" >&2
  exit 1
}
"$root/hack/gen-api-secret.sh" >/dev/null
e2e_db_start
k rollout status deployment/pi-orchestrator --timeout=240s >/dev/null
k rollout status deployment/pi-orchestrator-1 --timeout=240s >/dev/null
k rollout status deployment/pi-ingest --timeout=240s >/dev/null
wait_orch 0
wait_orch 1
assert_eq "ingest is set for two shards" 2 "$(k get deployment pi-ingest -o json | jq -r '.spec.template.spec.containers[0].env[] | select(.name=="PI_ORCH_SHARDS") | .value')"
assert_eq "each shard has its own schema" "durable,durable_s1" "$(pg -c "select string_agg(schema_name, ',' order by schema_name) from information_schema.schemata where schema_name in ('durable','durable_s1')")"

log "setup: scripted default model through PUT /admin/settings"
before=$(api alice GET /admin/settings)
assert_jq "alice can read the settings (is PI_API_ADMINS set on ingest?)" "$before" '.status==200'
jq -c '.body | {defaultModel, allowlist, reasoning, turnBudget}' <<<"$before" >"$settings_before"
assert_jq "the scripted default is set" "$(api alice PUT /admin/settings '{"defaultModel":"scripted/scripted-1","reasoning":null}')" '.status==200 and .body.defaultModel=="scripted/scripted-1"'

# ---------------------------------------------------------------- run
# ONLY="routing,shard-down" runs just those tests. Every test is serial: they share the two shards, and several kill
# or scale an orchestrator. `placement` runs first because it needs a stack with no active session.
# Never exits the suite: a shard that does not come back makes the next test fail on its own.
e2e_settle_orch() {
  local deadline=$(($(now) + 240))
  until { orch_ready 0 && orch_ready 1; } >/dev/null 2>&1 || [[ $(now) -ge $deadline ]]; do sleep 2; done
}
E2E_AFTER=e2e_settle_orch

e2e_serial placement t_placement
e2e_serial routing t_routing
e2e_serial shard-down t_shard_down
e2e_serial kill-shard0 t_kill_shard0
e2e_serial kill-shard1 t_kill_shard1
e2e_serial long-command t_long_command

log "RESULT"
printf '%s\n' "${summary[@]}"
grep -h -E 'EVIDENCE' "$work"/*.log | sed 's/^ */  /' || true
if [[ $failed -ne 0 ]]; then
  echo "SHARDS: FAILED" >&2
  exit 1
fi
echo "SHARDS: all tests passed"
