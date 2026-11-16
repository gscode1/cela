#!/usr/bin/env bash
# Single entry point for the e2e suites: tests/e2e/run.sh <smoke|phase1|phase3|phase4|phase4b|phase4c|mcp|all>
#   smoke   fast suite for every change (about 5 minutes): create/send/stream, dedup, auth, delete (one sandbox tool call)
#   phase4b per-session models, allowlist, terminal failure on rejected credentials; REAL_MODEL=1 adds two real
#           OpenAI Codex turns through OneCLI (spend)
#   phase4c optional repo workspace through OneCLI + a repo-scoped GitHub App token; needs REPO_A and REPO_B
#           (owner/name, private, in the App installation), otherwise most tests SKIP. Not part of `all`.
#   mcp     native remote MCP tools through the OneCLI gateway (issues #39, #40): the suite adds DeepWiki to the catalog
#           through the admin API (no restart), a scripted session calls tool_search and a DeepWiki tool, and disabling
#           the server makes a new call return tool_unavailable. Needs the internet and the OneCLI host rule for
#           mcp.deepwiki.com. The suite removes the server again at the end. Not part of `all`.
#   all     the full failure suite: phase1, phase3, phase4 and phase4b (the real-model test only with REAL_MODEL=1)
#
# Every run gets its own namespace, pi-e2e-<run id> (docs/e2e.md): its own Postgres, orchestrator, ingest, sandbox
# template, RBAC, network policies and secrets, deleted again at the end. Two runs (two branches) can therefore run at the
# same time, and the long-lived namespace pi-durable-poc is never touched: this script refuses any other prefix.
#   KEEP_NS=1          keep the namespace after the run (debugging); the script prints how to delete it
#   KEEP_NS_ON_FAIL=1  keep it only when the run did not pass
#   RUN_ID=<id>        use pi-e2e-<id> (default: 6 random hex digits); an existing e2e namespace is reused (re-run in a kept one)
#   SKIP_SWEEP=1       do not delete e2e namespaces older than SWEEP_MAX_AGE_HOURS (default 6, tests/e2e/sweep.sh) first
# An unfinished Job (exit 2) always keeps the namespace so the Job can still be read.
#
# Within a suite, independent tests run side by side, at most E2E_PARALLEL at a time (default 4; 1 = one by one); tests that
# restart or kill the orchestrator or depend on shared state run alone afterwards. See tests/e2e/fns.sh.
#
# The suites run IN the cluster, as a Kubernetes Job (ServiceAccount e2e-driver, in the run namespace), so a
# result never depends on the laptop's network. The Mac does only this:
#   1. create the namespace and the stack, the secrets, build and push code (pnpm builds, deploy/push-code.sh and
#      push-ingest.sh), the Phase 1 bundle, the driver scripts
#   2. create the Job
#   3. wait for it with `kubectl wait` and read the result from the Job status plus the final logs
# The live log stream is for watching only. If it drops, nothing changes: the verdict comes from the Job status and
# whatever the stream missed is printed from the final `kubectl logs`. No test is retried.
#
# Current kubectl context (KUBE_CONTEXT); only the run namespace is touched. Exit: 0 all green, 1 a suite failed,
# 2 the Mac lost contact before the Job finished (the Job is left running; see the message for how to read it).
# The namespace, with the Job and its pods, is deleted at the end; if this script is killed, `tests/e2e/sweep.sh` removes it.
set -euo pipefail

# Public driver image, pinned by digest (multi-arch index with linux/arm64): bash, curl, jq, openssl, kubectl 1.36.
IMAGE=docker.io/alpine/k8s:1.36.2@sha256:44ef4942e171939b9c665a4a84beb80e2dcdb9a24330d4651cfdfd2e9deecc47

ctx=${KUBE_CONTEXT:-}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
run_id=${RUN_ID:-$(openssl rand -hex 3)}
ns=pi-e2e-$run_id
# The prefix is the whole safety net: nothing below may ever run against pi-durable-poc or any other namespace.
[[ $ns =~ ^pi-e2e-[a-z0-9]([a-z0-9-]{0,40}[a-z0-9])?$ ]] || { echo "bad RUN_ID '$run_id': the namespace must be pi-e2e-<lowercase letters, digits, dashes>" >&2; exit 64; }
# This run's OneCLI name prefix. The OneCLI workspace is shared with pi-durable-poc and every other run, and each
# orchestrator's orphan sweep revokes the agents it does not know, so every stack needs its own (ADR 0013). The run
# id is lowercase letters, digits and dashes, so the prefix passes the orchestrator's validation.
onecli_prefix=pi-e2e-$run_id-
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
kc() { kubectl ${ctx:+--context="$ctx"} "$@"; }
log() { printf '\n## %s\n' "$*"; }

only=${ONLY:-} # ONLY="a,b" runs just those tests of the phase; smoke sets its own list
[[ ${E2E_PARALLEL:-4} =~ ^[1-9][0-9]*$ ]] || { echo "E2E_PARALLEL must be a positive integer" >&2; exit 64; }
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
ns_touched=0 # 1 once this run may have created or reused the namespace; the trap then decides keep or delete
cleanup() {
  local rc=$? gone=0 _
  trap - EXIT
  # Match on the namespace too: another run's log follower on this machine must survive.
  pkill -f -- "-n $ns logs -f job/e2e-driver" 2>/dev/null || true
  rm -rf "$work"
  [[ $ns_touched -eq 1 ]] || return "$rc"
  # What a kept namespace must not hold on to: the loader pod and a finished Job mount the ReadWriteOnce driver volume.
  # An unfinished Job (keep_job=1) stays for the reader.
  if [[ $keep_job -eq 0 ]]; then k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
  k delete pod e2e-driver-loader --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [[ ${KEEP_NS:-0} == 1 || ( $rc -ne 0 && ${KEEP_NS_ON_FAIL:-0} == 1 ) || $rc -eq 2 ]]; then
    printf '\nnamespace %s kept. Delete it with: kubectl %s delete namespace %s (tests/e2e/sweep.sh removes it after %s h)\n' \
      "$ns" "${ctx:+--context=$ctx}" "$ns" "${SWEEP_MAX_AGE_HOURS:-6}" >&2
    return "$rc"
  fi
  # Deleting the namespace removes the Job and its pods, the CNPG cluster, the PVCs, sandboxes and secrets with it.
  log "delete namespace $ns"
  kc delete namespace "$ns" --ignore-not-found --wait=false >/dev/null 2>&1 || echo "could not delete namespace $ns; run tests/e2e/sweep.sh" >&2
  for _ in $(seq 1 "${NS_DELETE_WAIT_SECONDS:-300}"); do
    kc get namespace "$ns" >/dev/null 2>&1 || { gone=1; break; }
    sleep 1
  done
  [[ $gone -eq 1 ]] && echo "namespace $ns is gone" || echo "namespace $ns is still terminating; tests/e2e/sweep.sh will retry" >&2
  return "$rc"
}
trap cleanup EXIT

# Empty KUBE_CONTEXT means the current context; fail early if there is none.
kubectl config get-contexts ${ctx:-"$(kubectl config current-context)"} >/dev/null

# ------------------------------------------------------------------ 0. the run namespace and its stack
# Orphans of killed runs go first (this run's namespace does not exist yet). Never fails the run.
[[ ${SKIP_SWEEP:-0} == 1 ]] || "$here/sweep.sh" || echo "sweep failed (ignored)" >&2

branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -c 'A-Za-z0-9._/\n-' '_' || true)
if kc get namespace "$ns" >/dev/null 2>&1; then
  [[ -n $(kc get namespace "$ns" -l pi-durable-e2e=true -o name 2>/dev/null) ]] || {
    echo "namespace $ns exists but is not an e2e run namespace (label pi-durable-e2e=true); refusing to use it" >&2
    exit 1
  }
  log "reusing namespace $ns"
else
  log "create namespace $ns"
fi
ns_touched=1
# The label is what the OneCLI ingress policy (argo-c2, docs/e2e.md) and the sweeper select on. It must exist before the
# first Pod does: Cilium computes a Pod's identity from its namespace labels when the Pod starts.
kc apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $ns
  labels:
    pi-durable-e2e: "true"
    app.kubernetes.io/managed-by: pi-e2e
  annotations:
    pi-durable-e2e/branch: "${branch:-unknown}"
    pi-durable-e2e/suite: "${1:-}"
EOF

# One overlay per run: the repository's stack (tests/e2e/deploy, which includes deploy/ and tests/e2e/driver) with
# `namespace:` set. kustomize wants relative paths and resolves symlinks (a macOS temp dir is one), so both ends are resolved first.
relpath() { python3 -c 'import os, sys; print(os.path.relpath(os.path.realpath(sys.argv[1]), os.path.realpath(sys.argv[2])))' "$1" "$2"; }
mkdir -p "$work/stack" "$work/cilium"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: %s\nresources:\n  - %s\n' \
  "$ns" "$(relpath "$here/deploy" "$work/stack")" >"$work/stack/kustomization.yaml"
# The orchestrator's OneCLI name prefix, next to the namespace: only this overlay knows the run id.
cat >>"$work/stack/kustomization.yaml" <<EOF
patches:
  - target: { kind: Deployment, name: pi-orchestrator }
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/env/-
        value: { name: PI_ONECLI_NAME_PREFIX, value: "$onecli_prefix" }
EOF
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: %s\nresources:\n  - %s\n' \
  "$ns" "$(relpath "$root/deploy/cilium" "$work/cilium")" >"$work/cilium/kustomization.yaml"

log "stack: CiliumNetworkPolicies, network policies, RBAC, Postgres, template, ingest, orchestrator (at 0), driver identity"
# CiliumNetworkPolicies first (docs/network-policy.md apply order); they need the Cilium CRDs, so they are not in the base.
kc apply -k "$work/cilium" >/dev/null
kc apply -k "$work/stack" >/dev/null
# A Job left by an earlier killed run would hold the code volume (ReadWriteOnce).
k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --cascade=foreground --wait=true >/dev/null

log "secrets"
# sandboxd-auth and api-auth are random per run, made in the namespace (never copied from pi-durable-poc, never printed).
NAMESPACE=$ns "$root/deploy/gen-secret.sh" >/dev/null
NAMESPACE=$ns "$root/deploy/gen-api-secret.sh" >/dev/null
# pi-onecli, pi-onecli-admin and pi-github-app are ExternalSecrets on the ClusterSecretStore: ESO copies them in. The
# orchestrator reads them optionally and only once at start, so they must be Ready before it starts (push-code.sh below).
if ! k wait --for=condition=Ready externalsecret --all --timeout=120s >/dev/null 2>&1; then
  echo "WARNING: some ExternalSecrets are not Ready (kubectl -n $ns get externalsecret); suites that need OneCLI or GitHub will SKIP or fail" >&2
fi
# The gateway CA (public) from OneCLI itself, for the orchestrator's model calls and MCP. Only the suites that use OneCLI need it.
if ! NAMESPACE=$ns KUBE_CONTEXT=$ctx "$root/deploy/fetch-onecli-ca.sh" >"$work/ca.log" 2>&1; then
  if [[ ${REAL_MODEL:-0} == 1 ]] || has_phase phase4c || has_phase mcp; then
    cat "$work/ca.log" >&2
    echo "could not fetch the OneCLI CA, and this suite needs it" >&2
    exit 1
  fi
  echo "WARNING: could not fetch the OneCLI CA (ignored: the suites selected do not call OneCLI)" >&2
fi

# Per-sandbox sandboxd tokens (docs/decisions/0001-per-sandbox-sandboxd-token.md): every suite creates claims that
# carry a token hash, which the template accepts only with envVarsInjectionPolicy Allowed.
[[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}' 2>/dev/null) ]] || {
  echo "secret sandboxd-auth has no master key in $ns" >&2
  exit 1
}
[[ $(k get sandboxtemplate pi-env-template -o jsonpath='{.spec.envVarsInjectionPolicy}' 2>/dev/null) == Allowed ]] || {
  echo "SandboxTemplate pi-env-template in $ns does not allow claim env" >&2
  exit 1
}

if has_phase phase3 || has_phase phase4 || has_phase phase4b || has_phase phase4c || has_phase mcp; then
  log "orchestrator and ingest code (build + push on the Mac)"
  NAMESPACE=$ns "$root/deploy/push-code.sh" >/dev/null
  NAMESPACE=$ns "$root/deploy/push-ingest.sh" >/dev/null
fi

log "stage the driver scripts (and the Phase 1 bundle for phase1)"
stage=$work/stage
mkdir -p "$stage/tests/e2e" "$stage/deploy"
cp "$here"/run-phase*.sh "$here"/run-mcp.sh "$here/fns.sh" "$here/client.mjs" "$here/client-4b.mjs" "$here/runner-pod.yaml" "$stage/tests/e2e/"
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
  sed -e "s|__JOB__|$job|" -e "s|__PHASE__|$phase|" -e "s|__IMAGE__|$IMAGE|" -e "s|__ONLY__|$only|" -e "s|__E2E_PARALLEL__|${E2E_PARALLEL:-4}|" -e "s|__REAL_MODEL__|${REAL_MODEL:-0}|" -e "s|__REPO_A__|${REPO_A:-}|" -e "s|__REPO_B__|${REPO_B:-}|" -e "s|__ONECLI_NAME_PREFIX__|$onecli_prefix|" "$here/job.yaml.tpl" | k create -f - >/dev/null

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
  pkill -f -- "-n $ns logs -f job/$job" 2>/dev/null || true
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
