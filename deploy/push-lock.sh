#!/usr/bin/env bash
# Sourced by deploy/push-code.sh. A push lock is a ConfigMap that records its holder and an expiry, so a
# lock left behind by a crashed run or a failed delete is taken over once expired instead of blocking every
# later push. Needs from the caller: k (kubectl wrapper bound to the namespace), ns, and the lock name.
# PUSH_LOCK_TTL_SECONDS (default 900) must be longer than any push.

push_lock_ttl=${PUSH_LOCK_TTL_SECONDS:-900}
push_lock_holder=""

# Holder is host-pid-start, restricted to characters that are safe in a ConfigMap value and in jsonpath output.
push_lock_id() {
  local host
  host=$(hostname 2>/dev/null | tr -c 'A-Za-z0-9.\n-' '_' | tr -d '\n')
  echo "${host:-unknown}-$$-$(date +%s)"
}

# $1 = lock name, $2 = resourceVersion to replace (empty: create). Prints the manifest.
push_lock_manifest() {
  local now=$1 rv=${2:-}
  cat <<MANIFEST
apiVersion: v1
kind: ConfigMap
metadata:
  name: $lock
${rv:+  resourceVersion: "$rv"}
data:
  holder: "$push_lock_holder"
  started: "$now"
  expires: "$((now + push_lock_ttl))"
MANIFEST
}

# Returns 0 and sets push_lock_holder when this run holds the lock; returns 1 when another live run does.
push_lock_acquire() {
  local now err cur rv expires holder
  now=$(date +%s)
  push_lock_holder=$(push_lock_id)
  if err=$(push_lock_manifest "$now" | k create -f - 2>&1 >/dev/null); then
    return 0
  fi
  if ! cur=$(k get configmap "$lock" -o 'jsonpath={.metadata.resourceVersion} {.data.expires} {.data.holder}' 2>&1); then
    echo "could not take the push lock ($err); could not read it either ($cur)" >&2
    return 1
  fi
  read -r rv expires holder <<<"$cur"
  if [[ ! $expires =~ ^[0-9]+$ ]]; then
    # A lock without an expiry (made by an older push-code.sh) cannot be judged, so it is never taken over.
    echo "another push-code run holds the lock ($lock, holder ${holder:-unknown}, no expiry)." >&2
    echo "If no push is running, remove it with: kubectl -n $ns delete configmap $lock" >&2
    return 1
  fi
  if ((expires > now)); then
    echo "another push-code run holds the lock ($lock, holder ${holder:-unknown}, expires in $((expires - now))s)." >&2
    echo "If no push is running, wait for it to expire or remove it with: kubectl -n $ns delete configmap $lock" >&2
    return 1
  fi
  # replace carries the resourceVersion read above, so only one of several racing takeovers can win.
  if err=$(push_lock_manifest "$now" "$rv" | k replace -f - 2>&1 >/dev/null); then
    echo "took over the expired push lock $lock (previous holder ${holder:-unknown}, expired $((now - expires))s ago)." >&2
    return 0
  fi
  echo "could not take over the expired push lock $lock; another run probably won it ($err)." >&2
  return 1
}

# Deletes the lock only while this run is still its holder. Prints the delete's real error on failure.
push_lock_release() {
  local holder err
  if ! holder=$(k get configmap "$lock" --ignore-not-found -o 'jsonpath={.data.holder}' 2>&1); then
    echo "could not read the push lock to release it: $holder; run: kubectl -n $ns delete configmap $lock" >&2
    return 1
  fi
  if [[ -z $holder ]]; then
    return 0
  fi
  if [[ $holder != "$push_lock_holder" ]]; then
    echo "push lock $lock is now held by $holder; leaving it in place." >&2
    return 0
  fi
  if ! err=$(k delete configmap "$lock" --ignore-not-found 2>&1 >/dev/null); then
    echo "could not remove the push lock: $err; run: kubectl -n $ns delete configmap $lock (it expires on its own after ${push_lock_ttl}s)" >&2
    return 1
  fi
}
