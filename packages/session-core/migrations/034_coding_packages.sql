-- Package registries for coding sessions (docs/decisions/0052-coding-profile-packages.md, issue #332): `coding` names the
-- `packages` rule set and tells the agent to say so when it could not build or test, as version 4 next to `repoSkills`
-- and `repoContext`. Written only while `coding` is still exactly
-- what migration 013 seeded (version 3, by `seed`): a profile an operator has edited since is theirs and is left alone.
-- It also needs the `packages` rule set (migration 030): without it a profile that names it would not validate, so
-- nothing changes. Sessions already created keep their snapshot. Idempotent.

insert into inbox.profile_versions (name, version, definition, created_by)
  select 'coding', 4, '{"repoSkills": true, "repoContext": true, "egressRuleSets": ["packages"], "instructions": "If you could not build or test a change (a tool, a package or a host was unreachable), say so plainly in your final message and in any pull request, and do not present the change as verified or push it as done."}'::jsonb, 'seed'
    from inbox.profiles p
    join inbox.profile_versions v on v.name = p.name and v.version = p.current_version
   where p.name = 'coding' and p.current_version = 3
     and v.created_by = 'seed' and v.definition = '{"repoSkills": true, "repoContext": true}'::jsonb
     and exists (select 1 from egress.rule_sets where name = 'packages')
  on conflict (name, version) do nothing;

update inbox.profiles
   set current_version = 4, updated_at = clock_timestamp(), updated_by = 'seed'
 where name = 'coding' and current_version = 3
   and exists (select 1 from inbox.profile_versions
                where name = 'coding' and version = 4 and created_by = 'seed');
