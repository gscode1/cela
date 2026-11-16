#!/usr/bin/env bash
# Create or update (by name) the repository ruleset that confines session agents to agent/** branches.
# Session tokens are GitHub App installation tokens with contents: write; GitHub cannot scope a token by ref, so
# this ruleset is what stops an agent from pushing, force-pushing or deleting main. See docs/repo-workspace.md.
#
#   deploy/agent-ruleset.sh owner/repo            apply (POST, or PUT when a ruleset of that name exists)
#   deploy/agent-ruleset.sh --check owner/repo    read-only: exit 0 when present and correct, 1 otherwise
#
# Needs `gh` logged in as a repo admin, and `jq`. The payload is deploy/agent-ruleset.json.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
payload="$here/agent-ruleset.json"

mode=apply
if [[ ${1:-} == --check ]]; then
  mode=check
  shift
fi
repo=${1:-}
if [[ $# -ne 1 || ! $repo =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]]; then
  echo "usage: $0 [--check] <owner/repo>" >&2
  exit 2
fi

name=$(jq -r .name "$payload")
# Ids of rulesets with our name (the list endpoint returns summaries only).
id=$(gh api --paginate "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id" | head -n1)

# Normalised view used to compare the live ruleset with the payload. Key order and server-added fields are ignored.
norm='{target, enforcement, conditions: .conditions.ref_name,
       rules: ([.rules[].type] | sort),
       bypass: ([.bypass_actors[] | {actor_id, actor_type, bypass_mode}] | sort_by(.actor_type, .actor_id))}'

if [[ $mode == check ]]; then
  if [[ -z $id ]]; then
    echo "MISSING: no ruleset named '$name' on $repo" >&2
    exit 1
  fi
  live=$(gh api "repos/$repo/rulesets/$id" | jq -S "$norm")
  want=$(jq -S "$norm" "$payload")
  if [[ $live == "$want" ]]; then
    echo "OK: ruleset '$name' (id $id) on $repo matches $payload"
    exit 0
  fi
  echo "DIFFERS: ruleset '$name' (id $id) on $repo is not the expected one (< live, > expected):" >&2
  diff <(echo "$live") <(echo "$want") >&2 || true
  exit 1
fi

if [[ -n $id ]]; then
  gh api -X PUT "repos/$repo/rulesets/$id" --input "$payload" --jq '"updated ruleset " + .name + " (id " + (.id|tostring) + ")"'
else
  gh api -X POST "repos/$repo/rulesets" --input "$payload" --jq '"created ruleset " + .name + " (id " + (.id|tostring) + ")"'
fi
