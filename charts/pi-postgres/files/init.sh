#!/bin/sh
# Runs for the whole life of the Pod (as a sidecar): waits for the server, applies init.sql, then reports ready and
# sleeps. It re-runs on every Pod start, so it also covers an existing data directory, where the image entrypoint
# skips its own init. It talks to the server over the Pod-local unix socket as the postgres superuser.
set -eu
export PGHOST=/var/run/postgresql PGUSER=postgres PGDATABASE=postgres
rm -f /tmp/init-done
until pg_isready -q; do sleep 1; done
echo "init: applying databases and roles"
psql -X -q -f /config/init.sql
touch /tmp/init-done
echo "init: done"
# sleep is a child; exec keeps signal handling simple through a trap.
trap 'exit 0' TERM INT
while true; do sleep 3600 & wait $!; done
