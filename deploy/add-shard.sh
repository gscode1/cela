#!/usr/bin/env bash
# Adds orchestrator shard K (docs/decisions/0017-schema-sharding.md): a Deployment `pi-orchestrator-K` cloned from the live
# `pi-orchestrator` (shard 0) with PI_ORCH_SHARD=K, so its env, volumes, image and switches cannot drift from shard 0. It
# owns the Postgres schema `<PI_DURABLE_SCHEMA>_sK` (created at its start) and runs on the node that holds the
# ReadWriteOnce code volume (podAffinity on the name label). Also creates the Services `pi-orchestrator-0` and
# `pi-orchestrator-K`, and points ingest at the shards: PI_ORCH_URL gets the {shard} placeholder and PI_ORCH_SHARDS
# becomes at least K+1. Raising PI_ORCH_SHARDS without the Deployment would strand new sessions as `pending`, so this
# script is the one place that sets both. PI_ORCH_SHARDS must never decrease: a session stays on its shard.
# The new Deployment starts with shard 0's replica count; deploy/push-code.sh brings every shard up on the same code.
# NAMESPACE (default pi-durable-poc) and KUBE_CONTEXT pick the target; every e2e run passes its own pi-e2e-<id>.
# Usage: deploy/add-shard.sh <K>     (K is an integer of 1 or more; safe to run again)
set -euo pipefail

shard=${1:-}
[[ $shard =~ ^[1-9][0-9]{0,2}$ ]] || { echo "usage: deploy/add-shard.sh <K>   (K: integer of 1 or more)" >&2; exit 64; }
ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
name=pi-orchestrator-$shard

# Shards are numbered without gaps: ingest assigns sessions to every shard below PI_ORCH_SHARDS, and one without a
# Deployment would strand them as `pending`. So every lower shard must already exist.
for ((j = 1; j < shard; j++)); do
  k get deployment "pi-orchestrator-$j" >/dev/null 2>&1 && k get service "pi-orchestrator-$j" >/dev/null 2>&1 || {
    echo "cannot add shard $shard: shard $j (Deployment and Service pi-orchestrator-$j) does not exist; add shards in order" >&2
    exit 1
  }
done

service() { # name instance
  cat <<YAML
apiVersion: v1
kind: Service
metadata:
  name: $1
spec:
  selector:
    app.kubernetes.io/name: pi-orchestrator
    app.kubernetes.io/instance: $2
  ports:
    - { name: control, port: 8081, targetPort: control }
YAML
}

k get deployment pi-orchestrator -o json |
  jq --arg name "$name" --arg shard "$shard" '
    del(.status, .metadata.uid, .metadata.resourceVersion, .metadata.generation, .metadata.creationTimestamp,
        .metadata.annotations, .metadata.managedFields, .metadata.ownerReferences)
    | .metadata.name = $name
    | .spec.selector.matchLabels["app.kubernetes.io/instance"] = $name
    | .spec.template.metadata.labels["app.kubernetes.io/instance"] = $name
    | .spec.strategy = {type: "Recreate"}
    | .spec.template.spec.containers[0].env |=
        (map(select(.name != "PI_ORCH_SHARD")) + [{name: "PI_ORCH_SHARD", value: $shard}])
    | .spec.template.spec.affinity.podAffinity.requiredDuringSchedulingIgnoredDuringExecution =
        [{topologyKey: "kubernetes.io/hostname",
          labelSelector: {matchLabels: {"app.kubernetes.io/name": "pi-orchestrator"}}}]' |
  k apply -f - >/dev/null
{
  service pi-orchestrator-0 pi-orchestrator
  echo ---
  service "$name" "$name"
} | k apply -f - >/dev/null

# Ingest: route by shard and know how many there are. Never fewer than are already configured.
current=$(k get deployment pi-ingest -o json |
  jq -r '[.spec.template.spec.containers[0].env[]? | select(.name == "PI_ORCH_SHARDS") | .value][0] // "1"')
want=$((shard + 1))
[[ $current =~ ^[0-9]+$ && $current -gt $want ]] && want=$current
k set env deployment/pi-ingest PI_ORCH_URL='http://pi-orchestrator-{shard}:8081' PI_ORCH_SHARDS="$want" >/dev/null
echo "shard $shard added: deployment $name, services pi-orchestrator-0 and $name, ingest PI_ORCH_SHARDS=$want"
