-- Deleting session profiles, skills and MCP servers (ADR 0027). A delete removes the rows; the name is recorded here
-- and never used again, so `{name, version}` in old sessions and the MCP extension name in old conversations can never
-- come to mean something else. The table is also the audit of who deleted what. Idempotent, like 001 to 018.
create table if not exists inbox.deleted_names (
  kind         text not null check (kind in ('profile', 'skill', 'mcp-server')),
  name         text not null,
  last_version integer check (last_version is null or last_version >= 1),
  deleted_at   timestamptz not null default clock_timestamp(),
  deleted_by   text not null,
  primary key (kind, name)
);

-- Versions stay immutable: no update ever, and a delete only from the delete path, which sets this transaction-local
-- setting after its reference checks. It guards against mistakes, not against a role that may set it.
create or replace function inbox.profile_versions_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('pi.allow_delete', true) = 'on' then
    return old;
  end if;
  raise exception 'inbox.profile_versions rows are immutable';
end $$;

create or replace function inbox.skill_rows_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and current_setting('pi.allow_delete', true) = 'on' then
    return old;
  end if;
  raise exception '% rows are immutable', tg_table_name;
end $$;
