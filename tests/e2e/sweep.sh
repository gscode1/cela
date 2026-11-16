#!/usr/bin/env bash
# Delete orphaned e2e run namespaces: tests/e2e/sweep.sh [max-age-hours]   (default SWEEP_MAX_AGE_HOURS or 6)
# A run namespace is deleted by tests/e2e/run.sh itself; this catches the ones a killed run, a lost laptop or KEEP_NS=1
# left behind. A namespace qualifies only if ALL of these hold, so the long-lived pi-durable-poc can never match:
#   - its name starts with pi-e2e-
#   - it carries the label pi-durable-e2e=true (set by run.sh when it creates the namespace)
#   - it was created more than max-age hours ago (a run is bounded to 1 h per suite by the Job's activeDeadlineSeconds)
# DRY_RUN=1 only lists them. KUBE_CONTEXT picks the cluster (default: the current context).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
hours=${1:-${SWEEP_MAX_AGE_HOURS:-6}}
[[ $hours =~ ^[0-9]+$ ]] || { echo "usage: tests/e2e/sweep.sh [max-age-hours]  (a whole number)" >&2; exit 64; }
kc() { kubectl ${ctx:+--context="$ctx"} "$@"; }

cutoff=$(($(date +%s) - hours * 3600))
list=$(kc get namespaces -l pi-durable-e2e=true -o json)
old=$(jq -r --argjson cutoff "$cutoff" '
  .items[]
  | select(.metadata.name | startswith("pi-e2e-"))
  | select((.metadata.creationTimestamp | fromdateiso8601) < $cutoff)
  | .metadata.name' <<<"$list")

if [[ -z $old ]]; then
  echo "sweep: no e2e namespace older than ${hours} h"
  exit 0
fi
failed=0
while read -r name; do
  [[ -n $name ]] || continue
  if [[ ${DRY_RUN:-0} == 1 ]]; then
    echo "sweep: would delete namespace $name (older than ${hours} h)"
  elif kc delete namespace "$name" --ignore-not-found --wait=false >/dev/null; then
    echo "sweep: deleting namespace $name (older than ${hours} h)"
  else
    echo "sweep: could not delete namespace $name" >&2
    failed=1
  fi
done <<<"$old"
exit "$failed"
