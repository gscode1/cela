-- Repo skills (docs/decisions/0014-repo-skills.md): `coding` turns `repoSkills` on. Profile versions are immutable, so
-- this is version 2, written only while `coding` is still the seed (version 1, the empty definition): a profile an
-- operator has edited since is theirs and is left alone. Sessions already created keep their snapshot. Idempotent.

insert into inbox.profile_versions (name, version, definition, created_by)
  select 'coding', 2, '{"repoSkills": true}'::jsonb, 'seed'
    from inbox.profiles p
    join inbox.profile_versions v on v.name = p.name and v.version = p.current_version
   where p.name = 'coding' and p.current_version = 1 and v.definition = '{}'::jsonb
  on conflict (name, version) do nothing;

update inbox.profiles
   set current_version = 2, updated_at = clock_timestamp(), updated_by = 'seed'
 where name = 'coding' and current_version = 1
   and exists (select 1 from inbox.profile_versions
                where name = 'coding' and version = 2 and created_by = 'seed');
