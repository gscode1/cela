# 0008: Model settings live in Postgres, changed through an admin API

Status: accepted, 2026-11-16 (issue #38).

## Context

The default model, the allowlist, the default reasoning effort and the turn budget came from ConfigMap
`pi-model-config` through `envFrom`, read once at process start by both ingest and the orchestrator. Changing a model
meant editing the ConfigMap and restarting both Deployments, the e2e suites patched the ConfigMap and needed a restart
to get the scripted model, and nothing recorded who changed what. Later work (profiles, an MCP catalog, per-session
reasoning) needs settings that change at runtime.

## Decision

- **Storage.** `inbox.settings` is one typed row (a `check (id)` pins it): `default_model`, `allowlist` (jsonb),
  `default_reasoning`, `turn_budget`, `updated_at/by`. `inbox.settings_history` is append-only (`changed_at`,
  `changed_by`, `old`, `new`). Migration `006_settings.sql`, idempotent like 003 and 005. Values are validated in
  `packages/session-core/src/settings.ts` (reusing `parseModelKey` and the thinking levels), for API input and for rows
  read back.
- **Seeding.** The row is absent on a database that predates this change. Ingest, after migrating, inserts it once from
  the environment (`insert ... on conflict do nothing` plus the history entry `seed`, in one transaction, so two replicas
  cannot both seed). After that the table wins; a differing environment logs `settings-env-ignored` at ingest start.
  The ConfigMap stays, documented as seed-only.
- **Reads.** `SettingsCache` (session-core) loads at start, refreshes on `LISTEN pi_settings` (the writer calls
  `pg_notify` in the same transaction, so a rolled-back write notifies nobody) and on a 30 s poll as the safety net. A
  failed or invalid read keeps the last good value and logs once. Ingest checks `POST /sessions` against it and stores
  the resolved choice on the session row as before, so existing sessions are unaffected by later changes.
  `defaultReasoning()` is the accessor issue #37 (per-session reasoning) builds on. The orchestrator trusts the session
  row for model and reasoning and reads only the turn budget, per input, from the cache; until the row exists it uses
  the environment value.
- **Writes.** `GET/PUT /admin/settings` and `GET /admin/settings/history` on ingest. Admins are the owners named in
  `PI_API_ADMINS` (plain env on the ingest Deployment: owner names are not secrets). Authentication is the existing
  seam (401 without a valid token); an authenticated non-admin gets 403. A PUT validates over the current row under
  `select ... for update`, writes row, history and notification in one transaction and refreshes the local cache, so the
  next request on that replica sees it at once.

## Consequences

- No restart to change the default model, the allowlist, the reasoning or the turn budget; every change has an author
  and a timestamp.
- The orchestrator installs model providers from `PI_MODEL_ALLOWLIST` at start (`providers.ts`). An admin who allows a
  model of a provider that is not installed gets sessions that fail at their first turn; adding a provider still needs
  the ConfigMap and an orchestrator restart. Closing that gap is a separate change.
- The orchestrator still applies migrations at start (as in 0005) so a standalone start has the schema; ingest is the
  only writer of `inbox.settings`.
- Two settings sources exist during the transition (ConfigMap seed and table). The warning makes a stale ConfigMap
  visible; deleting the seed keys later is possible once every cluster has the row.
