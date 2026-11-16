-- Skills in session profiles (docs/decisions/0011-skills-in-postgres.md). A skill is a name with immutable, numbered
-- versions: a description, a SKILL.md and optional files (scripts, resources), identified by a SHA-256 digest of its
-- content. Profiles pin (name, version, digest) in their definition; the orchestrator writes the files into the
-- session's sandbox. The content is validated in session-core, never here beyond the cheap checks. Versions are
-- history: no update, no delete, so a version a session or profile refers to never changes or goes away.
-- Idempotent, like 001 to 009.

create table if not exists inbox.skills (
  name            text primary key check (name ~ '^[a-z][a-z0-9-]{0,63}$'),
  current_version integer not null check (current_version >= 1),
  created_at      timestamptz not null default clock_timestamp(),
  created_by      text not null,
  updated_at      timestamptz not null default clock_timestamp(),
  updated_by      text not null
);

create table if not exists inbox.skill_versions (
  name        text not null references inbox.skills (name),
  version     integer not null check (version >= 1),
  description text not null check (char_length(description) between 1 and 1024),
  digest      text not null check (digest ~ '^[0-9a-f]{64}$'),
  size_bytes  integer not null check (size_bytes >= 0),
  -- [{ "path", "size", "sha256", "executable" }], sorted by path; the files table holds the bytes.
  manifest    jsonb not null,
  created_at  timestamptz not null default clock_timestamp(),
  created_by  text not null,
  primary key (name, version)
);

create table if not exists inbox.skill_version_files (
  name    text not null,
  version integer not null,
  path    text not null,
  content bytea not null,
  primary key (name, version, path),
  foreign key (name, version) references inbox.skill_versions (name, version)
);

create or replace function inbox.skill_rows_immutable() returns trigger language plpgsql as $$
begin
  raise exception '% rows are immutable', tg_table_name;
end $$;

drop trigger if exists skill_versions_immutable on inbox.skill_versions;
create trigger skill_versions_immutable before update or delete on inbox.skill_versions
  for each row execute function inbox.skill_rows_immutable();

drop trigger if exists skill_version_files_immutable on inbox.skill_version_files;
create trigger skill_version_files_immutable before update or delete on inbox.skill_version_files
  for each row execute function inbox.skill_rows_immutable();
