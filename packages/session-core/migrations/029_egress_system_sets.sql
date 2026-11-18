-- System-owned rule sets (epic #50 slice 8, docs/decisions/0040-mcp-egress-flow.md). A system set is written only by the
-- code that derives it, in the same transaction as what it derives from; the admin API refuses edits of it and a profile
-- cannot name it. The first one is `mcp-catalog`: one rule per host of an enabled MCP server of the catalog
-- (`inbox.mcp_servers`), `route=onecli` for a server that names a OneCLI secret, `direct` otherwise. No session's proxy
-- evaluation uses it (it applies to nobody and no profile may name it): it says which hosts the orchestrator's own MCP
-- calls reach, and the OneCLI host-rule reconciler reads it. Idempotent, like 001 to 028.

alter table egress.rule_sets add column if not exists system boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'rule_sets_system_not_all' and conrelid = 'egress.rule_sets'::regclass
  ) then
    alter table egress.rule_sets add constraint rule_sets_system_not_all check (not (system and applies_to_all));
  end if;
end $$;

do $$
declare
  rev bigint;
begin
  if exists (select 1 from egress.rule_sets where name = 'mcp-catalog') then
    return;
  end if;
  insert into egress.revisions (changed_by) values ('migration 029') returning revision into rev;
  insert into egress.rule_sets (name, description, system, revision, created_by, updated_by)
  values ('mcp-catalog', 'Derived from the MCP server catalog: the hosts the orchestrator reaches for MCP calls. Not editable.',
          true, rev, 'mcp-catalog', 'mcp-catalog');
  perform pg_notify('egress_rules', rev::text);
end $$;
