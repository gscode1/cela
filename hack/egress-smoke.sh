#!/usr/bin/env bash
# Live check of the egress proxy on a THROWAWAY kind cluster (epic #50, slice 3, docs/decisions/0035-egress-proxy-runtime.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --egress-proxy
#   hack/egress-smoke.sh [--name pi-egress] [--namespace pi-durable]
#   hack/kind-down.sh --name pi-egress
#
# It changes egress rules, runs a Helm upgrade and scales the bundled Postgres down and up, so it refuses the cluster
# pi-durable and any context that is not a kind cluster. Test pods live in the namespace pi-egress-test (admitted to the proxy
# by kind-up.sh --egress-proxy), which the script creates and deletes. The admin API is called from inside an ingest pod, so
# no token leaves the cluster or reaches a log. Every check prints `ok: ...` or `FAIL: ...` and the first failure stops the
# run (the cleanup still runs). The checks:
#
#   1. both proxy replicas report a serving state and the current revision in GET /admin/egress/status
#   2. with no rule set that applies to all, a host is denied
#   3. a rule added through the admin API takes effect within 10 s (and a host with no rule is still denied)
#   4. with the open-web rule set (`*`) applying to all: any public host works, and these are denied: names that resolve to
#      loopback, the metadata address and a private address, the bundled Postgres, ingest and the Kubernetes API (also
#      with a far too wide private cidr rule in the same set)
#   5. a private rule (exact host) for a test Service in another namespace opens it only once egressProxy.privateEgress admits
#      that namespace (helm upgrade)
#   6. with Postgres down the proxy keeps judging on its snapshot, then denies everything after egressProxy.rules.staleAfter;
#      a replica that restarts meanwhile is not ready and listens on nothing; it all recovers when Postgres is back
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
test_ns=pi-egress-test
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS]" >&2
  exit 64
}
die() {
  echo "egress-smoke: $*" >&2
  exit 1
}
while [[ $# -gt 0 ]]; do
  case $1 in
  --name) [[ $# -ge 2 ]] || usage; name=$2; shift 2 ;;
  -n | --namespace) [[ $# -ge 2 ]] || usage; namespace=$2; shift 2 ;;
  *) usage ;;
  esac
done
[[ $name =~ ^[a-z0-9]([-a-z0-9]{0,30}[a-z0-9])?$ ]] || die "bad cluster name '$name'"
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script scales Postgres down and changes egress rules. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl helm node; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
kubectl config get-contexts -o name | grep -qx -- "$ctx" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }
kt() { kubectl --context "$ctx" -n "$test_ns" "$@"; }
proxy=http://pi-egress-proxy.$namespace.svc:3128

ok() { echo "ok: $1"; }
fail() {
  echo "FAIL: $1" >&2
  [[ -z ${2:-} ]] || printf '%s\n' "$2" >&2
  exit 1
}

# ------------------------------------------------------------------ the admin API, from inside an ingest pod
api_js=$(
  cat <<'JS'
const [method, path, body] = process.argv.slice(1);
let token = "";
for (const entry of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) {
  const line = entry.trim();
  const at = line.indexOf(":");
  if (at > 0 && line.slice(0, at) === process.env.OWNER) token = line.slice(at + 1);
}
if (token === "") { console.error("no token for the owner"); process.exit(2); }
const res = await fetch(`http://127.0.0.1:${process.env.PI_INGEST_PORT ?? "8080"}${path}`, {
  method,
  headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  body,
  signal: AbortSignal.timeout(20000),
});
console.log(res.status);
console.log(await res.text());
JS
)
# api METHOD PATH [JSON] -> prints the body; fails unless the status is 2xx
api() {
  local out status
  out=$(k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e "$api_js" "$@") || fail "admin API call $1 $2 failed" "$out"
  status=$(head -1 <<<"$out")
  [[ $status == 2?? ]] || fail "admin API $1 $2 answered $status" "$(tail -n +2 <<<"$out")"
  tail -n +2 <<<"$out"
}
jq_() { node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const f = new Function("j", "return " + process.argv[1]); const v = f(j); console.log(typeof v === "object" ? JSON.stringify(v) : String(v))' "$1"; }

# ------------------------------------------------------------------ cleanup, always
created_sets=()
open_web_was_all=""
restore_auth=0
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  for s in ${created_sets[@]+"${created_sets[@]}"}; do
    rev=$(api GET /admin/egress/status 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api DELETE "/admin/egress/rule-sets/$s?expectedRevision=$rev" >/dev/null 2>&1
  done
  [[ $open_web_was_all != false ]] || api PUT /admin/egress/rule-sets/open-web '{"appliesToAll":false}' >/dev/null 2>&1
  [[ -z $(k get statefulset pi-postgres -o jsonpath='{.spec.replicas}' 2>/dev/null | grep -x 0) ]] || k scale statefulset pi-postgres --replicas=1 >/dev/null 2>&1
  kubectl --context "$ctx" delete namespace "$test_ns" --ignore-not-found --wait=false >/dev/null 2>&1
  [[ $restore_auth -eq 0 ]] || helm --kube-context "$ctx" upgrade pi-durable "$root/charts/pi-durable" --namespace "$namespace" --reuse-values \
    --set egressProxy.requireAuth=true --wait --timeout 5m >/dev/null 2>&1
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ anonymous test pods
# The chart refuses a request without a session token by default (the network cutover, ADR 0038). These checks call the proxy
# from test pods that have no token, so the proxy is told to judge anonymous requests for the length of the run.
if [[ $(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EGRESS_REQUIRE_AUTH")].value}') == true ]]; then
  echo "## egressProxy.requireAuth=false for this run (test pods have no token)"
  restore_auth=1
  helm --kube-context "$ctx" upgrade pi-durable "$root/charts/pi-durable" --namespace "$namespace" --reuse-values \
    --set egressProxy.requireAuth=false --wait --timeout 5m >/dev/null
fi

# ------------------------------------------------------------------ test pods
echo "## test pods in namespace $test_ns"
kubectl --context "$ctx" create namespace "$test_ns" --dry-run=client -o yaml | kubectl --context "$ctx" apply -f - >/dev/null
kubectl --context "$ctx" apply -n "$test_ns" -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata: { name: curl, labels: { app: curl } }
spec:
  containers:
    - { name: curl, image: "docker.io/curlimages/curl:8.11.1", command: [sleep, "86400"] }
---
apiVersion: v1
kind: Pod
metadata: { name: target, labels: { app: target } }
spec:
  containers:
    - name: target
      image: docker.io/library/busybox:1.37.0
      command: [sh, -c, "mkdir -p /www && echo private-target-ok > /www/index.html && exec httpd -f -p 8080 -h /www"]
      ports: [{ containerPort: 8080 }]
---
apiVersion: v1
kind: Service
metadata: { name: target }
spec:
  selector: { app: target }
  ports: [{ port: 8080, targetPort: 8080 }]
YAML
kt wait --for=condition=Ready pod/curl pod/target --timeout=240s >/dev/null || fail "the test pods did not become ready"
target_host=target.$test_ns.svc.cluster.local

# curl through the proxy: prints "<CONNECT status> <final status>" ("000" when there was none)
via() { # url [extra curl args]
  local url=$1
  shift
  kt exec curl -- curl -s -o /dev/null --max-time 20 -p -x "$proxy" -w '%{http_connect} %{http_code}' "$url" "$@" 2>/dev/null || true
}
expect_via() { # description url pattern
  local got
  got=$(via "$2")
  [[ $got =~ $3 ]] || fail "$1 (got '$got', wanted /$3/)"
  ok "$1 ($got)"
}
wait_via() { # description url pattern seconds -> ok once it matches within the time
  local start=$SECONDS got=""
  while ((SECONDS - start <= $4)); do
    got=$(via "$2")
    if [[ $got =~ $3 ]]; then
      ok "$1 (after $((SECONDS - start)) s: $got)"
      return 0
    fi
    sleep 1
  done
  fail "$1 (still '$got' after $4 s, wanted /$3/)"
}

# ------------------------------------------------------------------ 1. the replicas report
echo "## 1. replicas report their revision (GET /admin/egress/status)"
start=$SECONDS
while true; do
  status=$(api GET /admin/egress/status)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status")
  [[ $n == 2 ]] && break
  ((SECONDS - start < 90)) || fail "two replicas serving at the current revision" "$status"
  sleep 2
done
ok "two proxy replicas serving at revision $(jq_ 'j.revision' <<<"$status")"

# ------------------------------------------------------------------ 2. no rule set applies to all
echo "## 2. nothing applies to all sessions yet"
expect_via "example.com is denied while no rule set applies to all" https://example.com '^407 '

# ------------------------------------------------------------------ 3. a rule through the admin API
echo "## 3. a rule added through the admin API"
created_sets+=(smoke-all)
api POST /admin/egress/rule-sets '{"name":"smoke-all","description":"egress-smoke.sh","appliesToAll":true}' >/dev/null
api POST /admin/egress/rule-sets/smoke-all/rules '{"effect":"allow","host":"example.com"}' >/dev/null
wait_via "example.com is allowed within 10 s of the rule" https://example.com '^200 200$' 10
expect_via "example.org (no rule) is still denied" https://example.org '^407 '
api POST /admin/egress/rule-sets/smoke-all/rules '{"effect":"allow","host":"example.org"}' >/dev/null
wait_via "example.org is allowed within 10 s of its rule" https://example.org '^200 200$' 10
rule_id=$(api GET /admin/egress/rule-sets/smoke-all | jq_ 'j.rules.find((r) => r.host === "example.org").id')
rev=$(api GET /admin/egress/status | jq_ 'j.revision')
api DELETE "/admin/egress/rules/$rule_id?expectedRevision=$rev" >/dev/null
wait_via "example.org is denied again within 10 s of deleting its rule (new connections)" https://example.org '^407 ' 10

# ------------------------------------------------------------------ 4. open web, and what it can never reach
echo "## 4. open web (*) for everyone, and the addresses no rule opens"
open_web_was_all=$(api GET /admin/egress/rule-sets/open-web | jq_ 'j.appliesToAll')
api PUT /admin/egress/rule-sets/open-web '{"appliesToAll":true}' >/dev/null
open_id=$(api GET /admin/egress/rule-sets/open-web | jq_ 'j.rules.find((r) => r.host === "*").id')
api PUT "/admin/egress/rules/$open_id" '{"ports":[80,443,5432,6443,8080]}' >/dev/null
wait_via "any public host is allowed by the * rule (example.net)" https://example.net '^200 200$' 10
# A wide private cidr rule, as an operator mistake might add it: it must not reach the platform.
api POST /admin/egress/rule-sets/smoke-all/rules '{"effect":"allow","host":"10.0.0.0/8","private":true,"ports":[443,5432,6443,8080]}' >/dev/null
sleep 8
expect_via "localhost (loopback) is denied" https://localhost:443 '^407 '
expect_via "a name that resolves to the metadata address is denied" https://169.254.169.254.nip.io:443 '^407 '
expect_via "a name that resolves to a private address (10.0.0.1) is not connected (the wide private rule admits it in the proxy, the network layer refuses)" https://10.0.0.1.nip.io:443 '^(407|502|504) '
expect_via "the bundled Postgres is denied (platform), * and a wide private rule notwithstanding" "http://pi-postgres.$namespace.svc.cluster.local:5432" '^407 '
expect_via "ingest is denied (platform)" "http://pi-ingest.$namespace.svc.cluster.local:8080" '^407 '
expect_via "the Kubernetes API is denied (platform)" https://kubernetes.default.svc.cluster.local:443 '^407 '
expect_via "the kube API by its short service name is denied" https://kubernetes.default:443 '^407 '
# Remove the wide rule again so step 5 tests the exact one.
wide_id=$(api GET /admin/egress/rule-sets/smoke-all | jq_ 'j.rules.find((r) => r.host === "10.0.0.0/8").id')
rev=$(api GET /admin/egress/status | jq_ 'j.revision')
api DELETE "/admin/egress/rules/$wide_id?expectedRevision=$rev" >/dev/null
expect_via "a private test Service is denied without a private rule" "http://$target_host:8080" '^407 '

# ------------------------------------------------------------------ 5. private rule + privateEgress
echo "## 5. a private rule opens a destination only when privateEgress admits it"
api POST /admin/egress/rule-sets/smoke-all/rules "{\"effect\":\"allow\",\"host\":\"$target_host\",\"private\":true,\"ports\":[8080]}" >/dev/null
sleep 8
got=$(via "http://$target_host:8080")
[[ ! $got =~ ^200\  ]] || fail "the private target answered before privateEgress admitted it ('$got')"
ok "with the private rule but without privateEgress the proxy cannot connect (the network layer refuses: '$got')"
helm --kube-context "$ctx" upgrade pi-durable "$root/charts/pi-durable" --namespace "$namespace" --reuse-values \
  --set "egressProxy.privateEgress[0].namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=$test_ns" \
  --set "egressProxy.privateEgress[0].ports[0]=8080" --wait --timeout 5m >/dev/null
wait_via "the private target is reachable once privateEgress admits its namespace" "http://$target_host:8080" '^200 200$' 30
body=$(kt exec curl -- curl -s --max-time 20 -p -x "$proxy" "http://$target_host:8080/")
[[ $body == private-target-ok ]] || fail "unexpected body from the private target: $body"
ok "the private target's body came through the proxy"

# ------------------------------------------------------------------ 6. Postgres down
echo "## 6. Postgres down: judged on the snapshot, then everything denied"
stale=$(k get deploy pi-egress-proxy -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="EGRESS_STALE_AFTER")].value}')
case $stale in
*m) stale_s=$((${stale%m} * 60)) ;;
*s) stale_s=${stale%s} ;;
*) die "cannot read EGRESS_STALE_AFTER ($stale)" ;;
esac
k scale statefulset pi-postgres --replicas=0 >/dev/null
down=$SECONDS
ok "Postgres scaled to 0 (the proxy goes stale after $stale)"
sleep 15
expect_via "15 s into the outage example.com is still judged on the snapshot (allowed)" https://example.com '^200 200$'
# A replica that restarts now cannot read the rules: it must not be ready and must not listen.
victim=$(k get pods -l app.kubernetes.io/name=pi-egress-proxy -o jsonpath='{.items[0].metadata.name}')
k delete pod "$victim" --wait=false >/dev/null
sleep 3
fresh=""
for _ in $(seq 1 30); do
  fresh=$(k get pods -l app.kubernetes.io/name=pi-egress-proxy -o json | node -e 'const p = JSON.parse(require("fs").readFileSync(0, "utf8")).items.filter((i) => i.metadata.name !== process.argv[1] && !i.metadata.deletionTimestamp && i.status.podIP).map((i) => i.status.podIP + " " + i.metadata.name); console.log(p.join("\n"))' "$victim" | while read -r ip pod; do
    # the pods that started after the outage began: not yet Ready
    ready=$(k get pod "$pod" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
    [[ $ready == True ]] || echo "$ip $pod"
  done | head -1)
  [[ -z $fresh ]] || break
  sleep 2
done
[[ -n $fresh ]] || fail "no restarted replica to check"
fresh_ip=${fresh%% *}
rc=0
kt exec curl -- curl -s -o /dev/null --max-time 5 "http://$fresh_ip:3128/healthz" || rc=$?
[[ $rc -eq 7 ]] || fail "a replica without its first read listens on the proxy port (curl exit $rc, wanted 7: connection refused)"
ok "a replica that cannot read the rules is not serving (connection refused on :3128) and is not Ready"
wait_s=$((stale_s + 20 - (SECONDS - down)))
[[ $wait_s -le 0 ]] || sleep "$wait_s"
expect_via "after $stale without a read every connection is denied (example.com)" https://example.com '^407 '
expect_via "the denial includes the private test target" "http://$target_host:8080" '^407 '
k scale statefulset pi-postgres --replicas=1 >/dev/null
k rollout status statefulset/pi-postgres --timeout=300s >/dev/null
wait_via "after Postgres is back example.com is allowed again" https://example.com '^200 200$' 90
start=$SECONDS
while true; do
  status=$(api GET /admin/egress/status || true)
  n=$(jq_ 'j.proxy.replicas.filter((r) => r.state === "serving" && r.revision === j.revision).length' <<<"$status" 2>/dev/null || echo 0)
  [[ $n -ge 2 ]] && break
  ((SECONDS - start < 120)) || fail "both replicas serving at the current revision again" "$status"
  sleep 3
done
ok "both replicas report serving at the current revision again"
echo
echo "egress-smoke: all checks passed"
