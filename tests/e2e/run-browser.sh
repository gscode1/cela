#!/usr/bin/env bash
# Browser sandbox acceptance tests (issue #267, ADR 0041): Chromium, Patchright and agent-browser in a gVisor sandbox behind
# the egress proxy, driven by scripted bash steps (deterministic) and by a LIVE model through OneCLI (a few real turns: spend).
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh browser`, which installs the chart with
# egressProxy.enabled and sandbox.flavours.browser.enabled (tests/e2e/chart-values.py), on the chart's default runtime
# (gVisor). Not part of `all`: it needs the browser and egress proxy images, the OneCLI secrets and the internet.
#
#   seed        hack/seed-browser-profile.mjs seeds the `browser` profile and both skills; a second run changes nothing
#   gvisor      a session on the profile runs in a Pod of runtimeClass gvisor with the browser image; Chromium starts under
#               gVisor (the wrapper's flags are enough, or the output says which are not); startup time and memory are noted
#   patchright  Patchright script: title of example.com and a PNG screenshot in /workspace
#   agent       agent-browser on the same Chromium: title and a PNG screenshot
#   denials     kube API (name and cluster IP), a platform Service, the metadata address, file:// and chrome:// are refused;
#               a host that a narrower profile's rules do not allow is refused, one they allow loads
#   live        openai-codex/gpt-6-luna on the browser profile: turn 1 uses the patchright skill, turn 2 agent-browser,
#               each to open https://example.com, report the title and save a screenshot under /workspace. Asserts the tool
#               calls, "Example Domain" in the answer and the PNG in the sandbox, not the wording
#
# ONLY="seed,gvisor" runs just those tests (they depend on each other in the order above: seed, gvisor, then the rest).
# SKIP_LIVE=1 leaves out the live test. Exit code: 0 when no test failed (SKIPPED is not a failure).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
: >"$sessions_file"

k() { kubectl ${ctx:+--context="$ctx"} -n "$ns" "$@"; }
log() { printf '\n== %s\n' "$*"; }
note() { printf '   %s\n' "$*"; }
now() { date +%s; }
# shellcheck source=fns.sh
. "$here/fns.sh"
E2E_TEST_PREFIX=""
E2E_ERR_TRAP=1

ingest_pod() {
  k get pods -l app.kubernetes.io/name=pi-ingest -o json |
    jq -r '[.items[] | select(.status.phase=="Running" and .metadata.deletionTimestamp==null)][0].metadata.name // empty'
}
api() { k exec -i "$(ingest_pod)" -c ingest -- node - call "$@" <"$here/client-4b.mjs"; }
results() { k exec -i "$(ingest_pod)" -c ingest -- node - results "$@" <"$here/client-4b.mjs"; }

cleanup() {
  local id
  while read -r id; do
    [[ -n $id ]] || continue
    api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  rm -rf "$work"
}
trap cleanup EXIT

assert_eq() { # description expected actual
  if [[ $2 == "$3" ]]; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $2"
    note "  got: $3"
    exit 1
  fi
}
assert_jq() { # description json jq-expression
  if jq -e "$3" <<<"$2" >/dev/null 2>&1; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  expected: $3"
    note "  got: $(printf '%s' "$2" | cut -c1-600)"
    exit 1
  fi
}
assert_match() { # description text extended-regex
  if grep -Eq -- "$3" <<<"$2"; then note "ok: $1"; else
    note "ASSERT FAILED: $1"
    note "  wanted: /$3/"
    note "  got: $(printf '%s' "$2" | cut -c1-600)"
    exit 1
  fi
}
refute_match() { # description text extended-regex
  if grep -Eq -- "$3" <<<"$2"; then
    note "ASSERT FAILED: $1"
    note "  did not want: /$3/"
    note "  got: $(printf '%s' "$2" | cut -c1-600)"
    exit 1
  else note "ok: $1"; fi
}

new_session() { # body-json -> response JSON; records the id for cleanup
  local out
  out=$(api alice POST /sessions "$1")
  jq -r '.body.sessionId // empty' <<<"$out" >>"$sessions_file"
  printf '%s' "$out"
}
# sbx SESSION MARKER BASH -> the text of the tool result of one scripted bash step in that session's sandbox
sbx() {
  local script res
  script=$(jq -nc --arg b "$3" --arg f "$2" '{steps:[{bash:$b, timeout:300}], final:$f}')
  api alice POST "/sessions/$1/events" "$(jq -nc --arg t "$script" '{kind:"message", text:$t}')" >/dev/null
  res=$(results alice "$1" "$2" 900)
  jq -e '.found==true' <<<"$res" >/dev/null || { note "no answer from the scripted session: $(cut -c1-400 <<<"$res")"; return 1; }
  jq -r '.results[-1].text' <<<"$res"
}
claim_of() { k get sandboxclaims -l "cela/session-id=$1" -o jsonpath='{.items[0].metadata.name}'; }
# The sandbox's own exec, for what the test reads outside a model's tool call.
sandbox_sh() { # claim shell-command
  local pod=$1
  k exec "$pod" -c "$(k get pod "$pod" -o jsonpath='{.spec.containers[0].name}')" -- sh -c "$2"
}
png_magic() { sandbox_sh "$1" "head -c 8 $2 2>/dev/null | od -An -tx1 | tr -d ' \n'"; }
pre='export NODE_NO_WARNINGS=1; cd /workspace;'
# shellcheck disable=SC2016 # the printf format is the command the sandbox runs, not expanded here
probe() { # URL -> a command that prints "<ERR_...|✓ title|none> "
  printf 'r=$(agent-browser open %s 2>&1 | head -1 | grep -oE "ERR_[A-Z_]+|✓.*" | head -1); printf "%%s " "${r:-none}";' "$1"
}

# ---------------------------------------------------------------- tests
t_seed() {
  local tokens token out again def sess
  tokens=$(k exec "$(ingest_pod)" -c ingest -- printenv PI_API_TOKENS)
  token=$(sed -n 's/^alice://p' <<<"$tokens" | head -1)
  tokens=""
  [[ -n $token ]] || { note "ASSERT FAILED: no API token for alice"; exit 1; }
  out=$(PI_API_URL=http://pi-ingest:8080 PI_API_TOKEN=$token node "$root/hack/seed-browser-profile.mjs") || { note "seeding failed: $out"; exit 1; }
  assert_match "both skills published and the profile written" "$out" 'profile browser v[0-9]+ (written|unchanged)'
  again=$(PI_API_URL=http://pi-ingest:8080 PI_API_TOKEN=$token node "$root/hack/seed-browser-profile.mjs")
  assert_match "seeding again changes nothing" "$again" 'profile browser v[0-9]+ unchanged'
  token=""
  def=$(api alice GET /admin/profiles/browser | jq -c '.body.definition')
  assert_jq "the profile is browser flavour, proxied, open-web, with both skills" "$def" \
    '.sandboxFlavour=="browser" and .networkMode=="proxied" and .egressRuleSets==["open-web"] and (.skills|map(.name)|sort)==["agent-browser","patchright"]'
  sess=$(new_session '{"provider":"scripted","model":"scripted-1","profile":"browser"}')
  assert_jq "a scripted session on the browser profile is created" "$sess" '.status==201'
  jq -r '.body.sessionId' <<<"$sess" >"$work/det_session"
  assert_jq "it reports the browser flavour" "$(api alice GET "/sessions/$(cat "$work/det_session")")" '.body.sandboxFlavour=="browser"'
}

t_gvisor() {
  local id out claim t0 t1 pod shm
  id=$(cat "$work/det_session")
  out=$(sbx "$id" env-$RANDOM "$pre printf 'user=%s shm=%s skills=' \"\$(id -u)\" \"\$(df -m /dev/shm | awk 'NR==2{print \$2}')\"; ls /workspace/.skills | tr '\\n' ' '")
  note "sandbox: $out"
  assert_match "uid 1000 and both skills in /workspace/.skills" "$out" 'user=1000 .*skills=.*(agent-browser.*patchright|patchright.*agent-browser)'
  # gVisor's tmpfs does not report the volume's 256 Mi size limit (measured on the first run: 15874 MB), so only a floor is asserted.
  shm=$(sed -n 's/.*shm=\([0-9]*\).*/\1/p' <<<"$out")
  [[ ${shm:-0} -ge 256 ]] || { note "ASSERT FAILED: /dev/shm is ${shm:-unknown} MB, wanted at least 256 (the wrapper would add --disable-dev-shm-usage)"; exit 1; }
  note "ok: /dev/shm reports ${shm} MB (at least 256)"
  claim=$(claim_of "$id")
  pod=$claim
  assert_eq "the Pod runs under the gvisor RuntimeClass" gvisor "$(k get pod "$pod" -o jsonpath='{.spec.runtimeClassName}')"
  assert_match "the Pod runs the browser image" "$(k get pod "$pod" -o jsonpath='{.spec.containers[0].image}')" 'pi-sandbox-browser'
  # gVisor's kernel identifies itself: the sandbox's dmesg is gVisor's, not a node's.
  note "kernel as the sandbox sees it: $(sandbox_sh "$pod" 'uname -sr; dmesg 2>/dev/null | head -2 | tr "\n" "|"' | tr '\n' ' ')"
  t0=$(date +%s%3N)
  out=$(sbx "$id" start-$RANDOM "$pre pi-browser stop; pi-browser start 2>&1 | tail -1; pi-browser status; pi-chromium --version 2>&1 | head -1; printf 'exitlog=%s' \"\$(wc -l </tmp/pi-browser/exit.log 2>/dev/null || echo 0)\"")
  t1=$(date +%s%3N)
  note "pi-browser start, whole step: $((t1 - t0)) ms; output: $(tr '\n' '|' <<<"$out")"
  assert_match "Chromium starts under gVisor with the wrapper's own flags (no extra flag needed)" "$out" 'running http://127.0.0.1:9222'
  refute_match "Chromium did not exit on its own" "$out" 'exitlog=[1-9]'
  out=$(sbx "$id" mem-$RANDOM "$pre sleep 10; a=\$(awk '/^anon /{print \$2}' /sys/fs/cgroup/memory.stat 2>/dev/null); c=\$(cat /sys/fs/cgroup/memory.current 2>/dev/null); u=\$(awk '/^usage_usec/{print \$2}' /sys/fs/cgroup/cpu.stat 2>/dev/null); printf 'anon=%sMi current=%sMi cpu=%sms procs=%s' \$((\${a:-0}/1048576)) \$((\${c:-0}/1048576)) \$((\${u:-0}/1000)) \"\$(ls /proc | grep -c '^[0-9]')\"")
  note "measure (idle Chromium under gVisor): $out"
}

t_patchright() {
  local id out png
  id=$(cat "$work/det_session")
  out=$(sbx "$id" pw-$RANDOM "$pre pi-browser start >/dev/null && patchright-run -e 'const {chromium}=require(\"patchright\");(async()=>{const b=await chromium.connectOverCDP(\"http://127.0.0.1:9222\");const p=await b.contexts()[0].newPage();await p.goto(\"https://example.com\",{waitUntil:\"domcontentloaded\",timeout:30000});console.log(\"Page Title: \"+await p.title());await p.screenshot({path:\"/workspace/pw-det.png\"});await p.close();await b.close()})().catch(e=>{console.error(e.message);process.exit(1)})' | tr '\\n' ' '; echo done")
  note "output: $out"
  assert_match "Patchright returns the title of example.com" "$out" 'Page Title: Example Domain'
  png=$(png_magic "$(claim_of "$id")" /workspace/pw-det.png)
  assert_eq "its screenshot is a PNG in /workspace" 89504e470d0a1a0a "$png"
}

t_agent() {
  local id out png
  id=$(cat "$work/det_session")
  out=$(sbx "$id" ab-$RANDOM "$pre agent-browser open https://example.org >/dev/null; printf 'title=%s ' \"\$(agent-browser get title)\"; agent-browser screenshot /workspace/ab-det.png >/dev/null; printf 'cdp=%s' \"\$(agent-browser get cdp-url | sed -E 's#devtools/browser/.*#devtools#')\"")
  note "output: $out"
  assert_match "agent-browser returns the title of example.org" "$out" 'title=Example Domain'
  assert_match "it drives the Chromium that pi-browser started" "$out" 'ws://127.0.0.1:9222/devtools'
  png=$(png_magic "$(claim_of "$id")" /workspace/ab-det.png)
  assert_eq "its screenshot is a PNG in /workspace" 89504e470d0a1a0a "$png"
}

t_denials() {
  local id out cmd u narrow sb why
  id=$(cat "$work/det_session")
  # The API server twice: by name and by the Service's cluster IP (the driver's own KUBERNETES_SERVICE_HOST).
  cmd="$pre pi-browser start >/dev/null;"
  for u in "https://kubernetes.default.svc/" "https://${KUBERNETES_SERVICE_HOST:-10.96.0.1}/" "https://pi-ingest.$ns.svc:8080/" "https://169.254.169.254/"; do
    cmd+=" $(probe "$u")"
  done
  out=$(sbx "$id" net-$RANDOM "$cmd echo")
  note "kube API (name, IP), a platform Service, the metadata address: $out"
  refute_match "none of them loaded" "$out" '✓'
  assert_match "all four were refused or unresolvable" "$out" '^(ERR_[A-Z_]+ ){4}'
  # A page load between the blocked schemes: Chromium can crash on two blocked navigations in a row (ADR 0041, known issue).
  local reload="agent-browser open https://example.org >/dev/null 2>&1; sleep 2;"
  out=$(sbx "$id" scheme-$RANDOM "$pre $(probe file:///etc/passwd) $reload $(probe chrome://version) $reload echo")
  note "file://, chrome://: $out"
  assert_match "file:// and chrome:// are blocked by policy" "$out" 'ERR_BLOCKED_BY_ADMINISTRATOR ERR_BLOCKED_BY_ADMINISTRATOR'
  why=$(api alice POST /admin/egress/explain "$(jq -nc --arg s "$id" '{host:"github.com", sessionId:$s}')")
  assert_match "the proxy allows github.com for the session by the open-web rules" "$why" '"decision":"allow"'
  refute_match "and routes it directly: no OneCLI route, no credential injection" "$why" '"route":"onecli"'

  # A host that the rules do not allow: a second browser profile with a narrow rule set.
  narrow=e2e-browser-$(printf '%04x' "$RANDOM")
  assert_jq "a narrow browser profile is created" "$(api alice PUT "/admin/profiles/$narrow" '{"definition":{"sandboxFlavour":"browser","egressRuleSets":["github-public"]}}')" '.status==200 or .status==201'
  sb=$(jq -r '.body.sessionId' <<<"$(new_session "$(jq -nc --arg p "$narrow" '{provider:"scripted", model:"scripted-1", profile:$p}')")")
  out=$(sbx "$sb" narrow-$RANDOM "$pre pi-browser start >/dev/null; $(probe https://example.com/) $(probe https://raw.githubusercontent.com/octocat/Hello-World/master/README) echo")
  note "a host outside the rules, then one inside: $out"
  assert_match "the host the profile's rules do not allow is refused, the one they allow loads" "$out" '^ERR_[A-Z_]+ ✓'
  api alice PUT "/admin/profiles/$narrow" '{"enabledForNew":false}' >/dev/null 2>&1 || true
}

live_turn() { # session label tool-needle prompt -> prints the results JSON (no notes: the caller captures stdout)
  local id=$1
  api alice POST "/sessions/$id/events" "$(jq -nc --arg t "$4" '{kind:"message", text:$t}')" >/dev/null
  results alice "$id" "Example Domain" 600 "$3"
}
t_live() {
  local out id res claim n png deadline start
  [[ ${SKIP_LIVE:-0} != 1 ]] || { note "SKIPPED: SKIP_LIVE=1"; return 3; }
  if ! k get secret pi-onecli -o name >/dev/null 2>&1; then
    note "SKIPPED: Secret pi-onecli does not exist in the namespace (see docs/model-credentials.md)"
    return 3
  fi
  out=$(new_session '{"provider":"openai-codex","model":"gpt-6-luna","profile":"browser"}')
  assert_jq "a session on openai-codex/gpt-6-luna and the browser profile is created" "$out" '.status==201'
  id=$(jq -r '.body.sessionId' <<<"$out")
  start=$(now)

  res=$(live_turn "$id" "turn 1" patchright \
    'Use the patchright skill to open https://example.com, tell me the page title, and save a screenshot to /workspace/pw.png. Keep it short and end by stating the title.')
  assert_jq "turn 1: the model answered with the title after calling patchright" "$res" '.found==true'
  note "turn 1: $(jq -r '.calls|length' <<<"$res") tool call(s); answer: $(jq -r '.answer' <<<"$res" | tr '\n' ' ' | cut -c1-300)"
  assert_jq "turn 1 ran patchright through a tool call" "$res" '[.calls[] | select(contains("patchright"))] | length > 0'
  assert_jq "the answer has the title" "$res" '.answer|test("Example Domain";"i")'
  claim=$(claim_of "$id")
  assert_eq "the live session runs under gVisor" gvisor "$(k get pod "$claim" -o jsonpath='{.spec.runtimeClassName}')"
  deadline=$(($(now) + 90))
  while [[ $(now) -lt $deadline ]]; do
    png=$(png_magic "$claim" /workspace/pw.png || true)
    [[ $png == 89504e470d0a1a0a ]] && break
    sleep 3
  done
  assert_eq "turn 1 left a PNG at /workspace/pw.png" 89504e470d0a1a0a "$png"

  res=$(live_turn "$id" "turn 2" agent-browser \
    'Now use the agent-browser skill to open https://example.com again, tell me the page title, and save a screenshot to /workspace/ab.png. Keep it short and end by stating the title.')
  assert_jq "turn 2: the model answered with the title after calling agent-browser" "$res" '.found==true'
  note "turn 2: $(jq -r '.calls|length' <<<"$res") tool call(s) in all; answer: $(jq -r '.answer' <<<"$res" | tr '\n' ' ' | cut -c1-300)"
  assert_jq "turn 2 ran agent-browser through a tool call" "$res" '[.calls[] | select(contains("agent-browser"))] | length > 0'
  assert_jq "the answer has the title" "$res" '.answer|test("Example Domain";"i")'
  deadline=$(($(now) + 90))
  while [[ $(now) -lt $deadline ]]; do
    png=$(png_magic "$claim" /workspace/ab.png || true)
    [[ $png == 89504e470d0a1a0a ]] && break
    sleep 3
  done
  assert_eq "turn 2 left a PNG at /workspace/ab.png" 89504e470d0a1a0a "$png"
  n=$(jq -r '.calls|length' <<<"$res")
  assert_jq "the session is still active" "$(api alice GET "/sessions/$id")" '.body.status=="active"'
  note "live test: $(($(now) - start)) s for two turns, $n tool calls in the transcript"
  # Names only: the model credential is the orchestrator's through OneCLI and never in the sandbox.
  n=$(sandbox_sh "$claim" "env | cut -d= -f1 | grep -ciE 'openai|anthropic|codex|api_key' || true")
  assert_eq "no model credential variable in the sandbox environment" 0 "${n//[$'\r\n ']/}"
}

# ---------------------------------------------------------------- driver
# One sandbox and one Chromium are shared by the deterministic tests, in the order of the header; everything is serial.
e2e_serial seed t_seed
e2e_serial gvisor t_gvisor
e2e_serial patchright t_patchright
e2e_serial agent t_agent
e2e_serial denials t_denials
e2e_serial live t_live

log "summary"
for line in "${summary[@]}"; do note "$line"; done
note "passed=$pass failed=$fail skipped=$skip"
log "RESULT"
printf '%s\n' "${summary[@]}"
if [[ $fail -ne 0 ]]; then
  echo "BROWSER: FAILED" >&2
  exit 1
fi
echo "BROWSER: all tests passed"
