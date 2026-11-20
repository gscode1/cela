#!/usr/bin/env bash
# Starts one repo session per brief, posts the brief, streams each session to raw/<n>.stream, samples resources.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$here/raw"
ctx=${KUBE_CONTEXT:-}
kubectl() { command kubectl ${ctx:+--context="$ctx"} "$@"; }
client=$here/../../tests/e2e/client.mjs
ns=${NAMESPACE:-cela-dev}
repo=${REPO:?set REPO to your test owner/repo}
ing=$(kubectl -n $ns get pod -l app.kubernetes.io/name=pi-ingest --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')
call() { kubectl -n $ns exec -i "$ing" -c ingest -- node - call alice "$@" <"$client"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Resource sampler: orchestrator memory (cgroup) and sandbox pods, every 20 s.
( while :; do
    mem=$(kubectl -n $ns exec deploy/pi-orchestrator -c orchestrator -- cat /sys/fs/cgroup/memory.current 2>/dev/null || echo NA)
    pods=$(kubectl -n $ns get pods -l app.kubernetes.io/name=pi-sandbox --no-headers 2>/dev/null | awk '{print $1":"$3}' | tr '\n' ' ')
    echo "$(now) orch_mem_bytes=$mem sandboxes=[$pods]"
    sleep 20
  done ) >"$here/raw/resources.log" 2>&1 &
sampler=$!

pids=()
for brief in "$here"/briefs/[0-9]*.md; do
  n=$(basename "$brief" .md)
  text="$(cat "$brief")

$(cat "$here/briefs/_common.md")"
  created=$(call POST /sessions "$(jq -nc --arg r "$repo" '{provider:"openai-codex", model:"gpt-6.1-terra", repo:$r}')")
  id=$(jq -r '.body.sessionId' <<<"$created")
  echo "$(now) $n session=$id created=$(jq -c .body <<<"$created")" | tee -a "$here/raw/timeline.log"
  posted=$(call POST "/sessions/$id/events" "$(jq -nc --arg t "$text" '{kind:"message", text:$t}')")
  echo "$(now) $n posted=$(jq -c .body <<<"$posted")" | tee -a "$here/raw/timeline.log"
  ( kubectl -n $ns exec -i "$ing" -c ingest -- node - stream alice "$id" --until-text END-OF-REPORT --reconnect --timeout 3600 <"$client" \
      | awk -v f="$here/raw/$n.live-count" '/^LIVE /{c++; print c > f; close(f); next} {print; fflush()}' >"$here/raw/$n.stream" 2>&1
    echo "$(now) $n stream-ended" >>"$here/raw/timeline.log" ) &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p" || true; done
kill "$sampler" 2>/dev/null || true
echo "$(now) all-done" >>"$here/raw/timeline.log"
