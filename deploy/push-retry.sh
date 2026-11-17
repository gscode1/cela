#!/usr/bin/env bash
# Sourced by deploy/push-code.sh and deploy/push-ingest.sh. The API server sometimes resets a
# long-lived kubectl cp/exec stream; one reset must not fail a whole e2e run. Only wrap steps that can be redone
# safely. PUSH_RETRY_BACKOFF_SECONDS (default 2) is multiplied by the attempt number.

push_retry_attempts=3
push_retry_pattern='connection reset by peer|error reading from error stream|unexpected EOF|i/o timeout'

# Usage: push_retry <command...>. Replays the command's stdout and stderr unchanged. Retries (up to 3 attempts)
# only when a failure's output matches a transient network error; any other failure returns at once.
# The caller keeps holding the push lock: this never touches it.
push_retry() {
  local attempt=1 out err rc=0 backoff=${PUSH_RETRY_BACKOFF_SECONDS:-2}
  out=$(mktemp) && err=$(mktemp) || return 1
  while :; do
    rc=0
    "$@" >"$out" 2>"$err" || rc=$?
    cat "$out"
    cat "$err" >&2
    if [[ $rc -eq 0 ]] || ! grep -Eqi "$push_retry_pattern" "$out" "$err" || [[ $attempt -ge $push_retry_attempts ]]; then
      break
    fi
    echo "transient kubectl failure (attempt $attempt of $push_retry_attempts); retrying" >&2
    sleep "$((backoff * attempt))"
    attempt=$((attempt + 1))
  done
  rm -f "$out" "$err"
  return "$rc"
}
