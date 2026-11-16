#!/usr/bin/env bash
# Create secret sandboxd-auth in pi-durable-poc with one key, `master`: the key the orchestrator derives every
# sandbox's token from (token = HMAC-SHA256(master, claimName), packages/sandbox-env/src/token.ts). Never commit or
# print its value. A sandbox only ever gets the sha256 of its own token (SandboxClaim env), never the master.
# Idempotent: an existing master is kept. ROTATE=1 replaces it; every existing claim then has to be recreated
# (docs/decisions/0001-per-sandbox-sandboxd-token.md). Keys from the earlier shared-token scheme (`token`,
# `token-sha256`) are removed.
set -euo pipefail
ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }

exists=0
if k get secret sandboxd-auth >/dev/null 2>&1; then
  exists=1
  if [[ -n $(k get secret sandboxd-auth -o jsonpath='{.data.master}') && ${ROTATE:-0} != 1 ]]; then
    echo "sandboxd-auth: master exists, kept (ROTATE=1 to replace)"
    exit 0
  fi
fi
# The value goes to kubectl through a file in a private temp dir, not argv (visible in `ps`).
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
openssl rand -hex 32 | tr -d '\n' >"$tmp/master"
manifest=$(k create secret generic sandboxd-auth --from-file=master="$tmp/master" --dry-run=client -o yaml)
# replace swaps the whole data map, which also drops the legacy keys.
if [[ $exists == 1 ]]; then k replace -f - <<<"$manifest" >/dev/null; else k create -f - <<<"$manifest" >/dev/null; fi
echo "sandboxd-auth: master written"
