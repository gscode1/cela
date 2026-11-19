#!/usr/bin/env bash
# Single entry point for the e2e suites: tests/e2e/run.sh <smoke|phase1|phase3|phase4|phase4b|phase4c|mcp|shards|browser|console|all>
#   smoke   fast suite for every change (about 5 minutes): create/send/stream, dedup, auth, delete (one sandbox tool call), Postgres pod restart keeps data
#   phase4b per-session models, allowlist, terminal failure on rejected credentials; REAL_MODEL=1 adds two real
#           OpenAI Codex turns through OneCLI (spend)
#   phase4c optional repo workspace through OneCLI + a repo-scoped GitHub App token; needs REPO_A and REPO_B
#           (owner/name, private, in the App installation), otherwise most tests SKIP. Not part of `all`.
#   mcp     native remote MCP tools through the OneCLI gateway (issues #39, #40): the suite adds DeepWiki to the catalog
#           through the admin API (no restart), a scripted session calls tool_search and a DeepWiki tool, and disabling
#           the server makes a new call return tool_unavailable. Needs the internet and the OneCLI host rule for
#           mcp.deepwiki.com. The suite removes the server again at the end. Not part of `all`.
#   shards  horizontal scaling by schema sharding (docs/decisions/0017-schema-sharding.md): the chart is installed with
#           orchestrator.shards=2 (a second orchestrator Deployment) and ingest routes between the two. Not part of `all`
#           (it adds a Deployment and takes about 20 minutes).
#   browser the browser sandbox (issue #267, ADR 0041) on a gVisor cluster with a live model: the chart is installed with
#           the egress proxy and sandbox.flavours.browser; a live openai-codex/gpt-6-luna session drives Playwright CLI and
#           agent-browser through OneCLI (a few real turns: spend), and scripted checks cover Chromium under gVisor and the
#           denials. Needs BROWSER_SANDBOX_IMAGE and EGRESS_PROXY_IMAGE, the OneCLI secrets and the internet. Not part of `all`.
#   console the admin console in a real browser (issue #143, docs/e2e.md "console suite"): the chart is installed with
#           console.enabled=true, and Playwright on THIS machine (not a Job) drives http://127.0.0.1:<port>/console/ through a
#           kubectl port-forward to pi-ingest with the run's alice (admin) and bob (owner without admin access) tokens; then
#           the chart is upgraded with console.enabled=false and /console/ must be a 404. Needs `pnpm install` and
#           `pnpm --filter @pi-durable-k8s/admin-ui exec playwright install chromium`. Not part of `all`.
#   all     the full failure suite: phase1, phase3, phase4 and phase4b (the real-model test only with REAL_MODEL=1); it
#           installs the chart once, so with phase3 in it every phase runs with the egress proxy
#
# The egress proxy (the chart's default, ADR 0038) is on for the suites that test the network, phase3 and browser (and
# `all`, which has phase3), and off for the others, which test durability. EGRESS_PROXY_IMAGE is its image.
#   EGRESS_PROXY=0     phase3 (and all) without the proxy: the explicit opt-out, the old direct sandbox egress (docs/e2e.md)
#
# Every run gets its own namespace, pi-e2e-<run id> (docs/e2e.md): its own Postgres (the charts/pi-postgres release, the
# external database of pi-durable), the pi-durable Helm chart (orchestrator, ingest, sandbox template, RBAC, network
# policies) and secrets, deleted again at the end. Two runs (two branches) can therefore run at the
# same time, and the long-lived namespace pi-durable-poc is never touched: this script refuses any other prefix.
#   DB_TLS=1           the run's Postgres requires TLS (charts/pi-postgres tls.requireTls) and pi-durable verifies it
#                      (database.tls verify-full), with a throwaway CA made for the run (docs/e2e.md)
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
# result never depends on the laptop's network. The operator machine does only this:
#   1. create the namespace, the database and secrets, then install the chart using prebuilt images
#   2. create the Job
#   3. wait for it with `kubectl wait` and read the result from the Job status plus the final logs
# The live log stream is for watching only. If it drops, nothing changes: the verdict comes from the Job status and
# whatever the stream missed is printed from the final `kubectl logs`. No test is retried.
#
# Current kubectl context (KUBE_CONTEXT); only the run namespace is touched. Exit: 0 all green, 1 a suite failed,
# 2 the operator machine lost contact before the Job finished (the Job is left running; see the message for how to read it).
# The namespace, with the Job and its pods, is deleted at the end; if this script is killed, `tests/e2e/sweep.sh` removes it.
set -euo pipefail

# Match images/build.sh's local names; cluster runs should supply pushed digest references.
root=$(cd "$(dirname "$0")/../.." && pwd)
tag=$(node -p "JSON.parse(require('node:fs').readFileSync('$root/package.json', 'utf8')).version")-$(git -C "$root" rev-parse --short HEAD)
export ORCH_IMAGE=${ORCH_IMAGE:-pi-orchestrator:$tag}
export INGEST_IMAGE=${INGEST_IMAGE:-pi-ingest:$tag}
export SANDBOX_IMAGE=${SANDBOX_IMAGE:-pi-sandbox:$tag}
export EGRESS_PROXY_IMAGE=${EGRESS_PROXY_IMAGE:-pi-egress-proxy:$tag}
IMAGE=${DRIVER_IMAGE:-pi-e2e-driver:$tag}

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

[[ ${DB_TLS:-} =~ ^[01]?$ ]] || { echo "DB_TLS must be unset, 0 or 1" >&2; exit 64; }
db_tls=${DB_TLS:-0}
export DB_TLS=$db_tls # read by chart-values.py
[[ ${NETPOL_ENFORCED:-} =~ ^[01]?$ ]] || { echo "NETPOL_ENFORCED must be unset, 0 or 1" >&2; exit 64; }
only=${ONLY:-} # ONLY="a,b" runs just those tests of the phase; smoke sets its own list
[[ ${E2E_PARALLEL:-4} =~ ^[1-9][0-9]*$ ]] || { echo "E2E_PARALLEL must be a positive integer" >&2; exit 64; }
label=""
started=$(date +%s)
case ${1:-} in
smoke)
  phases=(phase4)
  only="create-send-stream,dedup,auth,delete,postgres-restart"
  label=smoke
  ;;
phase1) phases=(phase1) ;;
phase3) phases=(phase3) ;;
phase4) phases=(phase4) ;;
phase4b) phases=(phase4b) ;;
phase4c) phases=(phase4c) ;;
mcp) phases=(mcp) ;;
shards) phases=(shards) ;;
browser) phases=(browser) ;;
console) phases=(console) ;;
all) phases=(phase1 phase3 phase4 phase4b) ;;
*)
  echo "usage: tests/e2e/run.sh <smoke|phase1|phase3|phase4|phase4b|phase4c|mcp|shards|browser|console|all>" >&2
  exit 64
  ;;
esac
has_phase() { local p; for p in "${phases[@]}"; do [[ $p == "$1" ]] && return 0; done; return 1; }
[[ ${EGRESS_PROXY:-} =~ ^[01]?$ ]] || { echo "EGRESS_PROXY must be unset, 0 or 1" >&2; exit 64; }
egress_proxy=0
if has_phase phase3 || has_phase browser; then egress_proxy=${EGRESS_PROXY:-1}; fi
if has_phase browser && [[ $egress_proxy != 1 ]]; then echo "the browser suite needs the egress proxy: unset EGRESS_PROXY" >&2; exit 64; fi
export EGRESS_PROXY=$egress_proxy # read by chart-values.py

work=$(mktemp -d)
pf_pid="" # the console suite's port-forward
job=""
keep_job=0
ns_touched=0 # 1 once this run may have created or reused the namespace; the trap then decides keep or delete
cleanup() {
  local rc=$? gone=0 _
  trap - EXIT
  # Match on the namespace too: another run's log follower on this machine must survive.
  pkill -f -- "-n $ns logs -f job/e2e-driver" 2>/dev/null || true
  [[ -z $pf_pid ]] || kill "$pf_pid" 2>/dev/null || true
  rm -rf "$work"
  [[ $ns_touched -eq 1 ]] || return "$rc"
  # An unfinished Job (keep_job=1) stays for the reader.
  if [[ $keep_job -eq 0 ]]; then k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
  if [[ ${KEEP_NS:-0} == 1 || ( $rc -ne 0 && ${KEEP_NS_ON_FAIL:-0} == 1 ) || $rc -eq 2 ]]; then
    printf '\nnamespace %s kept. Delete it with: kubectl %s delete namespace %s (tests/e2e/sweep.sh removes it after %s h)\n' \
      "$ns" "${ctx:+--context=$ctx}" "$ns" "${SWEEP_MAX_AGE_HOURS:-6}" >&2
    return "$rc"
  fi
  # Deleting the namespace removes the Job and its pods, the Postgres release, the PVCs, sandboxes and secrets with it.
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
# Orphans of killed runs go first. This run's own namespace is excluded: a kept one older than the age limit is
# about to be reused, not orphaned. Never fails the run.
[[ ${SKIP_SWEEP:-0} == 1 ]] || SWEEP_EXCLUDE=$ns "$here/sweep.sh" || echo "sweep failed (ignored)" >&2

branch=$(git -C "$root" rev-parse --abbrev-ref HEAD 2>/dev/null | tr -c 'A-Za-z0-9._/\n-' '_' || true)
if kc get namespace "$ns" >/dev/null 2>&1; then
  # kubectl rejects a name together with a label selector, so read the label itself.
  [[ $(kc get namespace "$ns" -o jsonpath='{.metadata.labels.pi-durable-e2e}' 2>/dev/null) == true ]] || {
    echo "namespace $ns exists but is not an e2e run namespace (label pi-durable-e2e=true); refusing to use it" >&2
    exit 1
  }
  log "reusing namespace $ns"
else
  log "create namespace $ns"
fi
ns_touched=1
# The label is what the OneCLI ingress policy (docs/e2e.md) and the sweeper select on. It must exist before the
# first Pod does: Cilium computes a Pod's identity from its namespace labels when the Pod starts. The Pod Security labels
# are applied here too, on a reused namespace as well (docs/decisions/0019-restricted-pod-security.md); the version is
# pinned, so keep it equal to hack/install.sh (a unit test checks).
kc apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: $ns
  labels:
    pi-durable-e2e: "true"
    app.kubernetes.io/managed-by: pi-e2e
    pod-security.kubernetes.io/enforce: restricted
    pod-security.kubernetes.io/enforce-version: v1.36
    pod-security.kubernetes.io/warn: restricted
    pod-security.kubernetes.io/warn-version: v1.36
    pod-security.kubernetes.io/audit: restricted
    pod-security.kubernetes.io/audit-version: v1.36
  annotations:
    pi-durable-e2e/branch: "${branch:-unknown}"
    pi-durable-e2e/suite: "${1:-}"
EOF

# The run's own pieces (tests/e2e/deploy, which includes tests/e2e/driver) around the chart: the
# ExternalSecrets, the policies of the test-only pods and the driver's identity. One generated overlay sets the namespace.
# kustomize wants relative paths and resolves symlinks (a macOS temp dir is one), so both ends are resolved first.
relpath() { python3 -c 'import os, sys; print(os.path.relpath(os.path.realpath(sys.argv[1]), os.path.realpath(sys.argv[2])))' "$1" "$2"; }
mkdir -p "$work/stack" "$work/cilium"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: %s\nresources:\n  - %s\n' \
  "$ns" "$(relpath "$here/deploy" "$work/stack")" >"$work/stack/kustomization.yaml"
printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: %s\nresources:\n  - %s\n' \
  "$ns" "$(relpath "$here/deploy/cilium" "$work/cilium")" >"$work/cilium/kustomization.yaml"

log "stack: CiliumNetworkPolicies, ExternalSecrets, test-only policies, driver identity"
# CiliumNetworkPolicies first (docs/network-policy.md apply order); they need the Cilium CRDs.
kc apply -k "$work/cilium" >/dev/null
kc apply -k "$work/stack" >/dev/null
# Remove a Job left by an earlier killed run before redeploying.
k delete job -l app.kubernetes.io/name=e2e-driver --ignore-not-found --cascade=foreground --wait=true >/dev/null

log "secrets"
# sandboxd-auth and api-auth are random per run, made in the namespace (never copied from the long-lived stack, never
# printed). The chart only references them (D8).
NAMESPACE=$ns "$root/hack/gen-secret.sh" >/dev/null
NAMESPACE=$ns "$root/hack/gen-api-secret.sh" >/dev/null
# pi-onecli, pi-onecli-admin and pi-github-app are ExternalSecrets on the ClusterSecretStore: ESO copies them in. The
# orchestrator reads them optionally and only once at start, so they must be Ready before the chart starts it (below).
if ! k wait --for=condition=Ready externalsecret --all --timeout=120s >/dev/null 2>&1; then
  echo "WARNING: some ExternalSecrets are not Ready (kubectl -n $ns get externalsecret); suites that need OneCLI or GitHub will SKIP or fail" >&2
fi
# The gateway CA (public) from OneCLI itself, for the orchestrator's model calls and MCP. Only the suites that use OneCLI need it.
if ! NAMESPACE=$ns KUBE_CONTEXT=$ctx "$root/hack/fetch-onecli-ca.sh" >"$work/ca.log" 2>&1; then
  if [[ ${REAL_MODEL:-0} == 1 ]] || has_phase phase4c || has_phase mcp || has_phase browser; then
    cat "$work/ca.log" >&2
    echo "could not fetch the OneCLI CA, and this suite needs it" >&2
    exit 1
  fi
  echo "WARNING: could not fetch the OneCLI CA (ignored: the suites selected do not call OneCLI)" >&2
fi

# The database of this run: the charts/pi-postgres release, installed as a user installs it. It must be Ready before
# pi-durable, whose orchestrator and ingest read the URI secret. The passwords are random per run and only ever written
# to files in the private temp dir and read by kubectl (never an argument, never printed); a reused namespace keeps its
# secret, because the retained data directory was initialised with it.
log "database: charts/pi-postgres into $ns"
[[ $ns == pi-e2e-* ]] || { echo "refusing to install the chart into $ns" >&2; exit 1; }
chmod 700 "$work"
if ! k get secret pi-postgres-auth >/dev/null 2>&1; then
  mkdir -p "$work/pgauth"
  for key in postgres-password pi-password onecli-password egress-password; do openssl rand -hex 24 | tr -d '\n' >"$work/pgauth/$key"; done
  k create secret generic pi-postgres-auth --from-file="$work/pgauth" >/dev/null
  rm -rf "$work/pgauth"
fi
# DB_TLS=1: a throwaway CA and a server certificate for the Service names, made in the private temp dir and deleted
# again; only the Secrets stay in the namespace. pi-postgres-tls (kubernetes.io/tls) is for the server, pi-db-tls-ca
# (the public CA only) for the clients: pi-durable's database.tls and the e2e psql client (fns.sh). A reused namespace
# keeps both, so the retained database and its certificate stay a pair. No key is ever printed or passed as an argument.
if [[ $db_tls == 1 ]] && ! { k get secret pi-postgres-tls >/dev/null 2>&1 && k get secret pi-db-tls-ca >/dev/null 2>&1; }; then
  log "database TLS: throwaway CA and server certificate for pi-postgres.$ns.svc"
  tls=$work/tls
  mkdir -p "$tls"
  chmod 700 "$tls"
  printf '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ext\n[dn]\nCN=pi-e2e-ca-%s\n[ext]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' \
    "$run_id" >"$tls/ca.cnf"
  printf '[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:pi-postgres,DNS:pi-postgres.%s,DNS:pi-postgres.%s.svc,DNS:pi-postgres.%s.svc.cluster.local\n' \
    "$ns" "$ns" "$ns" >"$tls/server.ext"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 -config "$tls/ca.cnf" \
    -keyout "$tls/ca.key" -out "$tls/ca.crt" >/dev/null 2>&1
  openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -subj "/CN=pi-postgres.$ns.svc" \
    -keyout "$tls/tls.key" -out "$tls/server.csr" >/dev/null 2>&1
  openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.crt" -CAkey "$tls/ca.key" -CAcreateserial -days 7 \
    -extfile "$tls/server.ext" -extensions ext -out "$tls/tls.crt" >/dev/null 2>&1
  openssl verify -CAfile "$tls/ca.crt" "$tls/tls.crt" >/dev/null || { echo "the throwaway server certificate does not verify" >&2; exit 1; }
  k create secret tls pi-postgres-tls --cert="$tls/tls.crt" --key="$tls/tls.key" --dry-run=client -o yaml | k apply -f - >/dev/null
  k create secret generic pi-db-tls-ca --from-file=ca.crt="$tls/ca.crt" --dry-run=client -o yaml | k apply -f - >/dev/null
  rm -rf "$tls"
fi
pg_values=(--set persistence.size=1Gi --set persistence.retain=false
  --set-json 'networkPolicy.clientSelectors=[{"app.kubernetes.io/name":"pi-orchestrator"},{"app.kubernetes.io/name":"pi-ingest"},{"app.kubernetes.io/name":"e2e-db-client"},{"app.kubernetes.io/name":"pi-egress-proxy"}]')
# The egress proxy reads the rules with the read-only role pi_egress (ADR 0035).
[[ $egress_proxy != 1 ]] || pg_values+=(--set auth.egressReader.enabled=true)
[[ $db_tls != 1 ]] || pg_values+=(--set tls.existingSecret=pi-postgres-tls --set tls.requireTls=true)
[[ -z ${STORAGE_CLASS:-} ]] || pg_values+=(--set "persistence.storageClass=$STORAGE_CLASS")
helm ${ctx:+--kube-context="$ctx"} upgrade --install pi-postgres "$root/charts/pi-postgres" --namespace "$ns" \
  "${pg_values[@]}" --wait --timeout "${HELM_TIMEOUT:-10m}" >"$work/helm-pg.log" 2>&1 || {
  cat "$work/helm-pg.log" >&2
  echo "helm install of charts/pi-postgres failed in $ns" >&2
  exit 1
}
# The URI of the pi database for the pi-durable chart (database.external). Direct to the Service, no pooler.
umask 077
{
  printf 'postgres://pi:'
  k get secret pi-postgres-auth -o jsonpath='{.data.pi-password}' | base64 -d
  printf '@pi-postgres.%s.svc:5432/pi' "$ns"
} >"$work/uri"
k create secret generic pi-db-uri --from-file=uri="$work/uri" --dry-run=client -o yaml | k apply -f - >/dev/null
rm -f "$work/uri"
k wait --for=condition=Ready pod/pi-postgres-0 --timeout=300s >/dev/null

# DB_TLS=1: prove the server refuses plain TCP, from a client the network policy admits (label e2e-db-client, like
# the e2e psql Pod). A rejection that is only a refused connection would prove nothing, so the check needs the
# server's own pg_hba message, and a verified TLS connection with the same role must work (positive control).
if [[ $db_tls == 1 ]]; then
  log "database TLS: plain connections must be rejected, verified TLS must work"
  pg_image=$(k get pod pi-postgres-0 -o jsonpath='{.spec.containers[?(@.name=="postgres")].image}')
  k delete pod e2e-tls-probe --ignore-not-found --wait=true >/dev/null
  k create -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: e2e-tls-probe
  labels:
    app.kubernetes.io/name: e2e-db-client
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: psql
      image: "$pg_image"
      command: [sleep, "300"]
      env:
        - name: PGPASSWORD
          valueFrom:
            secretKeyRef: {name: pi-postgres-auth, key: pi-password}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: "1", memory: 128Mi}
      volumeMounts:
        - {name: db-tls, mountPath: /etc/pi-db-tls, readOnly: true}
  volumes:
    - name: db-tls
      secret: {secretName: pi-db-tls-ca}
YAML
  k wait --for=condition=Ready pod/e2e-tls-probe --timeout=300s >/dev/null
  pg_conn="host=pi-postgres.$ns.svc port=5432 dbname=pi user=pi connect_timeout=10"
  # shellcheck disable=SC2016 # expanded in the Pod, not here
  [[ $(k exec e2e-tls-probe -- sh -c 'exec psql "$1 sslmode=verify-full sslrootcert=/etc/pi-db-tls/ca.crt" -X -At -c "select 1"' sh "$pg_conn" 2>&1) == 1 ]] || {
    echo "database TLS: a verified TLS connection (sslmode=verify-full) to pi-postgres.$ns.svc failed" >&2
    exit 1
  }
  # shellcheck disable=SC2016
  plain=$(k exec e2e-tls-probe -- sh -c 'exec psql "$1 sslmode=disable" -X -At -c "select 1" 2>&1' sh "$pg_conn" || true)
  [[ $plain == *"pg_hba.conf"*"no encryption"* ]] || {
    echo "database TLS: expected the server to reject sslmode=disable with a pg_hba.conf error, got: ${plain:-<no output>}" >&2
    exit 1
  }
  echo "database TLS: plain TCP rejected by the server (pg_hba.conf), verify-full accepted"
  k delete pod e2e-tls-probe --ignore-not-found --wait=false >/dev/null
fi

# The egress proxy needs its database Secret (the URI of pi_egress) and the key that seals OneCLI tokens
# for it (ADR 0037). Both are made in the namespace through files in the private temp dir and never printed; a reused
# namespace keeps them (a new binding key would leave stored bindings unreadable).
if [[ $egress_proxy == 1 ]]; then
  k get secret pi-postgres-auth -o jsonpath='{.data.egress-password}' | grep -q . ||
    { echo "pi-postgres-auth in $ns has no egress-password (a namespace from before the egress proxy): use a fresh RUN_ID" >&2; exit 1; }
  if ! k get secret pi-egress-database >/dev/null 2>&1; then
    {
      printf 'postgres://pi_egress:'
      k get secret pi-postgres-auth -o jsonpath='{.data.egress-password}' | base64 -d
      printf '@pi-postgres.%s.svc:5432/pi' "$ns"
    } >"$work/egress-uri"
    k create secret generic pi-egress-database --from-file=uri="$work/egress-uri" >/dev/null
    rm -f "$work/egress-uri"
  fi
  if ! k get secret pi-egress-binding >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n' >"$work/binding-key"
    k create secret generic pi-egress-binding --from-file=key="$work/binding-key" >/dev/null
    rm -f "$work/binding-key"
  fi
fi

# The chart, installed exactly as a user installs it. Orchestrator shards: the shards suite needs two (docs/scaling.md);
# the shard count can only grow, so a reused namespace that already has two keeps them.
shards=1
if has_phase shards || k get deployment pi-orchestrator-1 >/dev/null 2>&1; then shards=2; fi
log "helm: charts/pi-durable into $ns (orchestrator shards: $shards, egress proxy: $([[ $egress_proxy == 1 ]] && echo on || echo off))"
# The console suite serves the console (CONSOLE_ENABLED is read by chart-values.py); every other suite leaves it off.
if has_phase console; then export CONSOLE_ENABLED=1; fi
# The browser suite turns on the browser flavour (chart-values.py); its image has no local default.
if has_phase browser; then
  export BROWSER_SUITE=1
  : "${BROWSER_SANDBOX_IMAGE:?BROWSER_SANDBOX_IMAGE (a pushed pi-sandbox-browser reference) is required for the browser suite}"
fi
python3 "$here/chart-values.py" "$onecli_prefix" "$shards" >"$work/values.json"
helm ${ctx:+--kube-context="$ctx"} upgrade --install pi-durable "$root/charts/pi-durable" --namespace "$ns" \
  --values "$work/values.json" --wait --timeout "${HELM_TIMEOUT:-10m}" >"$work/helm.log" 2>&1 || {
  cat "$work/helm.log" >&2
  echo "helm install of the chart failed in $ns" >&2
  exit 1
}

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
k rollout status deployment/pi-orchestrator --timeout=300s >/dev/null
k rollout status deployment/pi-ingest --timeout=300s >/dev/null

# ------------------------------------------------------------------ 2+3. create the Job, wait, read the verdict
overall=0
verdicts=()
run_phase() { # phase1|phase3|phase4
  local phase=$1 w1 w2 follow_pid conds printed
  local name=${label:-$phase}
  job=e2e-driver-$name-$(date +%s)
  keep_job=0
  log "$name: Job $job"
  sed -e "s|__JOB__|$job|" -e "s|__PHASE__|$phase|" -e "s|__IMAGE__|$IMAGE|" -e "s|__ONLY__|$only|" -e "s|__E2E_PARALLEL__|${E2E_PARALLEL:-4}|" -e "s|__NETPOL_ENFORCED__|${NETPOL_ENFORCED:-}|" -e "s|__REAL_MODEL__|${REAL_MODEL:-0}|" -e "s|__REPO_A__|${REPO_A:-}|" -e "s|__REPO_B__|${REPO_B:-}|" -e "s|__ONECLI_NAME_PREFIX__|$onecli_prefix|" "$here/job.yaml.tpl" | k create -f - >/dev/null

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
    grep -E '^(ALL PHASE 1 E2E CHECKS PASSED|PHASE [34]:|PHASE 4[BC]:|SHARDS:|BROWSER:)' "$work/$name.full" | sed 's/^/   /' || true
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

# The console suite runs a browser on this machine against a port-forward, not a Job in the cluster: a browser needs a
# display stack the driver image lacks, and the thing under test is what an operator sees through a port-forward
# (docs/e2e.md). The tokens come from the run's own api-auth Secret into the environment of the one Playwright process;
# they are never printed or written to a file.
start_port_forward() {
  local port=$1 _
  kc -n "$ns" port-forward svc/pi-ingest "$port:8080" >"$work/port-forward.log" 2>&1 &
  pf_pid=$!
  for _ in $(seq 1 30); do
    curl -fsS -o /dev/null "http://127.0.0.1:$port/healthz" 2>/dev/null && return 0
    sleep 1
  done
  cat "$work/port-forward.log" >&2
  echo "port-forward to pi-ingest in $ns did not come up" >&2
  return 1
}
stop_port_forward() {
  [[ -z $pf_pid ]] || kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
  pf_pid=""
}
run_console() {
  local port tokens admin_token owner_token pw=(pnpm --dir "$root" --filter @pi-durable-k8s/admin-ui exec playwright)
  log "console: browser suite against pi-ingest in $ns"
  if ! "${pw[@]}" --version >/dev/null 2>&1; then
    echo "Playwright is not installed: run pnpm install, then pnpm --filter @pi-durable-k8s/admin-ui exec playwright install chromium" >&2
    verdicts+=("console: FAIL (Playwright missing)")
    overall=1
    return
  fi
  port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
  tokens=$(k get secret api-auth -o jsonpath='{.data.tokens}' | base64 -d)
  admin_token=$(sed -n 's/^alice://p' <<<"$tokens")
  owner_token=$(sed -n 's/^bob://p' <<<"$tokens")
  tokens=""
  if [[ -z $admin_token || -z $owner_token ]]; then
    echo "api-auth in $ns has no tokens for alice and bob" >&2
    verdicts+=("console: FAIL (no tokens)")
    overall=1
    return
  fi
  # alice is the run's only api.admins owner and bob is a valid owner without admin access (tests/e2e/chart-values.py).
  start_port_forward "$port" || { verdicts+=("console: FAIL (port-forward)"); overall=1; return; }
  if CONSOLE_BASE_URL="http://127.0.0.1:$port" CONSOLE_ADMIN_TOKEN=$admin_token CONSOLE_NONADMIN_TOKEN=$owner_token \
    CONSOLE_EXPECT=enabled "${pw[@]}" test --config "$root/packages/admin-ui/playwright.config.ts"; then
    verdicts+=("console (enabled): PASS")
  else
    verdicts+=("console (enabled): FAIL")
    overall=1
  fi
  stop_port_forward

  # Switched off: the same release with console.enabled=false must answer 404 for /console/.
  log "console: helm upgrade with console.enabled=false"
  CONSOLE_ENABLED=0 python3 "$here/chart-values.py" "$onecli_prefix" "$shards" >"$work/values-off.json"
  if ! helm ${ctx:+--kube-context="$ctx"} upgrade pi-durable "$root/charts/pi-durable" --namespace "$ns" \
    --values "$work/values-off.json" --wait --timeout "${HELM_TIMEOUT:-10m}" >"$work/helm-off.log" 2>&1; then
    cat "$work/helm-off.log" >&2
    verdicts+=("console (disabled): FAIL (helm upgrade)")
    overall=1
    return
  fi
  k rollout status deployment/pi-ingest --timeout=300s >/dev/null
  start_port_forward "$port" || { verdicts+=("console (disabled): FAIL (port-forward)"); overall=1; return; }
  if CONSOLE_BASE_URL="http://127.0.0.1:$port" CONSOLE_ADMIN_TOKEN=$admin_token CONSOLE_NONADMIN_TOKEN=$owner_token \
    CONSOLE_EXPECT=disabled "${pw[@]}" test --config "$root/packages/admin-ui/playwright.config.ts"; then
    verdicts+=("console (disabled): PASS")
  else
    verdicts+=("console (disabled): FAIL")
    overall=1
  fi
  stop_port_forward
}

for phase in "${phases[@]}"; do
  if [[ $phase == console ]]; then
    run_console
    continue
  fi
  run_phase "$phase"
  # An unfinished Job may still use cluster resources; do not start the next phase on top.
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
