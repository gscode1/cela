#!/usr/bin/env bash
# Runs IN the cluster, as the e2e-driver Job started by tests/e2e/run.sh (ServiceAccount kubeconfig, no context).
# The overlay tests/e2e/deploy (base deploy/ plus test-only orchestrator switches) and image deployment are done by
# run.sh on the Mac before the Job starts; this script only waits for them and runs the tests.
# Phase 3 failure tests on the real cluster: orchestrator + CNPG + sandboxes, scripted model, no LLM.
#
#   restart        kill the orchestrator pod mid-task; the session resumes from Postgres with no input
#   double-owner   a second orchestrator blocks on the lock; the first fails closed when its DB connection dies
#   long-command   kill the orchestrator during a 5 min command: interrupted, process gone, no rerun
#   sandbox-loss   delete the sandbox Pod; a new Pod mounts the same PVC; the next tool call works
#   concurrency    two sessions at once, separate sandboxes and PVCs, no cross-access
#   isolation      a sandbox cannot reach the orchestrator, Postgres, another sandbox, the Kubernetes API, the OneCLI
#                  API or the internet, and can reach the OneCLI gateway (the control). It must PASS once the CNI
#                  enforces NetworkPolicy (Cilium, deploy/networkpolicy*.yaml + deploy/cilium/). It is KNOWN-FAIL
#                  (printed, not a failure of the run) only while enforcement is absent: every denied target is
#                  reachable, as on flannel. A mix of blocked and reachable is a FAIL. NETPOL_ENFORCED=1 turns
#                  KNOWN-FAIL into FAIL (use it after the migration); NETPOL_ENFORCED=0 forces KNOWN-FAIL.
#
# Touches only namespace $NAMESPACE (the run namespace pi-e2e-<id>). Needs the CNPG operator in postgres-system and the secret sandboxd-auth
# (deploy/gen-secret.sh). DB credentials and the sandboxd token stay in the cluster: nothing here reads or prints them.
# Run by hand from a Mac with your current kubectl context it works the same, but use tests/e2e/run.sh.
# Exit code: 0 when every test passed (isolation may be KNOWN-FAIL while enforcement is absent), 1 otherwise.
set -euo pipefail

ctx=${KUBE_CONTEXT:-} # empty in the Job: kubectl then uses the in-cluster ServiceAccount config
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd) # the driver image mirrors the repo layout: tests/e2e and deploy/gen-api-secret.sh
work=$(mktemp -d)
claims_file=$work/claims
: >"$claims_file"
holder_pid=""
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }
# shellcheck source=fns.sh
. "$here/fns.sh"

cleanup() {
  [[ -n "$holder_pid" ]] && kill "$holder_pid" 2>/dev/null || true
  k delete deployment pi-orchestrator-b --ignore-not-found --wait=false >/dev/null 2>&1 || true
  while read -r claim; do
    [[ -n "$claim" ]] && { k delete sandboxclaim "$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
  done <"$claims_file"
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
    note "  got: $(jq -c . <<<"$2" 2>/dev/null || printf '%s' "$2")"
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

# ---------------------------------------------------------------- orchestrator access
# Control calls run inside the orchestrator pod (node has fetch); nothing is exposed outside the cluster.
api() { # pod method path [body]
  k exec "$1" -c orchestrator -- node -e 'const [m,p,b]=process.argv.slice(1);const t=(process.env.PI_API_TOKENS||"").split(/[\n,]/)[0].split(":").slice(1).join(":");fetch("http://127.0.0.1:8081"+(p.startsWith("/sessions")?"/control":"")+p,{method:m,body:b||undefined,headers:{authorization:"Bearer "+t}}).then(async r=>{process.stdout.write(await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(2)})' "$2" "$3" "${4:-}"
}
orch_pods() { # running, not terminating
  k get pods -l app.kubernetes.io/name=pi-orchestrator -o json |
    jq -r '.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null) | .metadata.name'
}
owner_pod() { # the orchestrator pod whose /readyz says it owns the schema
  local pod
  for pod in $(orch_pods); do
    if api "$pod" GET /readyz >/dev/null 2>&1; then
      printf '%s\n' "$pod"
      return 0
    fi
  done
  return 1
}
wait_owner() { wait_for "an orchestrator owns the schema" "${1:-240}" owner_pod; }
healthz_ok() { api "$1" GET /readyz; }
either_owner() { healthz_ok "$1" || healthz_ok "$2"; }
logs_contain() { k logs "$1" "${@:3}" 2>/dev/null | grep -q -- "$2"; } # pod pattern [kubectl-logs-flags]
restart_count() { k get pod "$1" -o jsonpath='{.status.containerStatuses[0].restartCount}'; }
restarted_beyond() { [[ $(restart_count "$1") -gt $2 ]]; }

mkscript() { # [-f final] bash-command... -> script JSON
  local final=done steps='[]' cmd
  if [[ ${1:-} == -f ]]; then
    final=$2
    shift 2
  fi
  for cmd in "$@"; do steps=$(jq -c --arg b "$cmd" '. + [{bash:$b, timeout:900}]' <<<"$steps"); done
  jq -nc --argjson s "$steps" --arg f "$final" '{steps:$s, final:$f}'
}
new_session() { # script-json -> prints the session id (claim = pi-conv-<id>)
  local out id
  out=$(api "$(owner_pod)" POST /sessions "$1")
  id=$(jq -r '.id' <<<"$out")
  printf 'pi-conv-%s\n' "$id" >>"$claims_file"
  printf '%s\n' "$id"
}
send_input() { api "$(owner_pod)" POST "/sessions/$1/inputs" "$2" >/dev/null; }
status() { api "$(owner_pod)" GET "/sessions/$1"; }
session_matches() { jq -e "$2" <<<"$(status "$1")"; } # id jq-expression
wait_session() { wait_for "${4:-session $1 reaches: $2}" "${3:-240}" session_matches "$1" "$2"; } # id expr [timeout] [desc]
status_on() { api "$1" GET "/sessions/$2"; }
done_on() { jq -e '.state=="done"' <<<"$(status_on "$1" "$2")"; } # pod id

# ---------------------------------------------------------------- sandbox and DB access
sandbox_ps() { k exec "$1" -c sandboxd -- ps -eo pid=,pgid=,sid=,args=; }
# Whole-line match: the tool's own `bash -c '...sleep 31...'` must not count as the sleep itself.
sandbox_has() { sandbox_ps "$1" | sed 's/^ *[0-9]* *[0-9]* *[0-9]* *//' | grep -qx -- "$2"; }
sandbox_lacks() { ! sandbox_has "$1" "$2"; }
sandbox_uid() { k get pod "$1" -o jsonpath='{.metadata.uid}'; }
pod_ready() { [[ $(k get pod "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null) == True ]]; }
pod_replaced() { [[ -n $(sandbox_uid "$1" 2>/dev/null) && $(sandbox_uid "$1") != "$2" ]]; } # claim old-uid
file_lines() { k exec "$1" -c sandboxd -- sh -c "wc -l < $2" | tr -d ' '; }
pg() { k exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -v ON_ERROR_STOP=1 "$@"; }
pg_seq() { pg -c 'select next_seq from durable.durable_metadata'; }
seq_advancing() {
  local s1 s2
  s1=$(pg_seq)
  sleep 4
  s2=$(pg_seq)
  [[ $s2 -gt $s1 ]]
}
holder_has_lock() { # this test's own psql session holds the ownership lock
  [[ $(pg -c "select count(*) from pg_locks l join pg_stat_activity a using(pid) where l.locktype='advisory' and l.granted and a.application_name='psql'") == 1 ]]
}
none_reachable() { [[ $1 != *REACHABLE* ]]; }
dump_orchestrator_logs() { # on a failed takeover: both orchestrators' logs, current and previous container
  local pod
  for pod in "$@"; do
    [[ -n $pod ]] || continue
    note "---- logs $pod (current) ----"
    k logs "$pod" -c orchestrator --tail=60 2>&1 | sed 's/^/     /' || true
    note "---- logs $pod (--previous) ----"
    k logs "$pod" -c orchestrator --previous --tail=60 2>&1 | sed 's/^/     /' || true
  done
}
not() { ! "$@"; }
exited_with_1() { k get pod "$1" -o json | jq -e '.status.containerStatuses[0].lastState.terminated.exitCode==1'; }
sandbox_file_exists() { k exec "$1" -c sandboxd -- test -e "$2"; }
# The second orchestrator for the double-owner test is the LIVE pi-orchestrator Deployment (base deploy/ plus the
# e2e overlay) under another name, so its env, image, volumes and test switches cannot drift from the first. Only
# the identity changes: name, instance label and selector. It asks for less, since it mostly waits on the lock.
render_orchestrator_b() {
  k get deployment pi-orchestrator -o json | jq '
    del(.status, .metadata.uid, .metadata.resourceVersion, .metadata.generation, .metadata.creationTimestamp,
        .metadata.annotations, .metadata.managedFields, .metadata.ownerReferences)
    | .metadata.name = "pi-orchestrator-b"
    | .spec.replicas = 1
    | .spec.selector.matchLabels["app.kubernetes.io/instance"] = "pi-orchestrator-b"
    | .spec.template.metadata.labels["app.kubernetes.io/instance"] = "pi-orchestrator-b"
    | .spec.template.spec.containers[0].resources.requests = {cpu: "50m", memory: "128Mi"}'
}
has_pod_for() { [[ -n $(k get pods -l "app.kubernetes.io/instance=$1" -o name) ]]; }

# ---------------------------------------------------------------- tests
t_restart() {
  local pod0 id claim s
  pod0=$(owner_pod)
  id=$(new_session "$(mkscript -f resumed-and-done 'echo RESTART-STEP1-START; sleep 31; echo RESTART-STEP1-END' 'echo RESTART-STEP2-OK')")
  claim=pi-conv-$id
  wait_for "sleep 31 running in $claim" 120 sandbox_has "$claim" 'sleep 31'
  assert_jq "session is mid-task before the kill" "$(status "$id")" '.state=="running" and (.results|length)==0'
  note "killing orchestrator pod $pod0 (force, grace 0)"
  k delete pod "$pod0" --grace-period=0 --force >/dev/null 2>&1
  wait_owner
  assert "the owner is a new pod" test "$(owner_pod)" != "$pod0"
  # From here on only reads: no input is sent to the session.
  wait_session "$id" '.state=="done"' 240 "session resumed with no new input and completed"
  s=$(status "$id")
  assert_jq "first call reads as interrupted (bash is not replay-safe)" "$s" '.results[0].isError and (.results[0].text|test("interrupt";"i"))'
  assert_jq "script continued after the restart: step 2 ran" "$s" '.results[1].text|contains("RESTART-STEP2-OK")'
  assert_jq "exactly two tool calls, none replayed" "$s" '(.results|length)==2 and .answer=="resumed-and-done"'
  note "EVIDENCE restart: $(jq -c '{state, answer, r0:.results[0].text[0:90], r1:.results[1].text[0:40]}' <<<"$s")"
}

t_double_owner() {
  local a b id seq0 seq1 rc0 s
  # Runs in the test's own subshell, so it fires on a failed assert too: B must not outlive this test and
  # distort the tests that follow (the script-level cleanup only runs at the very end).
  trap 'k delete deployment pi-orchestrator-b --ignore-not-found --wait=true >/dev/null 2>&1 || true' EXIT
  a=$(owner_pod)
  note "first orchestrator: $a"
  rc0=$(restart_count "$a")
  k delete deployment pi-orchestrator-b --ignore-not-found --wait=true >/dev/null
  render_orchestrator_b | k create -f - >/dev/null
  wait_for "second orchestrator pod exists" 180 has_pod_for pi-orchestrator-b
  b=$(k get pods -l app.kubernetes.io/instance=pi-orchestrator-b -o jsonpath='{.items[0].metadata.name}')
  note "second orchestrator: $b"
  wait_for "second orchestrator logs waiting-for-lock" 180 logs_contain "$b" waiting-for-lock
  assert "second orchestrator has not acquired the lock" not logs_contain "$b" lock-acquired
  assert "second orchestrator is not serving (readyz 503)" not healthz_ok "$b"
  assert_jq "exactly one backend holds the advisory lock: the first orchestrator" \
    "$(pg -c "select json_build_object('holders', count(*), 'apps', json_agg(a.application_name)) from pg_locks l join pg_stat_activity a using(pid) where l.locktype='advisory' and l.granted")" \
    ".holders==1 and .apps==[\"$a\"]"

  id=$(new_session "$(mkscript -f takeover-done 'for i in $(seq 1 200); do echo tick-$i; sleep 1; done; echo A-FINISHED')")
  wait_for "first orchestrator is committing tick output" 120 seq_advancing

  # Kill the first owner's backend, and in the same psql session take the lock and hold it. Nobody else can
  # write while we hold it, so an unchanged next_seq proves the fenced-off first owner wrote nothing.
  note "terminating the first orchestrator's DB backend, then holding the lock for 30 s"
  pg -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='$a'" \
    -c "select pg_advisory_lock(hashtextextended('pi-durable-postgres:durable',0))" \
    -c "select pg_sleep(30)" \
    -c "select pg_advisory_unlock(hashtextextended('pi-durable-postgres:durable',0))" >"$work/holder.out" 2>&1 &
  holder_pid=$!
  wait_for "this test holds the lock" 30 holder_has_lock
  seq0=$(pg_seq)
  wait_for "first orchestrator container exited (fail closed)" 60 restarted_beyond "$a" "$rc0"
  assert "first orchestrator logged fail-closed before exiting" logs_contain "$a" fail-closed --previous
  assert "first orchestrator exited with code 1" exited_with_1 "$a"
  sleep 5
  seq1=$(pg_seq)
  assert "nothing was written after the connection was killed (next_seq $seq0 -> $seq1)" test "$seq0" = "$seq1"
  wait "$holder_pid" 2>/dev/null || true
  holder_pid=""

  # Either B or the restarted first orchestrator may win the lock race; both are correct.
  # What matters is a single owner that finishes the session.
  wait_for "an orchestrator took over the lock" 120 either_owner "$a" "$b"
  if healthz_ok "$b"; then owner=$b; else owner=$a; fi
  note "new owner: $owner"
  if ! (wait_for "new owner finishes the session with no new input" 240 done_on "$owner" "$id"); then
    note "owner=$owner readyz: $(healthz_ok "$owner" 2>&1 | head -c 200)"
    note "status on owner: $(status_on "$owner" "$id" 2>&1 | head -c 300)"
    dump_orchestrator_logs "$a" "$b"
    exit 1
  fi
  s=$(status_on "$owner" "$id")
  assert_jq "result is interrupted and the first owner's command never completed (no A-FINISHED)" "$s" '.results[0].isError and (.results[0].text|test("interrupt";"i")) and (.results[0].text|contains("A-FINISHED")|not)'
  note "EVIDENCE double-owner: first=$a exited 1 after fail-closed; second=$b waited; new owner=$owner; next_seq frozen at $seq0 while the first was dead"
  # Back to a single owner: removing B lets the restarted first orchestrator take the lock again.
  k delete deployment pi-orchestrator-b --wait=true >/dev/null
  wait_owner
}

t_long_command() {
  local pod0 id claim s t0 t_seen n uid0 uid1
  pod0=$(owner_pod)
  # sleep 60 is the command. 61 is a background grandchild in the same process group; 62 runs under setsid,
  # so it has its own session and group. What survives the SIGKILL answers the process-group question.
  id=$(new_session "$(mkscript -f long-done 'echo run >> /workspace/long-runs.log; (sleep 61 </dev/null >/dev/null 2>&1 &); setsid sleep 62 </dev/null >/dev/null 2>&1 & sleep 60; echo LONG-DONE')")
  claim=pi-conv-$id
  wait_for "sleep 60 running in $claim" 120 sandbox_has "$claim" 'sleep 60'
  t_seen=$(now)
  wait_for "background grandchildren running" 30 sandbox_has "$claim" 'sleep 62'
  note "process table before the kill (pid pgid sid args):"
  sandbox_ps "$claim" | grep -E 'sleep 6[0-2]$|pi-env' | sed 's/^/     /'
  uid0=$(sandbox_uid "$claim")
  note "killing orchestrator pod $pod0 (force, grace 0) during the 1 minute command"
  t0=$(now)
  k delete pod "$pod0" --grace-period=0 --force >/dev/null 2>&1
  wait_owner
  wait_session "$id" '.state=="done"' 240 "session completed after restart with no new input"
  note "session done $(($(now) - t0)) s after the kill"
  s=$(status "$id")
  assert_jq "tool result reads as interrupted" "$s" '.results[0].isError and (.results[0].text|test("interrupt";"i"))'
  assert_jq "one tool call only" "$s" '(.results|length)==1 and .answer=="long-done"'
  # The sandbox Pod can be replaced around the restart: once (2026-11-16) it was stopped and recreated during this
  # test, cause not identified (control sessions are not recycled at restart). Inspect the sandbox only once it is
  # Ready again, and say whether it was replaced: while the Pod is gone, sandbox_lacks would pass for the wrong reason.
  wait_for "sandbox pod $claim is Ready again" 180 pod_ready "$claim"
  uid1=$(sandbox_uid "$claim")
  if [[ $uid1 != "$uid0" ]]; then note "ANSWER the sandbox Pod was recycled at restart ($uid0 -> $uid1)"; else note "ANSWER the sandbox Pod was kept"; fi
  wait_for "sleep 60 is gone from the sandbox" 240 sandbox_lacks "$claim" 'sleep 60'
  note "ANSWER sleep 60 (the command) gone $(($(now) - t0)) s after the kill"
  # Gone because the kill reaped it, not because it ended by itself: it still had time left on its 60 s.
  assert "the command was reaped before its natural end (gone $(($(now) - t_seen)) s after first seen, of 60)" test $(($(now) - t_seen)) -lt 58
  note "process table after the kill (pid pgid sid args):"
  sandbox_ps "$claim" | sed 's/^/     /'
  for n in 61 62; do
    if sandbox_has "$claim" "sleep $n"; then
      note "ANSWER sleep $n (background grandchild) SURVIVED the kill"
    else
      note "ANSWER sleep $n (background grandchild) was reaped"
    fi
  done
  assert "the command ran exactly once" test "$(file_lines "$claim" /workspace/long-runs.log)" = 1
  sleep 15
  assert "nothing re-ran 15 s later: no sleep 60 in the sandbox" sandbox_lacks "$claim" 'sleep 60'
  assert_jq "transcript unchanged: still one tool call" "$(status "$id")" '(.results|length)==1'
  assert "run log still has one line" test "$(file_lines "$claim" /workspace/long-runs.log)" = 1
}

t_sandbox_loss() {
  local id claim uid0 uid1 pvc0 pvc1 s
  id=$(new_session "$(mkscript -f first-done 'echo persisted-data > /workspace/loss.txt; echo POD1-$(hostname)')")
  claim=pi-conv-$id
  wait_session "$id" '.state=="done"' 240
  uid0=$(sandbox_uid "$claim")
  pvc0=$(k get pvc "workspace-$claim" -o jsonpath='{.metadata.uid}')
  note "deleting sandbox Pod $claim (uid $uid0)"
  k delete pod "$claim" --wait=true >/dev/null
  wait_for "a new sandbox Pod exists" 180 pod_replaced "$claim" "$uid0"
  k wait --for=condition=Ready "pod/$claim" --timeout=240s >/dev/null
  uid1=$(sandbox_uid "$claim")
  pvc1=$(k get pvc "workspace-$claim" -o jsonpath='{.metadata.uid}')
  assert "the Pod is a new one" test "$uid0" != "$uid1"
  assert "it mounts the same PVC claim name" test "$(k get pod "$claim" -o jsonpath='{.spec.volumes[?(@.name=="workspace")].persistentVolumeClaim.claimName}')" = "workspace-$claim"
  assert "the PVC object is the same one (uid unchanged)" test "$pvc0" = "$pvc1"
  # The orchestrator did not restart, so its cached env and Connection for this session are the long-lived ones.
  send_input "$id" "$(mkscript -f second-done 'cat /workspace/loss.txt; echo POD2-$(hostname)')"
  wait_session "$id" '.state=="done" and (.results|length)==2' 240 "next tool call completed on the same long-lived Connection"
  s=$(status "$id")
  assert_jq "next tool call worked and reads the old file from the same PVC" "$s" '(.results[1].isError|not) and (.results[1].text|contains("persisted-data"))'
  note "EVIDENCE sandbox-loss: pod $uid0 -> $uid1, pvc $pvc0 kept, second result: $(jq -c '.results[1].text' <<<"$s")"

  # Harder case: the Pod dies and the next call is issued without waiting for the replacement.
  k delete pod "$claim" --wait=false >/dev/null
  send_input "$id" "$(mkscript -f third-done 'cat /workspace/loss.txt; echo POD3-$(hostname)')"
  wait_session "$id" '.state=="done" and (.results|length)==3' 300 "a call issued while the Pod is being replaced finishes"
  s=$(status "$id")
  note "EVIDENCE connection-during-recreation: third call isError=$(jq -c '.results[2].isError' <<<"$s") text=$(jq -c '.results[2].text[0:120]' <<<"$s")"
  assert_jq "third call worked with no explicit reconnect step" "$s" '(.results[2].isError|not) and (.results[2].text|contains("persisted-data"))'
}

t_concurrency() {
  local a b ca cb sa sb as ae bs be
  # Started together: each start waits for its own claim, so sequential starts would not overlap.
  new_session "$(mkscript -f done-a 'echo A-START $(date +%s); echo A-SECRET > /workspace/file-a.txt; sleep 20; echo A-END $(date +%s); ls /workspace')" >"$work/a.id" &
  new_session "$(mkscript -f done-b 'echo B-START $(date +%s); echo B-SECRET > /workspace/file-b.txt; sleep 20; echo B-END $(date +%s); ls /workspace')" >"$work/b.id" &
  wait
  a=$(cat "$work/a.id")
  b=$(cat "$work/b.id")
  ca=pi-conv-$a
  cb=pi-conv-$b
  assert "two distinct claims ($ca, $cb)" test "$ca" != "$cb"
  wait_session "$a" '.state=="done"' 300
  wait_session "$b" '.state=="done"' 300
  sa=$(status "$a")
  sb=$(status "$b")
  assert "separate sandbox Pods" test "$(sandbox_uid "$ca")" != "$(sandbox_uid "$cb")"
  assert "separate PVCs" test "$(k get pvc "workspace-$ca" -o jsonpath='{.metadata.uid}')" != "$(k get pvc "workspace-$cb" -o jsonpath='{.metadata.uid}')"
  assert_jq "A sees its own file and not B's" "$sa" '.results[0].text|contains("file-a.txt") and (contains("file-b.txt")|not)'
  assert_jq "B sees its own file and not A's" "$sb" '.results[0].text|contains("file-b.txt") and (contains("file-a.txt")|not)'
  assert "file-a.txt does not exist in B's sandbox" not sandbox_file_exists "$cb" /workspace/file-a.txt
  assert "file-b.txt does not exist in A's sandbox" not sandbox_file_exists "$ca" /workspace/file-b.txt
  as=$(jq -r '.results[0].text' <<<"$sa" | sed -n 's/^A-START //p')
  ae=$(jq -r '.results[0].text' <<<"$sa" | sed -n 's/^A-END //p')
  bs=$(jq -r '.results[0].text' <<<"$sb" | sed -n 's/^B-START //p')
  be=$(jq -r '.results[0].text' <<<"$sb" | sed -n 's/^B-END //p')
  assert "the commands ran in parallel (A $as-$ae, B $bs-$be)" test "$as" -lt "$be" -a "$bs" -lt "$ae"
  note "EVIDENCE concurrency: A=$ca B=$cb; A ls: $(jq -c '.results[0].text|split("\n")|map(select(startswith("file-")))' <<<"$sa") B ls: $(jq -c '.results[0].text|split("\n")|map(select(startswith("file-")))' <<<"$sb")"
}

# Enforcement hint for the report only (the verdict comes from the probes): the Cilium agent DaemonSet in kube-system.
# The in-cluster driver may not be allowed to read kube-system; then this says so and the probes decide.
cni_hint() {
  local ready
  if ready=$(kubectl ${ctx:+--context="$ctx"} -n kube-system get ds cilium -o jsonpath='{.status.numberReady}' 2>/dev/null) && [[ -n $ready ]]; then
    echo "cilium-agent DaemonSet present, $ready ready"
  elif kubectl ${ctx:+--context="$ctx"} -n kube-system get ds kube-flannel-ds kube-flannel >/dev/null 2>&1; then
    echo "flannel DaemonSet present, no cilium-agent"
  else
    echo "CNI not readable with this identity"
  fi
}
# Count the in-cluster denied probes that answered REACHABLE / BLOCKED (not the control, and not internet-direct: a LAN
# firewall can block that one even with no NetworkPolicy, so it only counts once enforcement is established).
count_denied() { printf '%s\n' "$2" | grep -v -E '^(onecli-gateway|internet-direct) ' | grep -c " $1\$" || true; }
# Status codes sandbox B's sandboxd (REST /v1/metadata, which needs the token) gives to: no token, A's token, the
# hash of A's token (what A's own Pod was given), the hash of B's token, and B's token. Runs in the orchestrator pod,
# the one place both the master and the network path to sandboxd exist; the tokens are derived there by the shared
# deriveSandboxToken and only status codes leave it. NetworkPolicy already stops sandbox-to-sandbox traffic
# (the probes below), so this checks the second layer: a token that leaks is good for one sandbox only.
auth_codes() { # orchestrator-pod claim-a claim-b -> JSON of status codes
  k exec "$1" -c orchestrator -- node --input-type=module -e '
    import { deriveSandboxToken as derive, sandboxTokenSha256 as sha } from "@pi-durable-k8s/sandbox-env";
    const [a, b] = process.argv.slice(1);
    const master = process.env.PI_SANDBOX_MASTER_KEY ?? "";
    const ta = derive(master, a), tb = derive(master, b);
    const url = `http://${b}.${process.env.PI_ORCH_NAMESPACE}.svc.cluster.local:8080/v1/metadata`;
    const code = async (t) => (await fetch(url, { headers: t ? { authorization: `Bearer ${t}` } : {} })).status;
    process.stdout.write(JSON.stringify({ none: await code(), tokenA: await code(ta), hashA: await code(sha(ta)),
      hashB: await code(sha(tb)), tokenB: await code(tb) }));' "$2" "$3"
}
t_isolation() {
  local a b out probe reach blocked control hint codes
  hint=$(cni_hint)
  note "CNI: $hint"
  a=$(new_session "$(mkscript -f iso-a 'echo noop')")
  b=$(new_session "$(mkscript -f iso-b 'echo noop')")
  wait_session "$a" '.state=="done"' 240
  wait_session "$b" '.state=="done"' 240
  codes=$(auth_codes "$(owner_pod)" "pi-conv-$a" "pi-conv-$b")
  note "EVIDENCE per-sandbox-token: sandbox B's sandboxd answers $codes"
  assert_jq "B's own token is accepted (the probe works)" "$codes" '.tokenB==200'
  assert_jq "B rejects no token, A's token, the hash of A's token and the hash of B's token" "$codes" \
    '[.none,.tokenA,.hashA,.hashB]|all(.==401 or .==403)'
  probe='probe() { if timeout 4 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; then echo "$3 REACHABLE"; else echo "$3 BLOCKED"; fi; }; '
  probe+="probe pi-orchestrator.$ns.svc.cluster.local 8081 orchestrator; "
  probe+="probe pi-pg-rw.$ns.svc.cluster.local 5432 postgres; "
  probe+="probe pi-conv-$b.$ns.svc.cluster.local 8080 other-sandbox-rest; "
  probe+="probe pi-conv-$b.$ns.svc.cluster.local 9090 other-sandbox-grpc; "
  probe+="probe kubernetes.default.svc.cluster.local 443 kube-api; "
  probe+="probe onecli.onecli.svc.cluster.local 10256 onecli-api; "
  probe+="probe onecli.onecli.svc.cluster.local 10254 onecli-web; "
  probe+="probe 1.1.1.1 443 internet-direct; "
  probe+="probe onecli.onecli.svc.cluster.local 10255 onecli-gateway"
  send_input "$a" "$(mkscript -f probed "$probe")"
  wait_session "$a" '.state=="done" and (.results|length)==2' 240
  out=$(status "$a" | jq -r '.results[1].text')
  printf '%s\n' "$out" | sed 's/^/     /'
  note "EVIDENCE isolation: $(printf '%s' "$out" | tr '\n' ';')"
  reach=$(count_denied REACHABLE "$out")
  blocked=$(count_denied BLOCKED "$out")
  control=$(printf '%s\n' "$out" | sed -n 's/^onecli-gateway //p')
  # The gateway is allowed with or without enforcement, so check it before the known-fail exit: a dead gateway
  # must not be hidden behind "NetworkPolicy is not enforced".
  assert "the probe works: the OneCLI gateway :10255 (allowed) is reachable, so the blocks are policy, not a broken probe" test "$control" = REACHABLE
  if [[ $reach -gt 0 && $blocked -eq 0 && ${NETPOL_ENFORCED:-auto} != 1 ]] || [[ ${NETPOL_ENFORCED:-auto} == 0 ]]; then
    note "no enforcement observed: all $reach denied targets reachable ($hint)"
    exit 3 # KNOWN-FAIL: NetworkPolicy is not enforced yet
  fi
  assert "every denied in-cluster target is unreachable from a sandbox ($reach reachable, $blocked blocked)" test "$reach" -eq 0
  assert "direct public internet is reachable (sandbox-allow-internet-egress)" grep -q '^internet-direct REACHABLE' <<<"$out"
}

# ---------------------------------------------------------------- setup
log "setup: wait for CNPG and the orchestrator (overlay and code were pushed by run.sh)"
# SKIP_SETUP=1 reuses what is deployed (debugging aid).
if [[ ${SKIP_SETUP:-0} == 1 ]]; then wait_owner; else
[[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}' 2>/dev/null) ]] || {
  echo "secret sandboxd-auth has no master key: run deploy/gen-secret.sh" >&2
  exit 1
}
"$root/deploy/gen-api-secret.sh" >/dev/null
k wait --for=condition=Ready cluster.postgresql.cnpg.io/pi-pg --timeout=300s >/dev/null
k rollout status deployment/pi-orchestrator --timeout=240s >/dev/null
wait_owner
fi

# ---------------------------------------------------------------- run
# ONLY="double-owner,restart" runs just those tests (debugging aid); the full suite runs when unset.
isolation_status=""
record() { # name rc: like the shared one, plus isolation's KNOWN-FAIL (exit 3)
  if [[ $1 == isolation && $2 -eq 3 ]]; then
    summary+=("KNOWN-FAIL  $1 (NetworkPolicy is not enforced by the CNI yet; passes once Cilium enforces deploy/networkpolicy*.yaml)")
    isolation_status=known-fail
  elif [[ $2 -eq 0 ]]; then
    summary+=("PASS  $1")
  else
    summary+=("FAIL  $1")
    failed=1
  fi
}
E2E_AFTER=wait_owner

# Parallel: each test has its own sessions and claims and only touches its own sandbox (sandbox-loss deletes its own
# Pod, the orchestrator keeps running). Serial afterwards: they kill the orchestrator or hold the database lock.
e2e_parallel sandbox-loss:t_sandbox_loss concurrency:t_concurrency isolation:t_isolation
e2e_serial restart t_restart
e2e_serial double-owner t_double_owner
e2e_serial long-command t_long_command

log "RESULT"
printf '%s\n' "${summary[@]}"
grep -h -E 'EVIDENCE|ANSWER' "$work"/*.log | sed 's/^ */  /' || true
if [[ $failed -ne 0 ]]; then
  echo "PHASE 3: FAILED" >&2
  exit 1
fi
echo "PHASE 3: all tests passed (isolation: ${isolation_status:-passed})"
