-- Session profiles (docs/decisions/0010-session-profiles.md). A profile is a name with immutable, numbered versions;
-- the definition (tools, instructions, model, MCP servers, turn budget) is validated in session-core, never here beyond
-- the cheap checks. A new session stores the resolved definition (`profile_snapshot`) next to the name and version, so
-- later edits never change an existing session and the orchestrator reads the snapshot, not the live profile.
-- `enabled_for_new` only decides whether a NEW session may pick the profile; a stored snapshot stays resolvable.
-- There is no delete: a profile is disabled, and its rows stay for the audit trail. Idempotent, like 001 to 007.

create table if not exists inbox.profiles (
  name            text primary key check (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  current_version integer not null check (current_version >= 1),
  enabled_for_new boolean not null default true,
  created_at      timestamptz not null default clock_timestamp(),
  created_by      text not null,
  updated_at      timestamptz not null default clock_timestamp(),
  updated_by      text not null
);

create table if not exists inbox.profile_versions (
  name       text not null references inbox.profiles (name),
  version    integer not null check (version >= 1),
  definition jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  primary key (name, version)
);

-- Versions are history: no update, no delete.
create or replace function inbox.profile_versions_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'inbox.profile_versions rows are immutable';
end $$;

drop trigger if exists profile_versions_immutable on inbox.profile_versions;
create trigger profile_versions_immutable before update or delete on inbox.profile_versions
  for each row execute function inbox.profile_versions_immutable();

-- `coding` version 1 is the behaviour sessions had before profiles: every coding tool, no extra instructions, the
-- settings' model, reasoning and turn budget, and no MCP server (MCP is opt-in per profile). Sessions that predate
-- this migration have no snapshot and run as exactly this.
insert into inbox.profiles (name, current_version, created_by, updated_by)
  values ('coding', 1, 'seed', 'seed')
  on conflict (name) do nothing;
insert into inbox.profile_versions (name, version, definition, created_by)
  values ('coding', 1, '{}'::jsonb, 'seed')
  on conflict (name, version) do nothing;

alter table inbox.sessions add column if not exists profile_name     text;
alter table inbox.sessions add column if not exists profile_version  integer;
alter table inbox.sessions add column if not exists profile_snapshot jsonb;

-- Which profile new sessions get when the request names none; null is `coding`.
alter table inbox.settings add column if not exists default_profile text;

-- What the orchestrator has installed, published at its start: ingest checks profile writes against it. One row.
create table if not exists inbox.orchestrator_capabilities (
  id         boolean primary key default true check (id),
  tools      jsonb not null,
  extensions jsonb not null,
  instance   text not null,
  updated_at timestamptz not null default clock_timestamp()
);
