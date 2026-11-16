-- Model settings move from the pi-model-config ConfigMap into Postgres (docs/decisions/0008-settings-in-postgres.md).
-- `settings` is one row (the check pins it): the default model, the allowlist (always containing the default), the
-- default reasoning effort and the per-session turn budget. Values are validated in session-core, never here beyond
-- the cheap checks. Ingest seeds the row once from the environment (insert ... on conflict do nothing) and writes it
-- from the admin API; every write also appends to `settings_history` and notifies channel `pi_settings`.
-- Idempotent, like 001 to 005.

create table if not exists inbox.settings (
  id               boolean primary key default true check (id),
  default_model    text    not null,
  allowlist        jsonb   not null,
  default_reasoning text,
  turn_budget      integer not null check (turn_budget >= 1),
  updated_at       timestamptz not null default clock_timestamp(),
  updated_by       text    not null
);

-- Append-only: the application only inserts. `old` is null for the seed.
create table if not exists inbox.settings_history (
  id         bigint generated always as identity primary key,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by text  not null,
  old        jsonb,
  new        jsonb not null
);
