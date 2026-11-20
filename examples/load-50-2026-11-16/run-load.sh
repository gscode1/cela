#!/usr/bin/env bash
# Load test: 50 repo sessions created at once, followed from one stream process, sampled every 15 s.
# Abort rule: a node reports MemoryPressure/DiskPressure/PIDPressure, or more pods outside cela-dev are
# unhealthy than at the start -> every session is deleted.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); ns=${NAMESPACE:-cela-dev}
mkdir -p "$here/raw"
ctx=${KUBE_CONTEXT:-}
kubectl() { command kubectl ${ctx:+--context="$ctx"} "$@"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ingest() { kubectl -n $ns get pod -l app.kubernetes.io/name=pi-ingest --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'; }
unhealthy_other() { kubectl get pods -A --no-headers 2>/dev/null | awk -v ns="$ns" '$1!=ns && $4!="Running" && $4!="Completed" && $4!="Succeeded"' | wc -l | tr -d ' '; }
pressure() { kubectl get nodes -o json | jq -r '[.items[].status.conditions[] | select((.type|test("Pressure")) and .status=="True") | .type] | join(",")'; }
base_unhealthy=$(unhealthy_other); echo "$(now) baseline unhealthy-other=$base_unhealthy" >>"$here/raw/timeline.log"

abort_all() {
  echo "$(now) ABORT: $1" >>"$here/raw/timeline.log"
  awk '{print $2}' "$here/raw/sessions.txt" | grep -E '^[0-9a-f-]{36}$' | while read -r id; do
    kubectl -n $ns exec -i "$(ingest)" -c ingest -- node - call alice DELETE "/sessions/$id" <"$here/../../tests/e2e/client.mjs" >/dev/null
  done
  touch "$here/raw/ABORTED"
}

( while :; do
    o=$(kubectl -n $ns get pod -l app.kubernetes.io/instance=pi-orchestrator -o jsonpath='{.items[0].metadata.name} {.items[0].status.containerStatuses[0].restartCount} {.items[0].status.containerStatuses[0].lastState.terminated.reason}' 2>/dev/null)
    mem=$(kubectl -n $ns exec deploy/pi-orchestrator -c orchestrator -- cat /sys/fs/cgroup/memory.current 2>/dev/null || echo NA)
    phases=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pi-sandbox --no-headers 2>/dev/null | awk '{c[$3]++} END{for(k in c) printf "%s=%d ",k,c[k]}')
    claims=$(kubectl -n $ns get sandboxclaims --no-headers 2>/dev/null | wc -l | tr -d ' ')
    pend=$(kubectl -n $ns exec pi-pg-1 -c postgres -- psql -U postgres -d app -At -c "select count(*) filter (where status='pending'), count(*) filter (where status='failed') from inbox.events where created_at > now() - interval '3 hours'" 2>/dev/null | tr '|' '/')
    ing=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pi-ingest --no-headers 2>/dev/null | awk '{s+=$4} END{print s+0}')
    uo=$(unhealthy_other); pr=$(pressure)
    echo "$(now) orch=[$o] mem_mib=$([[ $mem == NA ]] && echo NA || echo $((mem/1048576))) claims=$claims sandbox_pods=[${phases}] inbox_pending/failed=$pend ingest_restarts=$ing unhealthy_other=$uo pressure=[$pr]"
    if [[ -n $pr ]] && [[ ! -e "$here/raw/ABORTED" ]]; then abort_all "node pressure $pr"; fi
    if (( uo > base_unhealthy + 2 )) && [[ ! -e "$here/raw/ABORTED" ]]; then abort_all "unhealthy pods outside cela-dev: $uo (baseline $base_unhealthy)"; fi
    sleep 15
  done ) >>"$here/raw/resources.log" 2>&1 &
sampler=$!

echo "$(now) burst-start" >>"$here/raw/timeline.log"
kubectl -n $ns exec -i "$(ingest)" -c ingest -- node - "${REPO:?set REPO to your test owner/repo}" <"$here/create-all.mjs" >"$here/raw/sessions.txt" 2>&1
echo "$(now) burst-done created=$(grep -cE ' [0-9a-f-]{36} ' "$here/raw/sessions.txt") errors=$(grep -c ERROR "$here/raw/sessions.txt")" >>"$here/raw/timeline.log"

deadline=$(( $(date +%s) + ${MAX_SECONDS:-3600} ))
while (( $(date +%s) < deadline )) && [[ ! -e "$here/raw/ABORTED" ]]; do
  specs=()
  while read -r label id _; do
    [[ $id =~ ^[0-9a-f-]{36}$ ]] || continue
    f="$here/raw/$label.stream"; grep -q "^DONE" "$f" 2>/dev/null && continue
    last=$(grep -o '^ENTRY [0-9]*' "$f" 2>/dev/null | tail -1 | awk '{print $2}')
    specs+=("$label=$id${last:+@$last}")
  done <"$here/raw/sessions.txt"
  (( ${#specs[@]} == 0 )) && break
  echo "$(now) follow ${#specs[@]} open" >>"$here/raw/timeline.log"
  kubectl -n $ns exec -i "$(ingest)" -c ingest -- node - alice "${specs[@]}" <"$here/multi-stream.mjs" 2>&1 |
    while IFS= read -r line; do
      label=${line%% *}; rest=${line#* }
      if [[ $label =~ ^[0-9][0-9]- ]]; then
        echo "$rest" >>"$here/raw/$label.stream"
        [[ $rest == DONE ]] && echo "$(now) $label done" >>"$here/raw/timeline.log"
      else echo "$(now) other: $line" >>"$here/raw/timeline.log"; fi
    done
  echo "$(now) follower exited" >>"$here/raw/timeline.log"; sleep 5
done
sleep 30; kill $sampler 2>/dev/null
echo "$(now) all-done done=$(grep -c ' done$' "$here/raw/timeline.log")" >>"$here/raw/timeline.log"
