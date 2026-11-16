#!/usr/bin/env bash
# Create secret api-auth in $NAMESPACE (default pi-durable-poc; e2e runs use pi-e2e-<id>): key `tokens` holds one `owner:token` line per API owner.
# Never commit or print its content. Idempotent: an existing secret is left alone (set ROTATE=1 to replace it;
# running orchestrator and ingest pods pick the new value up on their next restart).
# Owners: alice and bob, so the e2e suite can test "wrong owner". Real owners replace these when OIDC lands.
set -euo pipefail
ctx=${KUBE_CONTEXT:-} # empty when run in-cluster (e2e driver Job): ServiceAccount config
ns=${NAMESPACE:-pi-durable-poc}
if [[ ${ROTATE:-0} != 1 ]] && kubectl ${ctx:+--context="$ctx"} -n "$ns" get secret api-auth >/dev/null 2>&1; then
  echo "secret api-auth already exists (ROTATE=1 to replace)"
  exit 0
fi
# The value goes to kubectl through a file in a private temp dir, not argv (visible in `ps`).
umask 077
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf 'alice:%s\nbob:%s' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >"$tmp/tokens"
kubectl ${ctx:+--context="$ctx"} -n "$ns" create secret generic api-auth \
  --from-file=tokens="$tmp/tokens" \
  --dry-run=client -o yaml | kubectl ${ctx:+--context="$ctx"} -n "$ns" apply -f - >/dev/null
echo "secret api-auth created"
