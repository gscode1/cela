# shellcheck shell=bash disable=SC2034,SC2154
# Test runner shared by the e2e suites (sourced, never run). run.sh stages it next to the run-*.sh scripts.
#
# A suite sorts its tests into two kinds:
#   parallel  e2e_parallel name:function ...   independent tests: own sessions, own claims, nothing killed, scaled or
#             reconfigured, no global counter or fixed name shared with another test. At most E2E_PARALLEL (default 4)
#             run at a time. Each test's output goes to its own file and is printed in the order the tests were listed,
#             as soon as every test before it has finished.
#   serial    e2e_serial name function          tests that restart, kill or scale the orchestrator or ingest, hold the
#             database lock, change shared settings or catalog, or depend on another test's state. One at a time,
#             output live, always after the parallel group that precedes them in the suite.
# When in doubt a test is serial. E2E_PARALLEL=1 runs the parallel group one test at a time (debugging aid).
#
# The suite provides before it calls these: `work` (a temp dir), `log` and `note`. It may provide:
#   E2E_AFTER        name of a function run after every serial test and every parallel group (e.g. wait for the
#                    orchestrator); a serial test that kills the orchestrator needs one, or the next test starts too early
#   E2E_TEST_PREFIX  header text before the test name (default "TEST ")
#   E2E_ERR_TRAP=1   name the failing line when a command fails in a test
#   record()         its own verdict mapping; the default below maps exit 0 to PASS, 3 to SKIP, anything else to FAIL
# ONLY="a,b" (comma list of test names) restricts both kinds, as before.

E2E_PARALLEL=${E2E_PARALLEL:-4}
[[ $E2E_PARALLEL =~ ^[1-9][0-9]*$ ]] || {
  echo "E2E_PARALLEL must be a positive integer, got '$E2E_PARALLEL'" >&2
  exit 64
}

summary=()
pass=0 fail=0 skip=0 failed=0
_e2e_names=() # the parallel group in progress, in listing order
_e2e_next=0   # index of the next test whose output has not been printed

e2e_want() { [[ -z ${ONLY:-} || ",$ONLY," == *",$1,"* ]]; }

record() { # name rc
  case $2 in
  0)
    pass=$((pass + 1))
    summary+=("PASS  $1")
    ;;
  3)
    skip=$((skip + 1))
    summary+=("SKIP  $1")
    ;;
  *)
    fail=$((fail + 1))
    failed=1
    summary+=("FAIL  $1")
    ;;
  esac
}

e2e_settle() { [[ -z ${E2E_AFTER:-} ]] || "$E2E_AFTER"; }

e2e_body() { # function: the test itself, in the caller's subshell; any failing command ends it
  set -euo pipefail
  if [[ -n ${E2E_ERR_TRAP:-} ]]; then
    set -E
    # An unexpected failing command must say so; a bare `set -e` exit leaves no output at all.
    trap 'note "ERROR: command failed at line $LINENO (exit $?): $BASH_COMMAND"' ERR
  fi
  "$1"
}

e2e_serial() { # name function
  local name=$1 rc
  e2e_want "$name" || return 0
  log "${E2E_TEST_PREFIX-TEST }$name"
  set +e
  (e2e_body "$2") 2>&1 | tee "$work/$name.log"
  rc=${PIPESTATUS[0]}
  set -e
  record "$name" "$rc"
  e2e_settle
}

e2e_active() { # how many tests of the group are still running
  local n=0 name
  for name in ${_e2e_names[@]+"${_e2e_names[@]}"}; do [[ -e $work/$name.rc ]] || n=$((n + 1)); done
  echo "$n"
}

e2e_flush() { # print, in order, the finished tests that nothing unfinished precedes
  local name
  while [[ $_e2e_next -lt ${#_e2e_names[@]} ]]; do
    name=${_e2e_names[$_e2e_next]}
    [[ -e $work/$name.rc ]] || return 0
    log "${E2E_TEST_PREFIX-TEST }$name (ran in parallel)"
    cat "$work/$name.log"
    record "$name" "$(cat "$work/$name.rc")"
    _e2e_next=$((_e2e_next + 1))
  done
}

e2e_parallel() { # name:function ...
  local spec name fn
  _e2e_names=()
  _e2e_next=0
  for spec in "$@"; do
    name=${spec%%:*}
    fn=${spec#*:}
    e2e_want "$name" || continue
    while [[ $(e2e_active) -ge $E2E_PARALLEL ]]; do
      sleep 1
      e2e_flush
    done
    _e2e_names+=("$name")
    rm -f "$work/$name.rc"
    (
      set +e
      (e2e_body "$fn") >"$work/$name.log" 2>&1
      # Written last and moved into place, so a reader never sees a half-written code.
      echo $? >"$work/$name.rc.tmp" && mv "$work/$name.rc.tmp" "$work/$name.rc"
    ) &
  done
  while [[ $_e2e_next -lt ${#_e2e_names[@]} ]]; do
    e2e_flush
    sleep 1
  done
  [[ ${#_e2e_names[@]} -eq 0 ]] || e2e_settle
}

# A client only: the URI Secret is the sole database-backend contract. No credentials cross kubectl's output.
# A dedicated client label keeps workload selectors from mistaking this Pod for an orchestrator.
e2e_db_start() {
  if ! k get pod e2e-psql >/dev/null 2>&1; then
    k create -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: e2e-psql
  labels:
    app.kubernetes.io/name: e2e-db-client
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: psql
      image: postgres:17-bookworm@sha256:40865bc877a289da75963d97d72b59633f639fc5af7a4e856bfa3714cae5b536
      command: [sleep, "infinity"]
      env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef: {name: "${E2E_DB_SECRET:-pi-db-uri}", key: "${E2E_DB_URI_KEY:-uri}"}
      volumeMounts:
        - {name: db-tls, mountPath: /etc/pi-db-tls, readOnly: true}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: [ALL]}
      resources:
        requests: {cpu: 10m, memory: 32Mi}
        limits: {cpu: "1", memory: 128Mi}
  volumes:
    # DB_TLS=1 (run.sh) leaves the public CA here; without it the volume is empty and psql connects as the URI says.
    - name: db-tls
      secret: {secretName: pi-db-tls-ca, optional: true}
YAML
  fi
  k wait --for=condition=Ready pod/e2e-psql --timeout=300s >/dev/null
  local i
  for i in {1..60}; do
    if e2e_db -c 'select 1' >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  echo "database URI did not become ready" >&2
  return 1
}

e2e_db() {
  # shellcheck disable=SC2016
  # With the CA present (DB_TLS=1) the client verifies the server like the orchestrator does: that Postgres rejects plain TCP.
  k exec -i e2e-psql -c psql -- sh -c '[ ! -f /etc/pi-db-tls/ca.crt ] || export PGSSLMODE=verify-full PGSSLROOTCERT=/etc/pi-db-tls/ca.crt; exec psql "$DATABASE_URL" -X -At -v ON_ERROR_STOP=1 "$@"' sh "$@"
}
