-- Consolidates the starter rule sets of 024 (epic #50, docs/decisions/0034-egress-rules.md, addendum "One packages set").
-- `npm`, `pypi`, `debian`, `go` and `rust` were too granular: they become one set, `packages`. Migration 024 is already
-- applied on existing databases and must not change, so this one converts: on a fresh database it leaves exactly
-- `packages`, `github-public` and `open-web` (and `mcp-catalog`, 029); on an existing one it adds `packages` and deletes
-- each old set that nobody touched.
--
-- An old set is "untouched" only when all of these hold; otherwise it stays as it is:
--  - it is as 024 seeded it: the set row (description, applies_to_all, system, created_by/updated_by `migration 024`,
--    revision = the seed revision) and its rules (exactly the seeded hosts and ports, allow, direct, not private, no
--    expiry, no note, revision = the seed revision, by `migration 024`). Any edit through the admin API changes the
--    revision or the `updated_by` of the row it touches, and adding or removing a rule changes the rule list.
--  - `egress.rules_history` has no entry for it (024 writes none; every admin write adds one), and
--  - no profile version of any age names it in `egressRuleSets` (a stored snapshot or a re-enabled version stays
--    resolvable, ADR 0010), which is stricter than the delete check of the admin API (current version only).
-- A database where 024 skipped its seed (a revision existed already) has no seed revision, so nothing is deleted.
--
-- Runs once, guarded by its own revision row. It writes like egress-store: one revision, a history row per change with
-- the actor `migration 030`, and a NOTIFY of the revision, under the advisory lock `egress:rules`.

do $$
declare
  rev      bigint;
  seed_rev bigint;
  old_name text;
  snapshot jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('egress:rules'));
  if exists (select 1 from egress.revisions where changed_by = 'migration 030') then
    return;
  end if;
  select min(revision) into seed_rev from egress.revisions where changed_by = 'migration 024';

  insert into egress.revisions (changed_by) values ('migration 030') returning revision into rev;

  if not exists (select 1 from egress.rule_sets where name = 'packages') then
    insert into egress.rule_sets (name, description, revision, created_by, updated_by)
    values ('packages', 'Package registries and mirrors', rev, 'migration 030', 'migration 030');
    insert into egress.rules (rule_set, effect, host, ports, revision, created_by, updated_by)
    select 'packages', 'allow', s.host, s.ports, rev, 'migration 030', 'migration 030'
      from (values
        ('registry.npmjs.org', '{443}'::integer[]),
        ('registry.yarnpkg.com', '{443}'),
        ('pypi.org', '{443}'),
        ('files.pythonhosted.org', '{443}'),
        ('deb.debian.org', '{80,443}'),
        ('security.debian.org', '{80,443}'),
        ('proxy.golang.org', '{443}'),
        ('sum.golang.org', '{443}'),
        ('crates.io', '{443}'),
        ('index.crates.io', '{443}'),
        ('static.crates.io', '{443}')
      ) as s (host, ports);
    select jsonb_build_object('description', 'Package registries and mirrors', 'appliesToAll', false) into snapshot;
    insert into egress.rules_history (revision, changed_by, kind, ref, action, old, new)
    values (rev, 'migration 030', 'rule-set', 'packages', 'create', null, snapshot);
    insert into egress.rules_history (revision, changed_by, kind, ref, action, old, new)
    select rev, 'migration 030', 'rule', r.id::text, 'create', null,
           jsonb_build_object('ruleSet', 'packages', 'sessionId', null, 'effect', r.effect, 'host', r.host,
                              'ports', r.ports, 'route', r.route, 'private', false, 'expiresAt', null, 'note', '')
      from egress.rules r where r.rule_set = 'packages' order by r.id;
  end if;

  if seed_rev is not null then
    for old_name in select unnest(array['npm', 'pypi', 'debian', 'go', 'rust']) loop
      if not exists (
           select 1 from egress.rule_sets s
            where s.name = old_name
              and s.revision = seed_rev and not s.applies_to_all and not s.system
              and s.created_by = 'migration 024' and s.updated_by = 'migration 024'
              and s.description = case old_name
                    when 'npm' then 'npm registry'
                    when 'pypi' then 'Python package index and its files'
                    when 'debian' then 'Debian package mirrors'
                    when 'go' then 'Go module proxy and checksum database'
                    when 'rust' then 'crates.io index and downloads'
                  end
         )
         or exists (select 1 from egress.rules_history h where h.kind = 'rule-set' and h.ref = old_name)
         or exists (
           select 1 from inbox.profile_versions v where v.definition->'egressRuleSets' ? old_name
         )
         -- The rules, compared as a whole: any difference in either direction keeps the set.
         or (
           select coalesce(array_agg(r.host || ':' || array_to_string(r.ports, ',') order by r.host), '{}')
             from egress.rules r
            where r.rule_set = old_name
              and r.effect = 'allow' and r.route = 'direct' and not r.allows_private
              and r.expires_at is null and r.note = '' and r.session_id is null
              and r.revision = seed_rev and r.created_by = 'migration 024' and r.updated_by = 'migration 024'
         ) is distinct from (
           select array_agg(h || ':' || p order by h)
             from (values
               ('npm', 'registry.npmjs.org', '443'),
               ('pypi', 'pypi.org', '443'),
               ('pypi', 'files.pythonhosted.org', '443'),
               ('debian', 'deb.debian.org', '80,443'),
               ('debian', 'security.debian.org', '80,443'),
               ('go', 'proxy.golang.org', '443'),
               ('go', 'sum.golang.org', '443'),
               ('rust', 'crates.io', '443'),
               ('rust', 'index.crates.io', '443'),
               ('rust', 'static.crates.io', '443')
             ) as seeded (s, h, p)
            where s = old_name
         )
         or (select count(*) from egress.rules where rule_set = old_name) <>
            (select count(*) from egress.rules r
              where r.rule_set = old_name and r.revision = seed_rev and r.created_by = 'migration 024')
      then
        continue;
      end if;
      select jsonb_build_object(
               'description', s.description, 'appliesToAll', false,
               'rules', (select jsonb_agg(
                          jsonb_build_object('ruleSet', old_name, 'sessionId', null, 'effect', r.effect,
                                             'host', r.host, 'ports', r.ports, 'route', r.route, 'private', false,
                                             'expiresAt', null, 'note', '')
                          order by r.host)
                           from egress.rules r where r.rule_set = old_name))
        into snapshot from egress.rule_sets s where s.name = old_name;
      delete from egress.rules where rule_set = old_name;
      delete from egress.rule_sets where name = old_name;
      insert into egress.rules_history (revision, changed_by, kind, ref, action, old, new)
      values (rev, 'migration 030', 'rule-set', old_name, 'delete', snapshot, null);
    end loop;
  end if;

  perform pg_notify('egress_rules', rev::text);
end $$;
