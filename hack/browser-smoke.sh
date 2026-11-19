#!/usr/bin/env bash
# Live check of the browser sandbox on a THROWAWAY kind cluster (epic #50, slice 9, issue #48,
# docs/decisions/0041-browser-sandbox.md):
#
#   hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy
#   hack/browser-smoke.sh [--name pi-egress] [--namespace pi-durable]
#   hack/kind-down.sh --name pi-egress
#
# It seeds the `browser` profile and its skills (hack/seed-browser-profile.mjs, without --create-only: hack/install.sh has
# usually done it create-only already, and this run checks that the repo's definition publishes nothing new), creates sessions and a narrow profile
# (named smoke-*), and refuses the cluster pi-durable and any context that is not a kind cluster. The APIs are called from
# inside an ingest pod (hack/kind-client.mjs); only the seed script goes through a port-forward with the admin token,
# which is never printed. Every check prints `ok: ...` or `FAIL: ...`; the first failure stops the run, the cleanup still
# runs. The numbers (memory, CPU) are printed as `measure: ...`.
#
#   1. the browser profile is seeded; a session on it reports the flavour, runs in a browser pool Pod and has both skills
#   2. Patchright opens a public page: title and a screenshot in /workspace
#   3. agent-browser opens a public page on the same Chromium: title and a screenshot in /workspace
#   4. nothing is reachable that must not be: cluster, platform, OneCLI, metadata, LAN; a host that the rules do not allow
#      is refused; file:// and chrome:// are blocked; github.com is reached without any credential (no OneCLI route)
#   5. the browser made no direct network attempt (no UDP socket, no DNS) and CDP listens on loopback only
#   6. memory and CPU, idle and after pages
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
name=pi-egress
namespace=pi-durable
owner=${PI_SMOKE_OWNER:-admin}

usage() {
  echo "usage: ${0##*/} [--name CLUSTER] [--namespace NS]" >&2
  exit 64
}
die() {
  echo "browser-smoke: $*" >&2
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
[[ $name != pi-durable ]] || die "refusing the cluster pi-durable: this script creates sessions and profiles. Use a throwaway cluster (hack/kind-up.sh --name pi-egress ...)"
for tool in kubectl node base64; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
ctx=kind-$name
kubectl config get-contexts -o name | grep -qx -- "$ctx" || die "no kubectl context $ctx (kind cluster $name)"
k() { kubectl --context "$ctx" -n "$namespace" "$@"; }
scratch=$(mktemp -d)

ok() { echo "ok: $1"; }
fail() {
  echo "FAIL: $1" >&2
  [[ -z ${2:-} ]] || printf '%s\n' "$2" >&2
  exit 1
}
check() { # what, output, pattern
  grep -Eq -- "$3" <<<"$2" || fail "$1 (wanted /$3/)" "$2"
  ok "$1"
}
refute() { # what, output, pattern
  ! grep -Eq -- "$3" <<<"$2" || fail "$1 (did not want /$3/)" "$2"
  ok "$1"
}

# ------------------------------------------------------------------ the APIs, from inside an ingest pod
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
api() { # METHOD PATH [JSON] -> the body; fails unless the status is 2xx
  local out status
  out=$(k exec deploy/pi-ingest -c ingest -- env OWNER="$owner" node --input-type=module -e "$api_js" "$@") || fail "admin API call $1 $2 failed" "$out"
  status=$(head -1 <<<"$out")
  [[ $status == 2?? ]] || fail "admin API $1 $2 answered $status" "$(tail -n +2 <<<"$out")"
  tail -n +2 <<<"$out"
}
jq_() { node -e 'const j = JSON.parse(require("fs").readFileSync(0, "utf8")); const f = new Function("j", "return " + process.argv[1]); const v = f(j); console.log(typeof v === "object" ? JSON.stringify(v) : String(v))' "$1"; }
client_js=$(cat "$root/hack/kind-client.mjs")
kc() { k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$client_js" "$1" "$owner" "${@:2}"; }
script_json() { node -e 'console.log(JSON.stringify({ steps: [{ bash: process.argv[2], timeout: 120 }], final: process.argv[1] }))' "$1" "$2"; }
# sandbox SESSION MARKER BASH -> the tool output lines of one tool call in that session's sandbox
sandbox() { kc ask "$1" "$(script_json "$2" "$3")" "$2" 600; }

client_js=$(cat "$root/hack/kind-client.mjs")
kc() { k exec deploy/pi-ingest -c ingest -- node --input-type=module -e "$client_js" "$1" "$owner" "${@:2}"; }
script_json() { node -e 'console.log(JSON.stringify({ steps: [{ bash: process.argv[2], timeout: 300 }], final: process.argv[1] }))' "$1" "$2"; }
# sandbox SESSION MARKER BASH -> the tool output of one tool call in that session's sandbox (the tool output is cut at 400
# characters: each call prints one short line)
sandbox() { kc ask "$1" "$(script_json "$2" "$3")" "$2" 600 | sed -n 's/^TOOL //p' | tail -n 1; }
# What a tool command sees: the proxy variables, a quiet Node.
pre='export NODE_NO_WARNINGS=1; cd /workspace;'

sessions=()
profiles=()
pf=
cleanup() {
  local rc=$?
  set +e
  echo
  echo "## cleanup"
  [[ -z $pf ]] || kill "$pf" 2>/dev/null
  for s in ${sessions[@]+"${sessions[@]}"}; do kc delete "$s" 120 >/dev/null 2>&1; done
  for p in ${profiles[@]+"${profiles[@]}"}; do
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api PUT "/admin/profiles/$p" "{\"enabledForNew\":false,\"expectedRevision\":$rev}" >/dev/null 2>&1
    rev=$(api GET "/admin/profiles/$p" 2>/dev/null | jq_ 'j.revision' 2>/dev/null)
    api DELETE "/admin/profiles/$p?expectedRevision=$rev" >/dev/null 2>&1
  done
  rm -rf "$scratch"
  exit $rc
}
trap cleanup EXIT

# ------------------------------------------------------------------ 1. the profile, the session, the pool
echo "## 1. the browser profile is seeded; a session on it runs in a browser pool Pod with both skills"
tokens=$(k exec deploy/pi-ingest -c ingest -- printenv PI_API_TOKENS)
token=$(node -e 'for (const e of process.argv[1].split(/[\n,]/)) { const l = e.trim(); const i = l.indexOf(":"); if (i > 0 && l.slice(0, i) === process.argv[2]) console.log(l.slice(i + 1)); }' "$tokens" "$owner")
[[ -n $token ]] || die "no API token for the owner $owner"
kubectl --context "$ctx" -n "$namespace" port-forward svc/pi-ingest 18081:8080 >/dev/null 2>&1 &
pf=$!
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/18081) 2>/dev/null && break; sleep 1; done
seeded=$(PI_API_URL=http://127.0.0.1:18081 PI_API_TOKEN=$token node "$root/hack/seed-browser-profile.mjs") || fail "seeding the browser profile" "$seeded"
check "the seed script publishes both skills and writes the profile" "$seeded" 'profile browser v[0-9]+ (written|unchanged)'
again=$(PI_API_URL=http://127.0.0.1:18081 PI_API_TOKEN=$token node "$root/hack/seed-browser-profile.mjs")
check "seeding again changes nothing" "$again" 'profile browser v[0-9]+ unchanged'
def=$(api GET /admin/profiles/browser | jq_ 'JSON.stringify(j.definition)')
check "the profile is browser flavour, proxied, open-web, with the skills" "$def" '"egressRuleSets":\["open-web"\],"networkMode":"proxied","sandboxFlavour":"browser"'

sa=$(kc create browser | sed -n 's/^session //p')
[[ -n $sa ]] || fail "could not create the browser session"
sessions+=("$sa")
info=$(api GET "/sessions/$sa")
check "the session reports the browser flavour and the proxied mode" "$info" '"sandboxFlavour":"browser"'
m=m$RANDOM
out=$(sandbox "$sa" "env-$m" "$pre printf 'user=%s proxy=%s shm=%s' \"\$(id -u)\" \"\$(printf %s \"\$HTTPS_PROXY\" | sed -E 's#(://x:)[^@]*@[0-9.]+:3128#\\1***@P#')\" \"\$(df -m /dev/shm | awk 'NR==2{print \$2}')\"; echo; ls /workspace/.skills/*/*/SKILL.md | sed -E 's#.*/.skills/([^/]+)/.*#\\1#' | tr '\\n' ' '; echo $m")
echo "$out"
check "the sandbox runs as uid 1000 with the proxy variables and a 256 MB /dev/shm" "$out" 'user=1000 proxy=http://x:\*\*\*@P shm=256'
check "both skills are materialized in /workspace/.skills" "$out" 'agent-browser .*patchright|patchright .*agent-browser'
claim=$(k get sandboxclaims -l "pi-durable-k8s/session-id=$sa" -o jsonpath='{.items[0].metadata.name}')
img=$(k get pod "$claim" -o jsonpath='{.spec.containers[0].image}')
check "the Pod runs the browser image" "$img" 'pi-sandbox-browser'
check "the Pod carries the browser flavour label" "$(k get pod "$claim" -o jsonpath='{.metadata.labels}')" '"pi-durable.dev/sandbox-flavour":"browser"'

# ------------------------------------------------------------------ 2. Patchright
echo "## 2. Patchright: a public page's title and a screenshot in /workspace"
m=m$RANDOM
out=$(sandbox "$sa" "pw-$m" "$pre pi-browser start >/dev/null && patchright-run -e 'const {chromium}=require(\"patchright\");(async()=>{const b=await chromium.connectOverCDP(\"http://127.0.0.1:9222\");const p=await b.contexts()[0].newPage();await p.goto(\"https://example.com\",{waitUntil:\"domcontentloaded\",timeout:30000});console.log(\"Page Title: \"+await p.title());await p.screenshot({path:\"/workspace/pw.png\"});await p.close();await b.close()})().catch(e=>{console.error(e.message);process.exit(1)})' | tr '\\n' ' '; printf 'png=%s' \"\$(head -c 8 /workspace/pw.png | od -An -tx1 | tr -d ' ')\"; echo $m")
echo "$out"
check "Patchright returns the title of example.com" "$out" 'Page Title: Example Domain'
check "its screenshot is a PNG in /workspace" "$out" 'png=89504e470d0a1a0a'

# ------------------------------------------------------------------ 3. agent-browser
echo "## 3. agent-browser on the same Chromium: title and a screenshot in /workspace"
m=m$RANDOM
out=$(sandbox "$sa" "ab-$m" "$pre agent-browser open https://example.org >/dev/null; printf 'title=%s ' \"\$(agent-browser get title)\"; agent-browser screenshot /workspace/ab.png >/dev/null; printf 'png=%s browsers=%s' \"\$(head -c 8 /workspace/ab.png | od -An -tx1 | tr -d ' ')\" \"\$(agent-browser get cdp-url | sed -E 's#devtools/browser/.*#devtools#')\"; echo $m")
echo "$out"
check "agent-browser returns the title of example.org" "$out" 'title=Example Domain'
check "its screenshot is a PNG in /workspace" "$out" 'png=89504e470d0a1a0a'
check "it drives the Chromium that pi-browser started (CDP on 127.0.0.1:9222)" "$out" 'ws://127.0.0.1:9222/devtools'

# ------------------------------------------------------------------ 4. what must not be reachable
echo "## 4. cluster, platform, OneCLI, metadata and LAN are unreachable; blocked schemes; no credential for github.com"
m=m$RANDOM
probe() { # URL -> prints "<short>=<error or title>"
  printf '%s' "r=\$(agent-browser open $1 2>&1 | head -1 | grep -oE 'ERR_[A-Z_]+|✓.*' | head -1); printf '%s ' \"\${r:-none}\";"
}
urls="https://10.96.0.1/ https://169.254.169.254/ https://192.168.1.1/ https://kubernetes.default.svc/ https://pi-ingest.$namespace.svc:8080/ https://onecli-gateway.$namespace.svc:10255/"
cmd="$pre"
for u in $urls; do cmd+=" $(probe "$u")"; done
out=$(sandbox "$sa" "net-$m" "$cmd echo $m")
echo "$out"
refute "none of them loaded (every navigation failed)" "$out" '✓'
check "all six were refused or unresolvable" "$out" '^(ERR_[A-Z_]+ ){6}'
m=m$RANDOM
# A page load between the blocked navigations: Chromium 159 can crash (SIGTRAP) on two blocked navigations in a row to
# chrome:// after file://, which pi-browser start recovers from (ADR 0041, known issue).
reload="agent-browser open https://example.org >/dev/null 2>&1;"
out=$(sandbox "$sa" "scheme-$m" "$pre $(probe file:///etc/passwd) $reload sleep 2; $(probe chrome://version) $reload sleep 2; $(probe view-source:https://example.com) echo $m")
echo "$out"
check "file:// and chrome:// are blocked by policy" "$out" 'ERR_BLOCKED_BY_ADMINISTRATOR ERR_BLOCKED_BY_ADMINISTRATOR'
m=m$RANDOM
out=$(sandbox "$sa" "gh-$m" "$pre agent-browser open https://github.com/octocat/Hello-World 2>&1 | head -1; printf ' title=%s' \"\$(agent-browser get title | cut -c1-40)\"; echo $m")
echo "$out"
check "github.com loads in the browser through the proxy" "$out" 'title=.*Hello-World'
why=$(api POST /admin/egress/explain "{\"host\":\"github.com\",\"sessionId\":\"$sa\"}")
check "the proxy allows github.com for the session by the open-web rules" "$why" '"decision":"allow"'
refute "and routes it directly: no OneCLI route, no credential injection" "$why" '"route":"onecli"'
check "the session has no OneCLI binding" "$why" '"binding":false'

# a host that the rules do not allow is refused: a second browser profile with a narrow rule set
run=$(printf '%04x' "$RANDOM")
narrow=smoke-browser-$run
profiles+=("$narrow")
api PUT "/admin/profiles/$narrow" '{"definition":{"sandboxFlavour":"browser","egressRuleSets":["github-public"]}}' >/dev/null
sb=$(kc create "$narrow" | sed -n 's/^session //p')
sessions+=("$sb")
m=m$RANDOM
out=$(sandbox "$sb" "narrow-$m" "$pre pi-browser start >/dev/null; $(probe https://example.com/) $(probe https://raw.githubusercontent.com/octocat/Hello-World/master/README) echo $m")
echo "$out"
check "a host that the profile's rules do not allow is refused, one they allow loads" "$out" '^ERR_[A-Z_]+ ✓'

# ------------------------------------------------------------------ 5. no direct network attempt, CDP on loopback
echo "## 5. no UDP, no DNS, CDP on loopback only"
m=m$RANDOM
out=$(sandbox "$sa" "udp-$m" "$pre printf 'udp_sockets=%s dns=%s listen=%s ' \"\$(cat /proc/net/udp /proc/net/udp6 2>/dev/null | grep -vc local_address)\" \"\$(getent hosts example.com >/dev/null 2>&1 && echo works || echo none)\" \"\$(awk 'NR>1 && \$4==\"0A\" {print \$2}' /proc/net/tcp /proc/net/tcp6 | tr '\\n' ',')\"; echo $m")
echo "$out"
check "the browser holds no UDP socket (QUIC, mDNS, DNS) after browsing" "$out" 'udp_sockets=0'
check "the sandbox itself resolves no name: only the proxy does" "$out" 'dns=none'
check "CDP (9222) listens on 127.0.0.1" "$out" 'listen=.*0100007F:2406'
check "the forwarder (3129) listens on 127.0.0.1" "$out" 'listen=.*0100007F:0C39'
# Everything else that listens is sandboxd (8080 and 9090, the base image) or a tool's own loopback socket.
others=$(sed -n 's/.*listen=\([^ ]*\) .*/\1/p' <<<"$out" | tr ',' '\n' | grep -v '^$' | grep -v '^0100007F:' | grep -vE ':(1F90|2382)$' || true)
[[ -z $others ]] || fail "a listener other than sandboxd is not on loopback: $others"
ok "no other listener is reachable from outside the Pod's loopback besides sandboxd (8080, 9090)"

# ------------------------------------------------------------------ 6. footprint
echo "## 6. memory and CPU"
m=m$RANDOM
meas='m() { a=$(awk "/^anon /{print \$2}" /sys/fs/cgroup/memory.stat); c=$(cat /sys/fs/cgroup/memory.current); u=$(awk "/^usage_usec/{print \$2}" /sys/fs/cgroup/cpu.stat); printf "%s anon=%sMi current=%sMi cpu=%sms; " "$1" $((a/1048576)) $((c/1048576)) $((u/1000)); };'
out=$(sandbox "$sa" "idle-$m" "$pre $meas pi-browser stop; sleep 3; m none; pi-browser start >/dev/null; sleep 15; m idle; echo $m")
echo "measure: $out"
out=$(sandbox "$sa" "page-$m" "$pre $meas m before; agent-browser open https://en.wikipedia.org/wiki/Kubernetes >/dev/null 2>&1; m wikipedia; agent-browser open https://github.com/kubernetes/kubernetes >/dev/null 2>&1; m github; printf 'peak=%sMi' \$(( \$(cat /sys/fs/cgroup/memory.peak)/1048576 )); echo $m")
echo "measure: $out"
check "the browser is still running after the pages (no OOM, no crash)" "$(sandbox "$sa" "alive-$m" "$pre pi-browser status; cat /tmp/pi-browser/exit.log 2>/dev/null; echo $m")" '^running'

echo
echo "all browser checks passed"
