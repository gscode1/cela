#!/usr/bin/env bash
# Apply the OneCLI v2 host allowlist (docs/onecli-host-rules.md): one `allow` org rule per host, then `block *`.
# Default is a dry run that only prints the plan and makes no request. --apply writes through the OneCLI API.
#
#   deploy/onecli-host-rules.sh            # plan only
#   deploy/onecli-host-rules.sh --apply    # create the missing rules, block last
#
# The admin key (`oc_...`) is read from Secret secret-store/pi-onecli-admin, key api-key, with kubectl (read only), or
# from ONECLI_API_KEY. It is passed to curl through a config on stdin: never printed, never on a command line.
# ONECLI_URL is the API base (required, e.g. https://onecli.example.com; or http://localhost:10256 after
# `kubectl -n onecli port-forward svc/onecli 10256`). KUBE_CONTEXT defaults to the current kubectl context.
#
# Rules are matched by name (`pi-allow-<host>`, `pi-block-all`), so a rerun only adds what is missing. Order matters:
# the block rule must come after every allow rule. Missing allow rules are created first, while the old block still
# exists (a new allow rule is then at worst ineffective, never a hole). Only then is the block deleted and recreated
# last: the one step with a window, and an EXIT trap recreates the block if anything fails inside it. Rules written here are live at once and change what every OneCLI agent
# can reach, so run this only when the hosts below are complete for the work in flight.
set -euo pipefail

apply=0
[[ ${1:-} == --apply ]] && apply=1
base=${ONECLI_URL:?set ONECLI_URL to the OneCLI API base, e.g. https://onecli.example.com}
ctx=${KUBE_CONTEXT:-}
rules_path=/v1/org/policy/rules

# Keep in step with deploy/onecli-policies/egress.yaml (the pod's FQDN allowlist).
hosts=(
  chatgpt.com '*.chatgpt.com' auth.openai.com api.openai.com openrouter.ai
  github.com api.github.com codeload.github.com objects.githubusercontent.com
  registry.npmjs.org pypi.org files.pythonhosted.org
)
block_name=pi-block-all

rule_name() { printf 'pi-allow-%s' "${1//\*./wild-}"; }

# A dry run never contacts OneCLI, so only --apply needs the admin key.
key=${ONECLI_API_KEY:-}
if [[ $apply -eq 1 ]]; then
  if [[ -z $key ]]; then
    key=$(kubectl ${ctx:+--context="$ctx"} -n secret-store get secret pi-onecli-admin -o jsonpath='{.data.api-key}' | base64 -d)
  fi
  [[ -n $key ]] || { echo "no admin key (secret-store/pi-onecli-admin api-key or ONECLI_API_KEY)" >&2; exit 1; }
fi

api() { # method path [json body]: prints the response body, fails on HTTP >= 400
  local method=$1 path=$2 body=${3:-}
  local args=(-sS --fail-with-body -X "$method" -H 'Content-Type: application/json' -K - "$base$path")
  [[ -n $body ]] && args+=(--data "$body")
  printf 'header = "Authorization: Bearer %s"\n' "$key" | curl "${args[@]}"
}
rule_json() { # name action host
  jq -nc --arg n "$1" --arg a "$2" --arg h "$3" '{name:$n, action:$a, targets:[{kind:"network", hostPattern:$h}]}'
}

if [[ $apply -eq 1 ]]; then
  existing=$(api GET "$rules_path")
else
  existing='[]'
  echo "dry run: not contacting OneCLI, so every rule is shown as missing. Use --apply to write."
fi
# The list is a bare array on v2.20.0; the wrapped forms are accepted in case a later version changes it.
names=$(jq -r '(if type=="array" then . else (.rules // .data // []) end)[].name' <<<"$existing")
block_id=$(jq -r --arg n "$block_name" '(if type=="array" then . else (.rules // .data // []) end)[] | select(.name==$n) | .id' <<<"$existing" | head -1)
has() { grep -qxF -- "$1" <<<"$names"; }

missing=()
for h in "${hosts[@]}"; do has "$(rule_name "$h")" || missing+=("$h"); done

for h in ${missing[@]+"${missing[@]}"}; do
  echo "plan: allow $h"
  [[ $apply -eq 1 ]] && api POST "$rules_path" "$(rule_json "$(rule_name "$h")" allow "$h")" >/dev/null
done
block_gone=0
restore_block() { # EXIT trap: never leave the allowlist off after the block was deleted
  local rc=$?
  trap - EXIT
  if [[ $block_gone -eq 1 ]]; then
    echo "failed after deleting $block_name: recreating it" >&2
    api POST "$rules_path" "$(rule_json "$block_name" block '*')" >/dev/null ||
      echo "could not recreate $block_name; rerun with --apply NOW (the allowlist is off)" >&2
  fi
  exit "$rc"
}
trap restore_block EXIT
if [[ -n $block_id && ${#missing[@]} -gt 0 ]]; then
  echo "plan: delete $block_name ($block_id) and recreate it last, after the new allow rules"
  if [[ $apply -eq 1 ]]; then
    api DELETE "$rules_path/$block_id" >/dev/null # an HTTP error here means nothing was deleted
    block_gone=1
  fi
  block_id=""
fi
if [[ -z $block_id ]]; then
  echo "plan: block * (last)"
  if [[ $apply -eq 1 ]]; then
    block_gone=1
    api POST "$rules_path" "$(rule_json "$block_name" block '*')" >/dev/null
    block_gone=0
  fi
fi
trap - EXIT
[[ $apply -eq 1 ]] && echo "done: ${#hosts[@]} allow rules, then block *. Verify with docs/onecli-host-rules.md." || true
