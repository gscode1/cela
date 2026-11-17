#!/usr/bin/env bash
# Second runner: creates the sessions that are missing, then follows all of them from ONE node process in an ingest
# pod (restarted with Last-Event-ID resume if the exec dies). Output: raw/<label>.stream, raw/timeline.log.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/raw"
ctx=${KUBE_CONTEXT:-}
kubectl() { command kubectl ${ctx:+--context="$ctx"} "$@"; }
ns=${NAMESPACE:-pi-durable-poc}; repo=${REPO:?set REPO to your test owner/repo}
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
ingest() { kubectl -n $ns get pod -l app.kubernetes.io/name=pi-ingest --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'; }
call() { kubectl -n $ns exec -i "$(ingest)" -c ingest -- node - call alice "$@" <"$here/../../tests/e2e/client.mjs"; }
sid() { grep " $1 session=" "$here/raw/timeline.log" | tail -1 | sed 's/.*session=\([0-9a-f-]*\).*/\1/'; }

( while :; do
    mem=$(kubectl -n $ns exec deploy/pi-orchestrator -c orchestrator -- cat /sys/fs/cgroup/memory.current 2>/dev/null || echo NA)
    pods=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pi-sandbox --no-headers 2>/dev/null | awk '{print $1":"$3}' | tr '\n' ' ')
    ing=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pi-ingest --no-headers 2>/dev/null | awk '{print $1":"$4}' | tr '\n' ' ')
    echo "$(now) orch_mem_bytes=$mem sandboxes=[$pods] ingest_restarts=[$ing]"
    sleep 20
  done ) >>"$here/raw/resources.log" 2>&1 &
sampler=$!

for brief in "$here"/briefs/[0-9]*.md; do
  n=$(basename "$brief" .md)
  [[ -n $(sid "$n") ]] && continue
  text="$(cat "$brief")

$(cat "$here/briefs/_common.md")"
  created=$(call POST /sessions "$(jq -nc --arg r "$repo" '{provider:"openai-codex", model:"gpt-6.1-terra", repo:$r}')")
  id=$(jq -r '.body.sessionId' <<<"$created")
  echo "$(now) $n session=$id created=$(jq -c .body <<<"$created")" >>"$here/raw/timeline.log"
  posted=$(call POST "/sessions/$id/events" "$(jq -nc --arg t "$text" '{kind:"message", text:$t}')")
  echo "$(now) $n posted=$(jq -c .body <<<"$posted")" >>"$here/raw/timeline.log"
done

deadline=$(( $(date +%s) + ${MAX_SECONDS:-4200} ))
while (( $(date +%s) < deadline )); do
  specs=(); open=0
  for brief in "$here"/briefs/[0-9]*.md; do
    n=$(basename "$brief" .md); f="$here/raw/$n.stream"
    grep -q "^DONE" "$f" 2>/dev/null && continue
    last=$(grep -o '^ENTRY [0-9]*' "$f" 2>/dev/null | tail -1 | awk '{print $2}')
    specs+=("$n=$(sid "$n")${last:+@$last}"); open=$((open+1))
  done
  (( open == 0 )) && break
  echo "$(now) follow ${specs[*]}" >>"$here/raw/timeline.log"
  kubectl -n $ns exec -i "$(ingest)" -c ingest -- node - alice "${specs[@]}" <"$here/multi-stream.mjs" 2>&1 |
    while IFS= read -r line; do
      label=${line%% *}; rest=${line#* }
      if [[ -f "$here/briefs/$label.md" ]]; then
        echo "$rest" >>"$here/raw/$label.stream"
        [[ $rest == DONE ]] && echo "$(now) $label done" >>"$here/raw/timeline.log"
      else echo "$(now) other: $line" >>"$here/raw/timeline.log"; fi
    done
  echo "$(now) exec ended, restarting" >>"$here/raw/timeline.log"; sleep 5
done
kill $sampler 2>/dev/null
echo "$(now) all-done" >>"$here/raw/timeline.log"
