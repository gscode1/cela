#!/usr/bin/env bash
# Phase 4c acceptance tests: the optional repository workspace through OneCLI and a repo-scoped GitHub App token.
# Runs IN the cluster as the e2e-driver Job started by `tests/e2e/run.sh phase4c`. Run live on 2026-11-16 (plan.md). It needs the new
# sandbox image (git + ca-certificates) in the SandboxTemplate, the ExternalSecrets pi-github-app and pi-onecli-admin
# synced, the OneCLI CA ConfigMap, and the NetworkPolicies that let the orchestrator reach api.github.com.
#
#   no-repo       a session without a repo is unchanged: no repo columns, no OneCLI agent or secret, no repo directory
#   clone-push    REPO_A (private): cloned before the first turn, the OneCLI agent holds exactly the session's two GitHub
#                 secrets (no LLM key, no connection), a push to a test branch works and the branch is removed again,
#                 and no GitHub token is readable in the sandbox. With the egress proxy on (run.sh's default for this
#                 suite; ADR 0037) also: the sandbox's HTTPS_PROXY is the egress proxy and it holds no OneCLI gateway
#                 address or agent token, the session has a binding and route=onecli rules for github.com and
#                 api.github.com, and the proxy logged this session's github.com tunnels as allowed with route onecli
#                 (none direct)
#   restart-skip  after an orchestrator restart the clone is found and skipped (log `workspace-present`, no
#                 `workspace-cloned`), and a file the agent wrote in the clone is still there
#   scope         the GitHub App installation covers REPO_B (a read-only token scoped to B is minted in the orchestrator
#                 and revoked at once; without that the next check would prove nothing), and the token for REPO_A
#                 cannot read REPO_B (`git ls-remote`, read only) while it can reach REPO_A
#   tools         (proxy on) a repo session on a profile with the `packages` rules uses the default image's tools
#                 through the proxy: node 22, `npm ci`, pnpm through corepack, a venv and `pip install`, curl to
#                 api.github.com for REPO_A (only the OneCLI-injected token can read it), and gh: a PR on a test branch
#                 of REPO_A, a comment on it, then the PR closed and the branch deleted (docs/sandbox-image.md)
#   delete        after DELETE the OneCLI agent and both secrets are gone and the tombstone is completed; with the
#                 proxy on, the binding and the session's rules are gone too
#
# REPO_A and REPO_B (owner/name) are required for the last four; without them those tests are SKIPPED, never faked.
# ONLY="no-repo,clone-push" runs just those tests. clone-push creates the shared repo session; the later tests reuse
# it, so run them together (restart-skip, scope and delete SKIP when it does not exist).
#
# All OneCLI API calls run inside the orchestrator pod (`kubectl exec ... node`), which already holds ONECLI_API_KEY:
# no key or token is read, passed or printed here. Exit code: 0 when no test failed (SKIPPED is not a failure).
set -euo pipefail

ctx=${KUBE_CONTEXT:-}
ns=${NAMESPACE:?NAMESPACE is the e2e run namespace; tests/e2e/run.sh sets it in the Job}
# The OneCLI name prefix of this run's orchestrator (PI_ONECLI_NAME_PREFIX, set by run.sh in the Job and in the overlay).
# The OneCLI workspace is shared with other stacks, so the suite finds only its own stack's agents and secrets by it.
: "${PI_ONECLI_API:?PI_ONECLI_API is required; tests/e2e/job.yaml.tpl sets it}"
onecli_prefix=${PI_ONECLI_NAME_PREFIX:?PI_ONECLI_NAME_PREFIX is the OneCLI name prefix of the run; tests/e2e/run.sh sets it in the Job}
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
sessions_file=$work/sessions
repo_session_file=$work/repo-session
: >"$sessions_file"
run_id=$(date +%s)
branch="agent/pi-e2e-$run_id" # any name works (ADR 0027); agent/ keeps test repos that still carry the old ruleset working

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
stream_has() { k exec -i "$(ingest_pod)" -c ingest -- node - stream "$@" <"$here/client-4b.mjs"; }
answer_has() { k exec -i "$(ingest_pod)" -c ingest -- node - answer "$@" <"$here/client-4b.mjs" | cut -d" " -f1; }
sql() { e2e_db -c "$1"; }
orch_log() { k logs deploy/pi-orchestrator --tail=2000; }
# 1 when the chart runs the egress proxy (the orchestrator gives sandboxes its address), as in run-phase3.sh.
egress_proxy_on() {
  [[ -n $(k get deployment pi-orchestrator -o jsonpath='{.spec.template.spec.containers[?(@.name=="orchestrator")].env[?(@.name=="PI_EGRESS_PROXY_URL")].value}') ]]
}
addr_of() { getent ahostsv4 "$1" | awk 'NR==1 {print $1}'; }
# The egress proxy's decisions (Smokescreen's CANONICAL-PROXY-DECISION, one JSON line per tunnel) of all replicas,
# reduced to the fields the tests need. role is the session id; no token is ever in these lines.
proxy_decisions() {
  k logs -l app.kubernetes.io/name=pi-egress-proxy --tail=-1 --max-log-requests=10 |
    jq -c -R 'fromjson? | select(.msg == "CANONICAL-PROXY-DECISION") | {role, requested_host, allow, decision_reason}'
}
# Counts this session's decisions for github.com:443 that a jq condition selects.
proxy_github_count() { # session condition
  proxy_decisions | jq -s --arg s "$1" "[.[] | select(.role == \$s and (.requested_host | test(\"^github[.]com(:443)?\$\")) and ($2))] | length"
}
explain() { # host session -> the admin explain answer's body
  api alice POST /admin/egress/explain "$(jq -nc --arg h "$1" --arg s "$2" '{host:$h, sessionId:$s}')" | jq -c .body
}
# Whether the GitHub App installation covers a repository: the orchestrator (which holds the App key, ADR 0042) mints a
# token scoped to it with only metadata:read, checks GitHub named exactly that repository, and revokes it at once.
# Prints "covered ..." or "not-covered ..."; nothing secret (no token, no installation id) is printed.
github_covers() { # owner/name
  k exec deploy/pi-orchestrator -c orchestrator -- node --input-type=module -e '
    import { GITHUB_APP_DIR, loadGithubApp, signAppJwt } from "/app/dist/github-app.js";
    const repo = process.argv[1];
    const base = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "cela-e2e-client" };
    try {
      const app = await loadGithubApp(GITHUB_APP_DIR);
      const r = await fetch(`https://api.github.com/app/installations/${app.installationId}/access_tokens`, {
        method: "POST",
        headers: { ...base, authorization: `Bearer ${signAppJwt(app, Date.now())}`, "content-type": "application/json" },
        body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions: { metadata: "read" } }),
      });
      if (r.status !== 201) { console.log(`not-covered HTTP ${r.status}`); process.exit(0); }
      const body = await r.json();
      const granted = (body.repositories ?? []).map((e) => String(e.full_name).toLowerCase());
      const revoke = await fetch("https://api.github.com/installation/token", {
        method: "DELETE", headers: { ...base, authorization: `Bearer ${body.token}` } });
      const exact = granted.length === 1 && granted[0] === repo.toLowerCase();
      console.log(exact ? `covered (token revoked: HTTP ${revoke.status})` : `not-covered: ${granted.length} repositories granted`);
    } catch (e) { console.log(`not-covered: ${e.message}`); }' "$1"
}

# OneCLI management API through the orchestrator pod, which holds the key. Prints the response body.
onecli() { # METHOD PATH
  k exec deploy/pi-orchestrator -c orchestrator -- node -e '
    const [method, path] = process.argv.slice(1);
    fetch(process.env.PI_ONECLI_API + path, {
      method, headers: { authorization: `Bearer ${process.env.ONECLI_API_KEY}` } })
      .then(async (r) => {
        // An HTTP error body would parse as "nothing found" and make a negative assertion pass.
        if (!r.ok) { console.error(`OneCLI ${method} ${path}: HTTP ${r.status}`); process.exit(1); }
        process.stdout.write(await r.text() || "[]");
      })
      .catch((e) => { console.error(e.message); process.exit(1); });' "$1" "$2"
}
# Counts the objects a jq filter selects in a OneCLI listing. A failed request prints "onecli-error", never 0.
onecli_count() { # PATH jq-args... filter
  local body
  body=$(onecli GET "$1") || {
    echo onecli-error
    return 0
  }
  jq "${@:2}" <<<"$body"
}

cleanup() {
  local id
  while read -r id; do
    [[ -n $id ]] || continue
    api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  done <"$sessions_file"
  # Wait until every session is `deleted` (bounded), so the claims and OneCLI objects are gone when the run ends.
  # A failed query is not "nothing left": it is retried until the deadline.
  local list deadline pending drained=0
  list=$(grep -v '^$' "$sessions_file" | sed "s/.*/'&'/" | paste -sd, - || true) # no session created: empty list
  deadline=$(($(now) + 180))
  while [[ -n $list && $(now) -lt $deadline ]]; do
    if pending=$(sql "select id from inbox.sessions where status <> 'deleted' and id in ($list)" 2>/dev/null) && [[ -z $pending ]]; then
      drained=1
      break
    fi
    sleep 3
  done
  [[ -z $list || $drained -eq 1 ]] || note "cleanup: sessions not deleted after the wait (or status unreadable); their claims may remain"
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
    note "  got: $(printf '%s' "$2" | cut -c1-500)"
    exit 1
  fi
}
wait_status() { # owner session wanted-status timeout-seconds
  local deadline=$(($(now) + $4)) out
  while :; do
    out=$(api "$1" GET "/sessions/$2")
    if [[ $(jq -r '.body.status // empty' <<<"$out") == "$3" ]]; then
      printf '%s' "$out"
      return 0
    fi
    if [[ $(now) -ge $deadline ]]; then
      note "TIMEOUT after $4s waiting for session $2 to be $3"
      return 1
    fi
    sleep 2
  done
}
script() { # final cmd... -> the scripted model's input: one bash step per command
  local final=$1 steps='[]' cmd
  shift
  for cmd in "$@"; do steps=$(jq -c --arg b "$cmd" '. + [{bash:$b, timeout:300}]' <<<"$steps"); done
  jq -nc --argjson s "$steps" --arg f "$final" '{steps:$s, final:$f}'
}
send() { # session final cmd... -> posts the script as a message
  local id=$1
  shift
  api alice POST "/sessions/$id/events" "$(jq -nc --arg t "$(script "$@")" '{kind:"message", text:$t}')" >/dev/null
}
# stream_has searches the whole stream, the user's message included. Needles inside commands are split with '' (kept
# by the outer double quotes, removed by the sandbox's bash), so only tool output contains them. Final answers are
# in the message too, so wait for them with answer_has (assistant text after a tool call).
need_repos() {
  if [[ -z ${REPO_A:-} || -z ${REPO_B:-} ]]; then
    note "SKIPPED: set REPO_A and REPO_B (owner/name, private, in the GitHub App installation) to run this test"
    return 3
  fi
}
need_repo_session() {
  need_repos || return 3
  if [[ ! -s $repo_session_file ]]; then
    note "SKIPPED: the shared repo session does not exist (run clone-push first)"
    return 3
  fi
  repo_session=$(cat "$repo_session_file")
}
repo_session=""

# ---------------------------------------------------------------- tests
t_no_repo() {
  local out id
  out=$(api alice POST /sessions '{"provider":"scripted","model":"scripted-1"}')
  assert_jq "session created" "$out" '.status==201 and (.body|has("repo")|not)'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  send "$id" plain-done "pwd" "ls -A /workspace | wc -l"
  # answer_has, not stream_has: the final answer text is also in the user's own message.
  assert_eq "the session answers" found "$(answer_has alice "$id" plain-done 90)"
  assert_eq "no repo columns, no OneCLI ids, no ready marker" "||" "$(sql "select coalesce(repo,'')||'|'||coalesce(onecli_agent_id,'')||'|'||coalesce(workspace_ready_at::text,'') from inbox.sessions where id='$id'")"
  assert_eq "no OneCLI agent exists for it" 0 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$id" '[.. | objects | select(.identifier? == $n)] | length')"
  assert_eq "no OneCLI secret exists for it" 0 "$(onecli_count /v1/secrets --arg n "${onecli_prefix}$id" '[.. | objects | select((.name? // "") | startswith($n))] | length')"
  out=$(api alice POST /sessions '{"repo":"https://github.com/a/b"}')
  assert_jq "a URL is refused" "$out" '.status==400'
  out=$(api alice POST /sessions '{"repo":"a/b","branch":"--upload-pack=x"}')
  assert_jq "an option-like branch is refused" "$out" '.status==400'
  out=$(api alice POST /sessions '{"repo":"a/../b"}')
  assert_jq "a traversal is refused" "$out" '.status==400'
  out=$(api alice POST /sessions '{"repo":"pi-e2e-not-listed/b"}')
  assert_jq "a repo off the allowlist is refused (ADR 0032)" "$out" '.status==403'
}

t_clone_push() {
  local out id sid agent_id grants names
  need_repos || return 3
  out=$(api alice POST /sessions "$(jq -nc --arg r "$REPO_A" '{provider:"scripted", model:"scripted-1", repo:$r}')")
  assert_jq "repo session created" "$out" '.status==201 and .body.repo!=null'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  echo "$id" >"$repo_session_file"
  sid=$id
  # With the proxy the sandbox's only way out is the proxy Service's address, and it must not hold the OneCLI gateway's
  # address or the agent token (aoc_...), which only the proxy (sealed binding) and the orchestrator have. Without the
  # proxy the sandbox has the gateway and the agent token by design, so there is nothing to check here.
  local proxy_checks=() needles=(CLONE_OK MARKER_OK ENV_CLEAN_OK FILES_CLEAN_OK PUSH_OK BRANCH_REMOVED) proxy_addr
  if [[ $proxied == 1 ]]; then
    proxy_addr=$(addr_of "pi-egress-proxy.$ns.svc.cluster.local")
    [[ -n $proxy_addr ]] || {
      note "ASSERT FAILED: the egress proxy Service does not resolve from the driver"
      exit 1
    }
    proxy_checks=(
      "case \"\${HTTPS_PROXY:-}\" in *@$proxy_addr:3128) echo PROXY_E''NV_OK ;; esac"
      "! env | grep -q -E 'aoc[_]|onecli[.]onecli|:10255' && echo NO_ONE''CLI_OK"
    )
    needles+=(PROXY_ENV_OK NO_ONECLI_OK)
  fi
  # Everything in one script: clone present, sentinel for the restart test, token checks, push, ls-remote, remove branch.
  send "$id" clone-push-finished \
    "test -d /workspace/repo/.git && echo CLONE_O''K" \
    "test -f /workspace/.pi-workspace.json && echo MARKER_O''K" \
    "echo sentinel >/workspace/repo/.e2e-sentinel" \
    "! env | grep -q -E 'ghs[_]|github_pat[_]' && echo ENV_CLE''AN_OK" \
    "! grep -r -q -E 'ghs[_]|github_pat[_]' /workspace/repo/.git/config && { [ ! -e /workspace/.onecli ] || ! grep -r -q -E 'ghs[_]|github_pat[_]' /workspace/.onecli; } && echo FILES_CLE''AN_OK" \
    ${proxy_checks[@]+"${proxy_checks[@]}"} \
    "cd /workspace/repo && git checkout -q -b $branch && date >e2e-$run_id.txt && git add e2e-$run_id.txt && git commit -q -m 'e2e $run_id' && git push -q origin HEAD:refs/heads/$branch && echo PUSH_O''K" \
    "cd /workspace/repo && git ls-remote origin refs/heads/$branch | wc -l" \
    "cd /workspace/repo && git push -q origin --delete $branch && echo BRANCH_REMO''VED"
  assert_eq "the session ran its script" found "$(answer_has alice "$id" clone-push-finished 240)"
  for needle in "${needles[@]}"; do
    assert_eq "tool output has $needle" found "$(stream_has alice "$id" "$needle" 20)"
  done
  assert_jq "the session is still active" "$(api alice GET "/sessions/$id")" '.body.status=="active"'
  assert_eq "the clone is recorded as ready" t "$(sql "select (workspace_ready_at is not null) from inbox.sessions where id='$id'" | tr -d ' ')"
  assert_eq "the orchestrator logged one clone" 1 "$(orch_log | grep -c "\"event\":\"workspace-cloned\".*$id")"

  agent_id=$(sql "select onecli_agent_id from inbox.sessions where id='$id'")
  [[ -n $agent_id ]] || {
    note "ASSERT FAILED: no OneCLI agent id stored"
    exit 1
  }
  grants=$(onecli GET "/v1/agents/$agent_id/grants")
  note "grants shape (ids only): $(jq -c '[.. | objects | keys] | add | unique' <<<"$grants" 2>/dev/null || echo unreadable)"
  names=$(onecli GET /v1/secrets | jq -r --arg n "${onecli_prefix}$sid" '[.. | objects | select((.name? // "") | startswith($n)) | .name] | sort | join(",")')
  assert_eq "exactly this session's two GitHub secrets exist" "${onecli_prefix}$sid-api,${onecli_prefix}$sid-git" "$names"
  # Narrow grants: the count of every id in the answer is 2 (the two secrets) and no connection appears.
  assert_eq "the agent holds exactly two grants and no connection" 2 "$(jq '[.. | objects | select(has("id") or has("secretId") or has("connectionId"))] | length' <<<"$grants")"
  assert_jq "no LLM secret is granted" "$grants" '([.. | strings | select(test("Codex|OpenRouter|openai|anthropic";"i"))] | length) == 0'
  # UNVERIFIED: whether the effective view of the gateway matches. A model-host request through this agent's token
  # should get 401 access_restricted (docs/model-credentials.md); not automated because the sandbox has no curl.
  if orch_log | grep -q -E 'ghs_|aoc_|oc_[0-9a-f]{8}'; then
    note "ASSERT FAILED: the orchestrator log holds something shaped like a GitHub token or OneCLI key"
    exit 1
  fi
  note "ok: no token-shaped text in the orchestrator log"

  [[ $proxied == 1 ]] || return 0
  # The route the proxy takes for this session (ADR 0037): its own route=onecli rules beat github-public's direct rule.
  local host ex n
  for host in github.com api.github.com; do
    ex=$(explain "$host" "$id")
    assert_jq "explain $host for the session: allow, route onecli, binding present" "$ex" '.decision=="allow" and .route=="onecli" and .binding==true'
  done
  # The clone (before the first turn), the push, ls-remote and the branch delete all opened tunnels through the proxy.
  n=$(proxy_github_count "$id" '.allow == true and .decision_reason == "allowed, route onecli"')
  [[ $n =~ ^[0-9]+$ && $n -ge 2 ]] || {
    note "ASSERT FAILED: the proxy logged $n allowed github.com tunnels with route onecli for the session (expected at least 2: clone and push)"
    exit 1
  }
  note "ok: the proxy logged $n github.com:443 tunnels of the session, all allowed with route onecli"
  note "EVIDENCE proxy: $(proxy_decisions | jq -c --arg s "$id" 'select(.role == $s)' | sort | uniq -c | tr -s ' ' | tr '\n' ';')"
  assert_eq "no github.com tunnel of the session went direct or was denied" 0 "$(proxy_github_count "$id" '.allow != true or .decision_reason != "allowed, route onecli"')"
}

# The default sandbox image's tools through the egress proxy (issue #318, docs/sandbox-image.md). A session of its own,
# on a profile that adds the `packages` rules (npm, PyPI); github.com and api.github.com reach OneCLI through the
# session's own rules. The PR it opens on REPO_A is closed and its branch deleted at the end of the same script.
t_tools() {
  local prof out id gh_branch="$branch-gh"
  need_repos || return 3
  if [[ $proxied != 1 ]]; then
    note "SKIPPED: the egress proxy is off (EGRESS_PROXY=0); this test checks the tools through the proxy"
    return 3
  fi
  prof=e2e-tools-$(printf '%04x' "$RANDOM")
  out=$(api alice PUT "/admin/profiles/$prof" '{"definition":{"egressRuleSets":["packages"]}}')
  assert_jq "a profile $prof with the packages rules is created" "$out" '.status==200 or .status==201'
  out=$(api alice POST /sessions "$(jq -nc --arg r "$REPO_A" --arg p "$prof" '{provider:"scripted", model:"scripted-1", repo:$r, profile:$p}')")
  assert_jq "a repo session on it is created" "$out" '.status==201 and .body.repo!=null'
  id=$(jq -r .body.sessionId <<<"$out")
  echo "$id" >>"$sessions_file"
  send "$id" tools-finished \
    "node -v | grep -q '^v22[.]' && echo NODE_O''K" \
    "rm -rf /tmp/npm-e2e && mkdir /tmp/npm-e2e && cd /tmp/npm-e2e && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0 >/dev/null && rm -rf node_modules && npm ci --no-audit --no-fund >/dev/null && test -f node_modules/is-number/package.json && echo NPM_CI_O''K" \
    "cd /tmp && pnpm -v && echo PNPM_O''K" \
    "python3 -m venv /tmp/venv-e2e && /tmp/venv-e2e/bin/pip install -q six==1.17.0 && /tmp/venv-e2e/bin/python -c 'import six' && echo PIP_O''K" \
    "curl -fsS -o /dev/null https://api.github.com/repos/$REPO_A && echo CURL_O''K" \
    "cd /workspace/repo && git checkout -q -b $gh_branch && git commit -q --allow-empty -m 'e2e gh $run_id' && git push -q origin HEAD:refs/heads/$gh_branch && gh pr create --head $gh_branch --title 'pi e2e $run_id' --body 'Opened and closed by the phase4c e2e suite.' >/dev/null && gh pr comment $gh_branch --body 'pi e2e comment' >/dev/null && echo GH_PR_COMMENT_O''K" \
    "cd /workspace/repo && { gh pr close $gh_branch --delete-branch >/dev/null 2>&1 || git push -q origin --delete $gh_branch; } && echo GH_CLEANUP_O''K"
  assert_eq "the session ran its script" found "$(answer_has alice "$id" tools-finished 600)"
  local needle
  for needle in NODE_OK NPM_CI_OK PNPM_OK PIP_OK CURL_OK GH_PR_COMMENT_OK GH_CLEANUP_OK; do
    assert_eq "tool output has $needle" found "$(stream_has alice "$id" "$needle" 20)"
  done
  api alice DELETE "/sessions/$id" >/dev/null 2>&1 || true
  api alice PUT "/admin/profiles/$prof" '{"enabledForNew":false}' >/dev/null 2>&1 || true
}

t_restart_skip() {
  need_repo_session || return 3
  # Scale 0 -> 1 rather than rollout restart: the driver may scale but not patch Deployments.
  k scale deploy/pi-orchestrator --replicas=0 >/dev/null
  k wait --for=delete pod -l app.kubernetes.io/instance=pi-orchestrator --timeout=120s >/dev/null 2>&1 || true
  k scale deploy/pi-orchestrator --replicas=1 >/dev/null
  k rollout status deploy/pi-orchestrator --timeout=300s >/dev/null
  # The first input after the restart prepares the workspace again: provision, re-mint, find the clone.
  send "$repo_session" after-restart "grep -qx sentinel /workspace/repo/.e2e-sentinel && echo SENTINEL_O''K" "git -C /workspace/repo rev-parse --is-inside-work-tree"
  assert_eq "the session answers after the restart" found "$(answer_has alice "$repo_session" after-restart 240)"
  assert_eq "the sentinel written before the restart is still there" found "$(stream_has alice "$repo_session" SENTINEL_OK 20)"
  assert_eq "the clone was found and skipped" 1 "$(orch_log | grep -c "\"event\":\"workspace-present\".*$repo_session")"
  assert_eq "no second clone after the restart" 0 "$(orch_log | grep -c "\"event\":\"workspace-cloned\".*$repo_session" || true)"
  assert_eq "still exactly one OneCLI agent for the session" 1 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$repo_session" '[.. | objects | select(.identifier? == $n)] | length')"
}

t_scope() {
  local covered
  need_repo_session || return 3
  # "A's token cannot read B" means something only if the installation can see B: otherwise B is refused to every token.
  covered=$(github_covers "$REPO_B")
  note "installation coverage of REPO_B: $covered"
  [[ $covered == covered* ]] || {
    note "ASSERT FAILED: the GitHub App installation does not cover REPO_B ($REPO_B): the scope check would prove nothing"
    exit 1
  }
  note "ok: the GitHub App installation covers REPO_B"
  # B is only read (ls-remote), never pushed to, even as a dry run. A is the control: the same command, and a dry-run push.
  send "$repo_session" scope-finished \
    "git ls-remote https://github.com/$REPO_B.git HEAD >/dev/null 2>&1 && echo B_REACH''ABLE || echo B_DEN''IED" \
    "git ls-remote https://github.com/$REPO_A.git HEAD >/dev/null 2>&1 && echo A_READ''ABLE || echo A_UNREAD''ABLE" \
    "cd /workspace/repo && git push --dry-run https://github.com/$REPO_A.git HEAD:refs/heads/e2e-scope-$run_id >/dev/null 2>&1 && echo A_REACH''ABLE || echo A_DEN''IED"
  assert_eq "the scope script ran" found "$(answer_has alice "$repo_session" scope-finished 180)"
  assert_eq "repo A can be read with its token (ls-remote)" found "$(stream_has alice "$repo_session" A_READABLE 20)"
  assert_eq "repo A accepts a push with its token (dry run)" found "$(stream_has alice "$repo_session" A_REACHABLE 20)"
  assert_eq "repo B refuses a read with A's token (ls-remote)" found "$(stream_has alice "$repo_session" B_DENIED 20)"
  assert_eq "repo B never answered as reachable" timeout "$(stream_has alice "$repo_session" B_REACHABLE 5)"
  # NOT covered here (needs a second pod): "rejected from another pod's IP". OneCLI v2 has no source binding.
}

t_delete() {
  local agent_id
  need_repo_session || return 3
  agent_id=$(sql "select onecli_agent_id from inbox.sessions where id='$repo_session'")
  assert_jq "DELETE is accepted" "$(api alice DELETE "/sessions/$repo_session")" '.status==202'
  wait_status alice "$repo_session" deleted 120 >/dev/null || exit 1
  assert_eq "the OneCLI agent is gone" 0 "$(onecli_count /v1/agents --arg n "${onecli_prefix}$repo_session" '[.. | objects | select(.identifier? == $n)] | length')"
  assert_eq "its secrets are gone" 0 "$(onecli_count /v1/secrets --arg n "${onecli_prefix}$repo_session" '[.. | objects | select((.name? // "") | startswith($n))] | length')"
  assert_eq "the old agent id no longer has grants" 0 "$(onecli GET "/v1/agents/$agent_id/grants" | jq '[.. | objects | select(has("id"))] | length' 2>/dev/null || echo 0)"
  assert_eq "the tombstone was written first and completed" t "$(sql "select (completed_at is not null) from inbox.tombstones where session_id='$repo_session'" | tr -d ' ')"
  assert_eq "the claim is gone" 0 "$(k get sandboxclaims -l "cela/session-id=$repo_session" -o name | wc -l | tr -d ' ')"
  if [[ $proxied == 1 ]]; then
    assert_jq "the proxy binding and the session's onecli rules are gone" "$(explain github.com "$repo_session")" '.binding==false and .route!="onecli"'
  fi
  : >"$repo_session_file"
}

# ---------------------------------------------------------------- driver
# no-repo, clone-push and tools use their own sessions and run side by side. The rest is one chain on the shared repo session
# that clone-push creates (restart-skip, then scope, then delete, which ends it), and restart-skip scales the
# orchestrator: serial, in this order, after them.
[[ ${mode:-cluster} == local ]] || e2e_db_start
proxied=0
if egress_proxy_on; then proxied=1; fi
note "egress proxy: $([[ $proxied == 1 ]] && echo "on (the repo session reaches GitHub through the proxy's OneCLI route)" || echo "off (EGRESS_PROXY=0: the sandbox uses the OneCLI gateway directly)")"

e2e_parallel no-repo:t_no_repo clone-push:t_clone_push tools:t_tools
e2e_serial restart-skip t_restart_skip
e2e_serial scope t_scope
e2e_serial delete t_delete

log "summary"
for line in "${summary[@]}"; do note "$line"; done
note "passed=$pass failed=$fail skipped=$skip"
log "RESULT"
printf '%s\n' "${summary[@]}"
if [[ $fail -ne 0 ]]; then
  echo "PHASE 4C: FAILED" >&2
  exit 1
fi
echo "PHASE 4C: all tests passed"
