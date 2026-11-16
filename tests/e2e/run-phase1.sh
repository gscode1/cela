#!/usr/bin/env bash
# Phase 1 end-to-end flow on a real cluster. Runs IN the cluster, as the e2e-driver Job started by tests/e2e/run.sh
# (ServiceAccount kubeconfig, no context). The tests themselves run in a pod (`e2e-runner`, public node image) that
# gets the code streamed in from the driver volume, so no image is pushed. The sandbox-env bundle (pnpm build) is made
# on the Mac by run.sh and sits at /driver/bundle.tgz.
#
#   1. start a fresh runner pod with the bundle
#   2. stdio smoke: 64 MiB through commands.start("cat"), SHA-256 round trip
#   3. env conformance suite against the claim this script creates (e2e-phase1, deleted again at the end)
#   4. reattach (a): write via the env, DELETE the runner pod, start a fresh one, read the file back
#   5. reattach (b): delete the sandbox Pod, wait for recreation, next env call works, file still there
#
# Needs: the pi-durable-poc namespace from deploy/ (template, warm pool) and the sandboxd-auth secret. Touches only
# that namespace. The claim gets the sha256 of its own token (HMAC of the master); the runner pod reads the master from
# the secret and derives both with sandbox-env's own functions (the driver image has no openssl, and one
# implementation is enough). Nothing secret is printed. Exits non-zero on any failure. Set KEEP_RUNNER=1 to
# leave the runner pod in place afterwards. The e2e-runner ServiceAccount and Role come from tests/e2e/driver.
set -euo pipefail

ctx=${KUBE_CONTEXT:-} # empty in the Job: kubectl then uses the in-cluster ServiceAccount config
ns=${NAMESPACE:-pi-durable-poc}
claim=${CLAIM:-e2e-phase1}
here=$(cd "$(dirname "$0")" && pwd)
bundle=${BUNDLE:-/driver/bundle.tgz}
run_id=$(date +%s)-$$
work=$(mktemp -d)
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  rm -rf "$work"
  if [[ -z "${KEEP_RUNNER:-}" ]]; then
    k delete pod e2e-runner --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  # The claim is this run's own; its workspace PVC (owned by the Sandbox) goes with it.
  k delete sandboxclaim "$claim" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ -s $bundle ]] || fail "no bundle at $bundle: run tests/e2e/run.sh phase1"

# Fresh runner pod with the code unpacked at /work/app. Called again to model an orchestrator restart.
start_runner() {
  k delete pod e2e-runner --ignore-not-found --wait=true >/dev/null
  # The manifest hard-codes the default namespace; follow NAMESPACE so `kubectl create` does not reject it.
  sed "s/^  namespace: pi-durable-poc\$/  namespace: $ns/" "$here/runner-pod.yaml" | k create -f - >/dev/null
  k wait --for=condition=Ready pod/e2e-runner --timeout=240s >/dev/null
  k exec -i e2e-runner -- sh -c 'mkdir -p /work/app && tar xzf - -C /work/app' <"$bundle"
}

# The claim's token, derived inside the runner by the bundle's own deriveSandboxToken from the master in its env.
derive_js='import {deriveSandboxToken as d} from "/work/app/dist/index.js"; process.stdout.write(d(process.env.PI_SANDBOX_MASTER_KEY, process.env.PI_SANDBOX_CLAIM))'
# Runs a command in the runner from the app dir with the e2e switches set.
in_runner() { k exec e2e-runner -- bash -c "set -o pipefail; export NO_COLOR=1 PI_SANDBOX_E2E=1 PI_E2E_RUN_ID=$run_id PI_SANDBOX_CLAIM=$claim; export PI_SANDBOX_AUTH_TOKEN=\$(node --input-type=module -e '$derive_js'); cd /work/app; $*"; }
vitest_phase() { in_runner "PI_E2E_PHASE=$1 ./node_modules/.bin/vitest run test/reattach.e2e.test.ts --reporter=verbose"; }

pod_uid() { k get pod "$claim" -o jsonpath='{.metadata.uid}' 2>/dev/null || true; }

log "start runner"
start_runner

log "create claim $claim with the hash of its own token"
hash_js='import {deriveSandboxToken as d, sandboxTokenSha256 as h} from "/work/app/dist/index.js"; process.stdout.write(h(d(process.env.PI_SANDBOX_MASTER_KEY, process.env.PI_SANDBOX_CLAIM)))'
token_sha=$(k exec e2e-runner -- env PI_SANDBOX_CLAIM="$claim" node --input-type=module -e "$hash_js")
[[ $token_sha =~ ^[0-9a-f]{64}$ ]] || fail "could not derive the token hash for $claim (is the master in secret sandboxd-auth?)"
k delete sandboxclaim "$claim" --ignore-not-found --wait=true >/dev/null
# Poll with get: the driver Role has no PVC watch, which `kubectl wait --for=delete` needs.
pvc_deadline=$(($(date +%s) + 120))
while k get pvc "workspace-$claim" -o name >/dev/null 2>&1; do
  [[ $(date +%s) -lt $pvc_deadline ]] || fail "workspace-$claim is still terminating after 120s"
  sleep 2
done
k create -f - >/dev/null <<YAML
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata:
  name: $claim
spec:
  warmPoolRef: { name: pi-env-pool }
  env:
    - { name: SANDBOXD_AUTH_TOKEN_SHA256, value: "$token_sha" }
YAML
for _ in $(seq 1 120); do k get "pod/$claim" >/dev/null 2>&1 && break; sleep 1; done
k wait --for=condition=Ready "pod/$claim" --timeout=300s >/dev/null || fail "sandbox pod $claim not Ready"

log "stdio smoke"
in_runner "node --experimental-strip-types test/stdio-smoke.e2e.ts 2>&1 | grep -v agentic-sandbox-client | tee /work/smoke.log; grep -q 'smoke: PASS' /work/smoke.log" \
  || fail "stdio smoke"

log "env conformance"
in_runner "./node_modules/.bin/vitest run test/conformance.e2e.test.ts 2>&1 | tail -15" \
  | tee "$work/conformance.log" || fail "conformance"
grep -Eq 'Tests +[0-9]+ passed' "$work/conformance.log" || fail "conformance: no passing summary"

log "reattach (a): write, kill runner pod, fresh runner reads"
vitest_phase write || fail "reattach write"
start_runner   # deletes the old pod first: the old orchestrator is gone
vitest_phase read || fail "reattach read from fresh runner"

log "reattach (b): delete the sandbox Pod, wait for recreation, same PVC"
old_uid=$(pod_uid)
k delete pod "$claim" --wait=true >/dev/null
for _ in $(seq 1 120); do
  new_uid=$(pod_uid)
  [[ -n "$new_uid" && "$new_uid" != "$old_uid" ]] && break
  sleep 1
done
[[ -n "${new_uid:-}" && "$new_uid" != "$old_uid" ]] || fail "sandbox Pod was not recreated"
k wait --for=condition=Ready "pod/$claim" --timeout=240s >/dev/null || fail "recreated Pod not Ready"
echo "pod recreated and Ready: $old_uid -> $new_uid"
vitest_phase after-pod-loss 2>&1 | tee "$work/after.log" || fail "env after Pod recreation"
grep 'DNS-STALENESS' "$work/after.log" || true

log "ALL PHASE 1 E2E CHECKS PASSED"
