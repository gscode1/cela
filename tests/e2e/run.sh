#!/usr/bin/env bash
# Single entry point for the e2e suites: tests/e2e/run.sh <smoke|phase1|phase3|phase4|phase4b|phase4c|mcp|all>
#   smoke   fast suite for every change (about 5 minutes): create/send/stream, dedup, auth, delete (one sandbox tool call)
#   phase4b per-session models, allowlist, terminal failure on rejected credentials; REAL_MODEL=1 adds two real
#           OpenAI Codex turns through OneCLI (spend)
#   phase4c optional repo workspace through OneCLI + a repo-scoped GitHub App token; needs REPO_A and REPO_B
#           (owner/name, private, in the App installation), otherwise most tests SKIP. Not part of `all`.
#   mcp     native remote MCP tools through the OneCLI gateway (issue #39): a scripted session calls tool_search and a
#           DeepWiki tool. Needs the internet, PI_MCP_SERVERS with deepwiki on the orchestrator and the OneCLI host rule
#           for mcp.deepwiki.com, otherwise its tests SKIP. Not part of `all`.
#   all     the full failure suite: phase1, phase3, phase4 and phase4b (the real-model test only with REAL_MODEL=1)
#
# The suites run IN the cluster, as a Kubernetes Job (ServiceAccount e2e-driver, namespace pi-durable-poc), so a
# result never depends on the laptop's network. The Mac does only this:
#   1. build and push code: pnpm builds, deploy/push-code.sh and push-ingest.sh, the Phase 1 bundle, the driver scripts
#   2. create the Job
#   3. wait for it with `kubectl wait` and read the result from the Job status plus the final logs
# The live log stream is for watching only. If it drops, nothing changes: the verdict comes from the Job status and
# whatever the stream missed is printed from the final `kubectl logs`. No test is retried.
#
# Current kubectl context, namespace pi-durable-poc, nothing else is touched. Exit: 0 all green, 1 a suite failed,
# 2 the Mac lost contact before the Job finished (the Job is left running; see the message for how to read it).
# The Job and its pods are deleted at the end (and ttlSecondsAfterFinished removes them if this script is killed).
set -euo pipefail

# Public driver image, pinned by digest (multi-arch index with linux/arm64): bash, curl, jq, openssl, kubectl 1.36.
IMAGE=docker.io/alpine/k8s:1.36.2@sha256:44ef4942e171939b9c665a4a84beb80e2dcdb9a24330d4651cfdfd2e9deecc47

ctx=${KUBE_CONTEXT:-}
ns=pi-durable-poc
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n## %s\n' "$*"; }

only=${ONLY:-} # ONLY="a,b" runs just those tests of the phase; smoke sets its own list
label=""
started=$(date +%s)
case ${1:-} in
smoke)
  phases=(phase4)
  only="create-send-stream,dedup,auth,delete"
  label=smoke
  ;;
phase1) phases=(phase1) ;;
phase3) phases=(phase3) ;;
phase4) phases=(phase4) ;;
phase4b) phases=(phase4b) ;;
phase4c) phases=(phase4c) ;;
mcp) phases=(mcp) ;;
all) phases=(phase1 phase3 phase4 phase4b) ;;
*)
  echo "usage: tests/e2e/run.sh <smoke|phase1|phase3|phase4|phase4b|phase4c|mcp|all>" >&2
  exit 64
  ;;
esac
has_phase() { local p; for p in "${phases[@]}"; do [[ $p == "$1" ]] && return 0; done; return 1; }

work=$(mktemp -d)
job=""
keep_job=0
mcp_env_set=0
cleanup() {
  # The mcp suite sets PI_MCP_SERVERS on the Deployment for its run; put the base (empty) value back.
  if [[ $mcp_env_set -eq 1 ]]; then
    k set env deploy/pi-orchestrator PI_MCP_SERVERS= >/dev/null 2>&1 || true
    k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null 2>&1 || echo "could not restore PI_MCP_SERVERS=; run: kubectl -n $ns set env deploy/pi-orchestrator PI_MCP_SERVERS=" >&2
  fi
  pkill -f "logs -f job/e2e-driver" 2>/dev/null || true
  if [[ -n $job && $keep_job -eq 0 ]]; then
    k delete job "$job" --ignore-not-found --cascade=foreground --wait=true >/dev/null 2>&1 || true
  fi
  k delete pod e2e-driver-loader --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

# Empty KUBE_CONTEXT means the current context; fail early if there is none.
kubectl config get-contexts ${ctx:-"$(kubectl config current-context)"} >/dev/null

# Per-sandbox sandboxd tokens (docs/decisions/0001-per-sandbox-sandboxd-token.md): every suite creates claims that
# carry a token hash, which the template accepts only with envVarsInjectionPolicy Allowed.
[[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}' 2>/dev/null) ]] || {
  echo "secret sandboxd-auth has no master key: run deploy/gen-secret.sh" >&2
  exit 1
}
[[ $(k get sandboxtemplate pi-env-template -o jsonpath='{.spec.envVarsInjectionPolicy}' 2>/dev/null) == Allowed ]] || {
  echo "SandboxTemplate pi-env-template does not allow claim env: apply deploy/ (kubectl apply -k deploy)" >&2
  exit 1
}

# ------------------------------------------------------------------ 1. build and push (Mac-only work)
log "driver identity, RBAC and code volume"
kubectl ${ctx:+--context="$ctx"} apply -k "$here/driver" >/dev/null
# A Job left by an earlier killed run would hold the code volume (ReadWriteOnce).
k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --cascade=foreground --wait=true >/dev/null

if has_phase phase3 || has_phase phase4 || has_phase phase4b || has_phase phase4c || has_phase mcp; then
  log "test overlay, api-auth secret, orchestrator and ingest code (build + push on the Mac)"
  "$root/deploy/gen-api-secret.sh" >/dev/null
  # CiliumNetworkPolicies first (docs/network-policy.md apply order); they need the Cilium CRDs, so they are not in the base.
  kubectl ${ctx:+--context="$ctx"} apply -k "$root/deploy/cilium" >/dev/null
  kubectl ${ctx:+--context="$ctx"} apply -k "$here/deploy" >/dev/null
  "$root/deploy/push-code.sh" >/dev/null
  "$root/deploy/push-ingest.sh" >/dev/null
fi

# The overlay above applies the base Deployment, which has PI_MCP_SERVERS empty, so the mcp suite sets it here, after
# the overlay. MCP_SERVERS overrides the JSON (default: DeepWiki); MCP_SERVERS=off leaves it empty and the suite SKIPs.
if has_phase mcp && [[ ${MCP_SERVERS:-} != off ]]; then
  log "PI_MCP_SERVERS on the orchestrator for this run (restored empty at the end)"
  mcp_env_set=1
  # A variable, not an inline default: the first `}` of the JSON would end the ${...:-...} expansion.
  mcp_default='[{"name":"deepwiki","url":"https://mcp.deepwiki.com/mcp"}]'
  k set env deploy/pi-orchestrator "PI_MCP_SERVERS=${MCP_SERVERS:-$mcp_default}" >/dev/null
  k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null
fi

log "stage the driver scripts (and the Phase 1 bundle for phase1)"
stage=$work/stage
mkdir -p "$stage/tests/e2e" "$stage/deploy"
cp "$here"/run-phase*.sh "$here"/run-mcp.sh "$here/client.mjs" "$here/client-4b.mjs" "$here/runner-pod.yaml" "$stage/tests/e2e/"
cp "$root/deploy/gen-api-secret.sh" "$stage/deploy/"
if has_phase phase1; then
  (cd "$root" && pnpm install --frozen-lockfile >/dev/null && pnpm --filter "@pi-durable-k8s/sandbox-env..." build >/dev/null)
  (cd "$root" && pnpm --filter @pi-durable-k8s/sandbox-env deploy --prod=false "$work/bundle" >/dev/null)
  COPYFILE_DISABLE=1 tar --no-xattrs -czf "$stage/bundle.tgz" -C "$work/bundle" .
  rm -rf "$work/bundle"
fi

log "load the driver volume e2e-driver"
k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: e2e-driver-loader
  labels: { app.kubernetes.io/name: e2e-driver-loader }
spec:
  restartPolicy: Never
  securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: loader
      image: $IMAGE
      command: [sleep, "900"]
      securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
      resources:
        requests: { cpu: 10m, memory: 32Mi }
        limits: { cpu: 200m, memory: 128Mi }
      volumeMounts: [{ name: driver, mountPath: /driver }]
  volumes:
    - name: driver
      persistentVolumeClaim: { claimName: e2e-driver }
EOF
k wait --for=condition=Ready pod/e2e-driver-loader --timeout=300s >/dev/null
tar -cf - -C "$stage" . | k exec -i e2e-driver-loader -- sh -c 'rm -rf /driver/* && tar xf - -C /driver'
if [[ -f $stage/bundle.tgz ]]; then
  want=$(shasum -a 256 "$stage/bundle.tgz" | awk '{print $1}')
  got=$(k exec e2e-driver-loader -- sha256sum /driver/bundle.tgz | awk '{print $1}')
  [[ $want == "$got" ]] || { echo "bundle upload is corrupt (sha256 differs)" >&2; exit 1; }
fi
# Every selected suite's script must be on the volume before a Job is created for it.
for p in "${phases[@]}"; do
  k exec e2e-driver-loader -- test -f "/driver/tests/e2e/run-$p.sh" || { echo "run-$p.sh is not on the driver volume (is it staged above?)" >&2; exit 1; }
done
k delete pod e2e-driver-loader --wait=true >/dev/null

# ------------------------------------------------------------------ 2+3. create the Job, wait, read the verdict
overall=0
verdicts=()
run_phase() { # phase1|phase3|phase4
  local phase=$1 w1 w2 follow_pid conds printed
  local name=${label:-$phase}
  job=e2e-driver-$name-$(date +%s)
  keep_job=0
  log "$name: Job $job"
  sed -e "s|__JOB__|$job|" -e "s|__PHASE__|$phase|" -e "s|__IMAGE__|$IMAGE|" -e "s|__ONLY__|$only|" -e "s|__REAL_MODEL__|${REAL_MODEL:-0}|" -e "s|__REPO_A__|${REPO_A:-}|" -e "s|__REPO_B__|${REPO_B:-}|" "$here/job.yaml.tpl" | k create -f - >/dev/null

  # Live view only. Best effort: if this stream dies the run is unaffected; the final logs fill the gap.
  (
    # The stop file ends the wait when the verdict is in and the pod never produced logs (or is gone).
    until k logs "job/$job" --tail=1 >/dev/null 2>&1; do
      [[ -e $work/$name.stop ]] && exit 0
      sleep 2
    done
    k logs -f "job/$job" 2>&1 | tee "$work/$name.follow"
  ) &
  follow_pid=$!

  # The verdict: wait for the Job to reach Complete or Failed (activeDeadlineSeconds bounds it at 1 h).
  k wait --for=condition=complete "job/$job" --timeout=3700s >/dev/null 2>&1 &
  w1=$!
  k wait --for=condition=failed "job/$job" --timeout=3700s >/dev/null 2>&1 &
  w2=$!
  while kill -0 "$w1" 2>/dev/null && kill -0 "$w2" 2>/dev/null; do sleep 1; done
  kill "$w1" "$w2" 2>/dev/null || true
  wait "$w1" "$w2" 2>/dev/null || true

  conds=$(k get job "$job" -o jsonpath='{range .status.conditions[*]}{.type}={.status} {end}' 2>/dev/null || true)

  # Let the stream flush its tail, then print whatever it did not show from the final logs.
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$follow_pid" 2>/dev/null || break; sleep 1; done
  touch "$work/$name.stop"
  pkill -f "logs -f job/$job" 2>/dev/null || true
  kill "$follow_pid" 2>/dev/null || true # no-op when it already ended; stops a follower stuck in its wait loop
  wait "$follow_pid" 2>/dev/null || true
  if k logs "job/$job" >"$work/$name.full" 2>&1; then
    printed=$(wc -l <"$work/$name.follow" 2>/dev/null || echo 0)
    if [[ $(wc -l <"$work/$name.full") -gt ${printed// /} ]]; then
      printf '\n-- log stream was short (%s lines of %s); rest from the final logs --\n' "${printed// /}" "$(wc -l <"$work/$name.full" | tr -d ' ')"
      tail -n +"$((${printed// /} + 1))" "$work/$name.full"
    fi
    printf '\n-- %s result (final logs) --\n' "$name"
    sed -n '/^== RESULT/,$p' "$work/$name.full"
    grep -E '^(ALL PHASE 1 E2E CHECKS PASSED|PHASE [34]:|PHASE 4[BC]:)' "$work/$name.full" | sed 's/^/   /' || true
  else
    echo "-- final logs could not be read (the verdict below comes from the Job status) --"
  fi

  case $conds in
  *Complete=True*)
    verdicts+=("$name: PASS ($job)")
    ;;
  *Failed=True*)
    verdicts+=("$name: FAIL ($job)")
    overall=1
    ;;
  *)
    verdicts+=("$name: INCONCLUSIVE, Job status unreadable or unfinished; Job $job is still in the cluster")
    keep_job=1
    [[ $overall -eq 1 ]] || overall=2
    ;;
  esac
  if [[ $keep_job -eq 0 ]]; then
    k delete job "$job" --ignore-not-found --cascade=foreground --wait=true >/dev/null 2>&1 || true
  fi
  job=""
}

for phase in "${phases[@]}"; do
  run_phase "$phase"
  # An unfinished Job may still use the driver volume and cluster resources; do not start the next phase on top.
  if [[ $keep_job -eq 1 ]]; then
    echo "stopping: the previous Job is unfinished, so the remaining phases were not run" >&2
    verdicts+=("remaining phases: NOT RUN")
    break
  fi
done

log "SUMMARY"
printf '%s\n' "${verdicts[@]}"
echo "wall clock: $(($(date +%s) - started)) s"
exit "$overall"
