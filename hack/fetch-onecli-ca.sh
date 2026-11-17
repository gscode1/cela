#!/usr/bin/env bash
# Fill ConfigMap `onecli-ca` in $NAMESPACE (default pi-durable-poc; e2e runs use pi-e2e-<id>) with the OneCLI gateway CA. The orchestrator trusts it for the
# certificates the gateway presents for model hosts. The CA is public (no auth): OneCLI v2 serves it at
# GET :10256/v1/gateway/ca (v1.45 served it on :10254). The CA persists in OneCLI's data volume, so this runs once
# and again only if OneCLI's data is recreated. Read-only against OneCLI. Usage: hack/fetch-onecli-ca.sh
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:-pi-durable-poc}
onecli_ns=${ONECLI_NAMESPACE:-onecli}
onecli_service=${ONECLI_SERVICE:-onecli}
onecli_port=${ONECLI_API_PORT:-10256}
work=$(mktemp -d)
pf_pid=
cleanup() {
  [[ -z $pf_pid ]] || kill "$pf_pid" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# A free local port; the API is cluster-internal, so go through a port-forward.
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
kubectl ${ctx:+--context="$ctx"} -n "$onecli_ns" port-forward "svc/$onecli_service" "$port:$onecli_port" >/dev/null 2>&1 &
pf_pid=$!
for _ in $(seq 1 20); do
  curl -fsS -m 3 -o "$work/ca.pem" "http://127.0.0.1:$port/v1/gateway/ca" 2>/dev/null && break
  sleep 1
done
[[ -s $work/ca.pem ]] || { echo "could not fetch the CA from $onecli_service:$onecli_port/v1/gateway/ca" >&2; exit 1; }
# Refuse anything that is not a certificate (an error page, a login redirect).
openssl x509 -in "$work/ca.pem" -noout -subject -fingerprint -sha256 >&2
kubectl ${ctx:+--context="$ctx"} -n "$ns" create configmap onecli-ca --from-file=ca.pem="$work/ca.pem" \
  --dry-run=client -o yaml | kubectl ${ctx:+--context="$ctx"} -n "$ns" apply -f - >/dev/null
echo "configmap onecli-ca updated"
