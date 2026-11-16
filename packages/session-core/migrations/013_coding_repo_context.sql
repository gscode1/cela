-- Repo context (docs/decisions/0015-repo-context.md): `coding` turns `repoContext` on, as version 3 next to
-- `repoSkills`. Written only while `coding` is still exactly what migration 012 seeded (version 2, `repoSkills` only,
-- by `seed`): a profile an operator has edited since is theirs and is left alone. Sessions already created keep their
-- snapshot. Idempotent.

insert into inbox.profile_versions (name, version, definition, created_by)
  select 'coding', 3, '{"repoSkills": true, "repoContext": true}'::jsonb, 'seed'
    from inbox.profiles p
    join inbox.profile_versions v on v.name = p.name and v.version = p.current_version
   where p.name = 'coding' and p.current_version = 2
     and v.created_by = 'seed' and v.definition = '{"repoSkills": true}'::jsonb
  on conflict (name, version) do nothing;

update inbox.profiles
   set current_version = 3, updated_at = clock_timestamp(), updated_by = 'seed'
 where name = 'coding' and current_version = 2
   and exists (select 1 from inbox.profile_versions
                where name = 'coding' and version = 3 and created_by = 'seed');
