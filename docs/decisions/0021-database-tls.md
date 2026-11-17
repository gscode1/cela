# 0021: TLS towards Postgres always verifies, and the settings win over the URI

Status: accepted, 2026-11-17 (issue #132). Part of install slice 11 ([install plan](../install-plan.md)).

## Context

The orchestrator and ingest open four kinds of `pg` connection (ingest pool, orchestrator inbox pool, schema probe and
create, and the Pi Durable adapter's pinned connection). None had a CA or certificate contract; TLS depended on a
`sslmode` in the URI, whose meaning in `pg` is surprising: `pg` lets everything parsed from the URI (including `ssl`) override
the `ssl` option, `sslmode=require` currently means verify-full, and that changes to libpq semantics (no verification) in
`pg` 9.

## Decision

- One module, `packages/session-core/src/db-tls.ts`, turns settings into pool options. Every pool uses it.
- Modes: `disable`, `verify-ca`, `verify-full`. There is no `require`: encrypting without verifying hides that nothing is
  authenticated. `verify-full` is what the chart suggests; `verify-ca` is for a server certificate without the host's name.
- Settings come from `PI_DURABLE_DATABASE_TLS_MODE`, `..._CA_FILE`, `..._CERT_FILE`, `..._KEY_FILE` (files from a mounted
  Secret; certificate material is never in the environment or the URI). The chart sets them from `database.tls`.
- Precedence: with the mode unset, nothing changes (the URI's own `sslmode` and `PGSSLMODE` apply, as before). With the mode
  set, the settings alone decide: an agreeing `sslmode` is removed from the URI, a disagreeing one and any `sslrootcert`,
  `sslcert`, `sslkey` fail the start, and `ssl` is always passed so `PGSSLMODE` cannot reach the client.
- `charts/pi-postgres` can serve TLS from a Secret (`tls.existingSecret`), optionally `hostssl` only (`tls.requireTls`).

## Consequences

- A misconfiguration fails at start with a message that names the variable or the file, never the URI.
- Rotating the CA or the client certificate needs a restart (files are read when the pool is created).
