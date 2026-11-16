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
# the block rule must come after every allow rule. If an allow rule has to be added while `pi-block-all` exists, the
# block rule is deleted and recreated last. Rules written here are live at once and change what every OneCLI agent
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

key=${ONECLI_API_KEY:-}
if [[ -z $key ]]; then
  key=$(kubectl ${ctx:+--context="$ctx"} -n secret-store get secret pi-onecli-admin -o jsonpath='{.data.api-key}' | base64 -d)
fi
[[ -n $key ]] || { echo "no admin key (secret-store/pi-onecli-admin api-key or ONECLI_API_KEY)" >&2; exit 1; }

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

if [[ -n $block_id && ${#missing[@]} -gt 0 ]]; then
  echo "plan: delete $block_name ($block_id) so it can be recreated after the new allow rules"
  [[ $apply -eq 1 ]] && api DELETE "$rules_path/$block_id" >/dev/null
  block_id=""
fi
for h in ${missing[@]+"${missing[@]}"}; do
  echo "plan: allow $h"
  [[ $apply -eq 1 ]] && api POST "$rules_path" "$(rule_json "$(rule_name "$h")" allow "$h")" >/dev/null
done
if [[ -z $block_id ]]; then
  echo "plan: block * (last)"
  [[ $apply -eq 1 ]] && api POST "$rules_path" "$(rule_json "$block_name" block '*')" >/dev/null
fi
[[ $apply -eq 1 ]] && echo "done: ${#hosts[@]} allow rules, then block *. Verify with docs/onecli-host-rules.md." || true
