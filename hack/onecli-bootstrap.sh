#!/usr/bin/env bash
# PROTOTYPE (spike #120, docs/research/onecli-bundled-spike.md). Not wired into install.sh or any chart yet; slice 10
# of docs/install-plan.md turns it into the real bootstrap step.
#
# Bootstrap a freshly installed bundled OneCLI (upstream chart, release `onecli`) through its HTTP API only:
#   1. sign up the first account (email + password), or sign in if it exists;
#   2. read its `oc_` admin key;
#   3. create the orchestrator agent (and read its `aoc_` token);
#   4. create the host allowlist rules (allow per host, then `block *` last);
#   5. optionally create one generic secret and grant it to the agent;
#   6. copy only the PUBLIC gateway CA certificate to a ConfigMap.
# Results go to Kubernetes Secrets and a ConfigMap; nothing secret is printed. A second run changes nothing.
#
#   hack/onecli-bootstrap.sh -n pi
#
# Environment (all optional):
#   KUBE_CONTEXT         kubectl context (unset: the current one)
#   ONECLI_RELEASE       Helm release name of the OneCLI chart (default onecli); Services are <release>-api, -gateway
#   ONECLI_API_URL       API base. Unset: the script runs `kubectl port-forward svc/<release>-api` itself
#   ONECLI_EXTERNAL_URL  the chart's externalUrl, sent as the Origin header. Unset: read from GET /v1/instance
#   ONECLI_ADMIN_EMAIL   first account's email (default pi-admin@pi-durable.local)
#   ONECLI_ADMIN_SECRET  Secret for the account login and admin key (default pi-onecli-admin; keys email, password, api-key)
#   ONECLI_AGENT_SECRET  Secret for the agent token (default pi-onecli; key agent-token)
#   ONECLI_AGENT_ID      agent identifier (default pi-orchestrator)
#   ONECLI_CA_CONFIGMAP  ConfigMap for the public CA (default pi-onecli-ca; key ca.crt)
#   ONECLI_HOSTS         space-separated allowlist hosts (default: docs/onecli-host-rules.md); empty: no rules
#   ONECLI_SECRET_NAME / ONECLI_SECRET_HOST / ONECLI_SECRET_VALUE
#                        create one generic secret (header `authorization: Bearer {value}`) and grant it to the agent.
#                        The value is read from the environment only. All three or none.
#
# Requires kubectl, curl, jq and openssl. Runs on macOS bash 3.2.
set -euo pipefail
umask 077

ns=""
while getopts "n:h" opt; do
  case $opt in
    n) ns=$OPTARG ;;
    *)
      sed -n '2,/^set -euo/p' "$0" | sed '$d' >&2
      exit 64
      ;;
  esac
done
[[ -n $ns ]] || {
  echo "usage: ${0##*/} -n <namespace>" >&2
  exit 64
}

release=${ONECLI_RELEASE:-onecli}
email=${ONECLI_ADMIN_EMAIL:-pi-admin@pi-durable.local}
admin_secret=${ONECLI_ADMIN_SECRET:-pi-onecli-admin}
agent_secret=${ONECLI_AGENT_SECRET:-pi-onecli}
agent_id=${ONECLI_AGENT_ID:-pi-orchestrator}
ca_cm=${ONECLI_CA_CONFIGMAP:-pi-onecli-ca}
# Keep in step with docs/onecli-host-rules.md and deploy/onecli-policies/egress.yaml.
default_hosts="chatgpt.com *.chatgpt.com auth.openai.com api.openai.com openrouter.ai github.com api.github.com codeload.github.com objects.githubusercontent.com registry.npmjs.org pypi.org files.pythonhosted.org mcp.deepwiki.com"
hosts=${ONECLI_HOSTS-$default_hosts}
block_name=pi-block-all
sec_name=${ONECLI_SECRET_NAME:-}
sec_host=${ONECLI_SECRET_HOST:-}
sec_value=${ONECLI_SECRET_VALUE:-}
if [[ -n $sec_name$sec_host$sec_value ]]; then
  [[ -n $sec_name && -n $sec_host && -n $sec_value ]] || {
    echo "set all of ONECLI_SECRET_NAME, ONECLI_SECRET_HOST and ONECLI_SECRET_VALUE, or none" >&2
    exit 64
  }
fi
unset ONECLI_SECRET_VALUE

log() { echo "onecli-bootstrap: $*" >&2; }
die() {
  log "$*"
  exit 1
}

kc() { kubectl ${KUBE_CONTEXT:+--context "$KUBE_CONTEXT"} -n "$ns" "$@"; }

work=$(mktemp -d "${TMPDIR:-/tmp}/onecli-bootstrap.XXXXXX")
pf_pid=""
cleanup() {
  if [[ -n $pf_pid ]]; then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# ---- API access -------------------------------------------------------------------------------------------------

base=${ONECLI_API_URL:-}
if [[ -z $base ]]; then
  kc port-forward "svc/$release-api" :10256 >"$work/pf.log" 2>&1 &
  pf_pid=$!
  for _ in $(seq 1 30); do
    port=$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\) .*/\1/p' "$work/pf.log" | head -1)
    [[ -n $port ]] && break
    kill -0 "$pf_pid" 2>/dev/null || die "port-forward failed: $(head -c 300 "$work/pf.log")"
    sleep 1
  done
  [[ -n ${port:-} ]] || die "port-forward did not start"
  base=http://127.0.0.1:$port
fi

# http_status: prints nothing, leaves the status in $status and the body in $work/body. Never prints a body.
# Credentials come from curl config files (never the command line): $work/auth.cfg (Bearer) and the cookie jar.
status=""
call() { # method path [json-body-file]
  local method=$1 path=$2 data=${3:-}
  local args=(-sS -o "$work/body" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --max-time 30)
  [[ -z ${origin:-} ]] || args+=(-H "Origin: $origin")
  [[ ${auth:-none} == bearer ]] && args+=(-K "$work/auth.cfg")
  # Sign-in must only WRITE the jar: sending a not-yet-existing jar made the session cookie unusable (spike #120).
  [[ ${auth:-none} == signin ]] && args+=(-c "$work/jar")
  [[ ${auth:-none} == cookie ]] && args+=(-b "$work/jar")
  [[ -z $data ]] || args+=(--data-binary "@$data")
  status=$(curl "${args[@]}" "$base$path") || die "$method $path: transport error"
}
call_retry() { # like call, but waits out the auth rate limit (HTTP 429)
  for _ in 1 2 3 4 5 6; do
    call "$@"
    [[ $status == 429 ]] || return 0
    log "rate limited; retrying in 15 s"
    sleep 15
  done
}
expect() { # description, then accepted statuses
  local what=$1
  shift
  local s
  for s in "$@"; do [[ $s == "$status" ]] && return 0; done
  die "$what: HTTP $status"
}
json() { printf '%s' "$1" >"$work/req.json"; }

log "waiting for the API"
auth=none
origin=""
ok=0
for _ in $(seq 1 60); do
  call GET /v1/health
  if [[ $status == 200 ]]; then
    ok=1
    break
  fi
  sleep 2
done
[[ $ok -eq 1 ]] || die "API not healthy (last HTTP $status)"

origin=${ONECLI_EXTERNAL_URL:-}
if [[ -z $origin ]]; then
  call GET /v1/instance
  expect "GET /v1/instance" 200
  origin=$(jq -r '.origins.external // empty' "$work/body")
fi
[[ -n $origin ]] || die "cannot learn externalUrl: set ONECLI_EXTERNAL_URL"

# ---- Kubernetes Secret helpers (values only through files, never arguments) -----------------------------------------

secret_get() { kc get secret "$1" -o "jsonpath={.data.$2}" 2>/dev/null | base64 -d 2>/dev/null || true; }

# secret_put name key value: merges one key into the Secret, only when it differs. Returns 0 if it wrote.
secret_put() {
  local name=$1 key=$2 value=$3 current
  current=$(secret_get "$name" "$key")
  [[ $current != "$value" ]] || return 1
  printf '%s' "$value" >"$work/value"
  if kc get secret "$name" >/dev/null 2>&1; then
    kc create secret generic "$name" --from-file="$key=$work/value" --dry-run=client -o json |
      jq '{stringData: (.data | map_values(@base64d))}' >"$work/patch.json"
    kc patch secret "$name" --type merge --patch-file "$work/patch.json" >/dev/null
  else
    kc create secret generic "$name" --from-file="$key=$work/value" >/dev/null
  fi
  rm -f "$work/value" "$work/patch.json"
  return 0
}

# ---- 1+2. first account and admin key ---------------------------------------------------------------------------

# A stored admin key that still works skips the account steps: a rerun then makes no auth calls, which are rate limited
# (10 per minute per address).
key=$(secret_get "$admin_secret" api-key)
auth=bearer
if [[ -n $key ]]; then
  printf 'header = "Authorization: Bearer %s"\n' "$key" >"$work/auth.cfg"
  call GET /v1/agents
  if [[ $status == 200 ]]; then
    log "stored admin key is valid"
  else
    log "stored admin key refused (HTTP $status); signing in again"
    key=""
  fi
fi

if [[ -z $key ]]; then
  # The password is stored BEFORE the sign-up: a crash in between must not leave an owned account with a lost password.
  password=$(secret_get "$admin_secret" password)
  if [[ -z $password ]]; then
    password=$(openssl rand -hex 24)
    secret_put "$admin_secret" password "$password" || true
    log "generated the first account's password into Secret $admin_secret"
  fi
  secret_put "$admin_secret" email "$email" || true
  email=$(secret_get "$admin_secret" email)

  jq -n --arg e "$email" --arg p "$password" '{email:$e, password:$p, name:"pi-admin"}' >"$work/cred.json"
  jq 'del(.name)' "$work/cred.json" >"$work/signin.json"
  unset password
  auth=none
  call_retry POST /auth/sign-up/email "$work/cred.json"
  case $status in
    200) log "first account created" ;;
    *)
      jq -e '.code == "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"' "$work/body" >/dev/null 2>&1 ||
        die "sign-up refused: HTTP $status"
      log "account exists; signing in"
      ;;
  esac
  rm -f "$work/jar"
  auth=signin
  call_retry POST /auth/sign-in/email "$work/signin.json"
  [[ $status == 200 ]] || die "sign-in as $email failed (HTTP $status): the account exists with a password this script does not hold; the install may have been claimed by someone else"
  rm -f "$work/cred.json" "$work/signin.json"

  # The session cookie only works on /v1 together with an Origin header equal to externalUrl (see the research note).
  # The first /v1 call of a new session must be GET /v1/auth/session: it provisions the org, and until then every other
  # route answers 401 (observed on v2.20.0).
  auth=cookie
  call GET /v1/auth/session
  expect "GET /v1/auth/session" 200
  call GET /v1/user/api-key
  expect "GET /v1/user/api-key" 200
  key=$(jq -r '.apiKey // empty' "$work/body")
  [[ $key == oc_* ]] || die "no oc_ admin key in the answer"
  secret_put "$admin_secret" api-key "$key" || true
  log "admin key stored in Secret $admin_secret"
  rm -f "$work/jar"
  auth=bearer
  printf 'header = "Authorization: Bearer %s"\n' "$key" >"$work/auth.cfg"
fi
unset key

# ---- 3. orchestrator agent --------------------------------------------------------------------------------------

agent_row() { # prints the agent object (with token) or nothing
  call GET /v1/agents
  expect "GET /v1/agents" 200
  jq -c --arg id "$agent_id" '(if type=="array" then . else (.agents // .data // []) end)[] | select(.identifier==$id)' "$work/body" | head -1
}
agent=$(agent_row)
if [[ -z $agent ]]; then
  jq -n --arg i "$agent_id" '{name:$i, identifier:$i}' >"$work/req.json"
  call POST /v1/agents "$work/req.json"
  expect "POST /v1/agents" 201 409
  agent=$(agent_row)
  [[ -n $agent ]] || die "agent $agent_id was created but is not listed"
  log "agent $agent_id created"
else
  log "agent $agent_id exists"
fi
agent_uuid=$(jq -r .id <<<"$agent")
token=$(jq -r '.accessToken // empty' <<<"$agent")
unset agent
[[ $token == aoc_* ]] || die "no aoc_ token for agent $agent_id"
if secret_put "$agent_secret" agent-token "$token"; then log "agent token stored in Secret $agent_secret"; else log "agent token unchanged"; fi
unset token

# ---- 4. host rules (allow each host, block everything else LAST) -------------------------------------------------

rule_name() { printf 'pi-allow-%s' "${1//\*./wild-}"; }
rule_body() { jq -n --arg n "$1" --arg a "$2" --arg h "$3" '{name:$n, action:$a, targets:[{kind:"network", hostPattern:$h}]}' >"$work/req.json"; }

if [[ -n $hosts ]]; then
  call GET /v1/org/policy/rules
  expect "GET rules" 200
  jq -r '(if type=="array" then . else (.rules // .data // []) end)[].name' "$work/body" >"$work/rule-names"
  block_id=$(jq -r --arg n "$block_name" '(if type=="array" then . else (.rules // .data // []) end)[] | select(.name==$n) | .id' "$work/body" | head -1)
  created=0
  for h in $hosts; do
    if ! grep -qxF -- "$(rule_name "$h")" "$work/rule-names"; then
      rule_body "$(rule_name "$h")" allow "$h"
      call POST /v1/org/policy/rules "$work/req.json"
      expect "POST rule $h" 201
      created=$((created + 1))
    fi
  done
  # Rules are evaluated in creation order, so an allow added after the block must be followed by a fresh block.
  if [[ -n $block_id && $created -gt 0 ]]; then
    call DELETE "/v1/org/policy/rules/$block_id"
    expect "DELETE block rule" 200 204
    block_id=""
  fi
  if [[ -z $block_id ]]; then
    rule_body "$block_name" block '*'
    call POST /v1/org/policy/rules "$work/req.json"
    expect "POST block rule" 201
    created=$((created + 1))
  fi
  log "host rules: $created written"
fi

# ---- 5. optional secret and grant -------------------------------------------------------------------------------

if [[ -n $sec_name ]]; then
  call GET /v1/secrets
  expect "GET /v1/secrets" 200
  sec_id=$(jq -r --arg n "$sec_name" '(if type=="array" then . else (.secrets // .data // []) end)[] | select(.name==$n) | .id' "$work/body" | head -1)
  if [[ -z $sec_id ]]; then
    jq -n --arg n "$sec_name" --arg v "$sec_value" --arg h "$sec_host" \
      '{name:$n, type:"generic", value:$v, hostPattern:$h, injectionConfig:{headerName:"authorization", valueFormat:"Bearer {value}"}}' >"$work/req.json"
    call POST /v1/secrets "$work/req.json"
    expect "POST /v1/secrets" 201
    sec_id=$(jq -r .id "$work/body")
    rm -f "$work/req.json"
    log "secret $sec_name created"
  else
    log "secret $sec_name exists (value not rotated here)"
  fi
  unset sec_value
  call PUT "/v1/agents/$agent_uuid/grants/secrets/$sec_id"
  expect "PUT grant" 200 204
fi

# ---- 6. public CA certificate -> ConfigMap ------------------------------------------------------------------------

kc get secret "$release-gateway-ca" -o 'jsonpath={.data.GATEWAY_CA_CERT}' | base64 -d >"$work/ca.crt"
openssl x509 -in "$work/ca.crt" -noout 2>/dev/null || die "Secret $release-gateway-ca has no readable GATEWAY_CA_CERT"
! grep -q 'PRIVATE KEY' "$work/ca.crt" || die "GATEWAY_CA_CERT holds a private key; refusing to copy it"
if [[ $(kc get configmap "$ca_cm" -o 'jsonpath={.data.ca\.crt}' 2>/dev/null || true) == "$(cat "$work/ca.crt")" ]]; then
  log "CA ConfigMap $ca_cm unchanged"
else
  kc create configmap "$ca_cm" --from-file="ca.crt=$work/ca.crt" --dry-run=client -o yaml | kc apply -f - >/dev/null
  log "CA ConfigMap $ca_cm written"
fi

log "done"
