-- Egress rules for the sandbox egress proxy (epic #50, docs/decisions/0034-egress-rules.md). Schema `egress` is written
-- only through session-core (the admin API in ingest); the proxy of slice 3 will only read it. Rows are validated in
-- session-core (host syntax, ports, names); the checks here repeat only the cheap shape rules, like 007.
--
-- Rules live in named rule sets, which session profiles reference (`egressRuleSets` in the profile definition). A set
-- with `applies_to_all` applies to every session. A rule belongs to exactly one rule set, or to one session (temporary
-- per-session rules, written by the orchestrator later).
--
-- `revisions` is a log: one row per write, and the highest `revision` is the revision of everything in this schema (0
-- while there is none). Writers take the advisory lock `egress:rules`, so revisions are committed in order. A write also
-- inserts a `rules_history` row and notifies channel `egress_rules` with the new revision, in the same transaction.
-- `principals` and `bindings` (slices 4 and 5) are not created here. Idempotent, like 001 to 023.

create schema if not exists egress;

create table if not exists egress.revisions (
  revision   bigint generated always as identity primary key,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by text not null
);

create table if not exists egress.rule_sets (
  name           text primary key check (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  description    text not null default '' check (length(description) <= 500),
  applies_to_all boolean not null default false,
  -- The revision at this row's last write.
  revision       bigint not null,
  created_at     timestamptz not null default clock_timestamp(),
  created_by     text not null,
  updated_at     timestamptz not null default clock_timestamp(),
  updated_by     text not null
);

create table if not exists egress.rules (
  id         bigint generated always as identity primary key,
  rule_set   text references egress.rule_sets (name) on delete cascade,
  -- A session id; the session need not exist (a rule for a deleted session is inert).
  session_id text check (session_id is null or length(session_id) <= 64),
  effect     text not null check (effect in ('allow', 'deny')),
  -- Lowercase, no trailing dot. A leading dot makes it a suffix match (`.githubusercontent.com`), `*` matches any host
  -- (route direct only, the least specific allow), otherwise exact.
  -- A `cidr` (`10.20.0.0/16`) is only valid on a private rule.
  host       text not null check (
    host = '*' or host ~ '^\.?[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' or host ~ '^[0-9a-f:.]{2,45}/[0-9]{1,3}$'
  ),
  ports      integer[] not null default '{443}' check (cardinality(ports) between 1 and 32),
  route      text not null default 'direct' check (route in ('direct', 'onecli')),
  -- An allow that may reach a private or cluster address (ADR 0034): an exact host or a cidr, explicit ports, direct.
  allows_private boolean not null default false,
  expires_at timestamptz,
  note       text not null default '' check (length(note) <= 500),
  revision   bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by text not null,
  updated_at timestamptz not null default clock_timestamp(),
  updated_by text not null,
  check ((rule_set is null) <> (session_id is null)),
  check (host <> '*' or route = 'direct'),
  check (host !~ '/' or allows_private),
  check (not allows_private or (effect = 'allow' and route = 'direct' and host <> '*' and host !~ '^\.'))
);

create index if not exists rules_rule_set on egress.rules (rule_set);
create index if not exists rules_session on egress.rules (session_id);

-- One row per change of a rule set or a rule. `ref` is the rule set's name or the rule's id. A rule set's delete keeps
-- the rules it took with it in `old`.
create table if not exists egress.rules_history (
  id         bigint generated always as identity primary key,
  revision   bigint not null,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by text not null,
  kind       text not null check (kind in ('rule-set', 'rule')),
  ref        text not null,
  action     text not null check (action in ('create', 'update', 'delete')),
  old        jsonb,
  new        jsonb
);

-- Starter rule sets, once, on a database that has no egress revision yet. All are `applies_to_all = false`: an admin
-- chooses which apply to everyone. They are ordinary rows, editable and deletable. They have no history entry.
do $$
declare
  rev bigint;
begin
  if exists (select 1 from egress.revisions) then
    return;
  end if;
  insert into egress.revisions (changed_by) values ('migration 024') returning revision into rev;
  insert into egress.rule_sets (name, description, revision, created_by, updated_by) values
    ('npm', 'npm registry', rev, 'migration 024', 'migration 024'),
    ('pypi', 'Python package index and its files', rev, 'migration 024', 'migration 024'),
    ('debian', 'Debian package mirrors', rev, 'migration 024', 'migration 024'),
    ('github-public', 'github.com, its archives and raw content', rev, 'migration 024', 'migration 024'),
    ('go', 'Go module proxy and checksum database', rev, 'migration 024', 'migration 024'),
    ('rust', 'crates.io index and downloads', rev, 'migration 024', 'migration 024'),
    ('open-web', 'Any public host (never private, cluster or metadata addresses)', rev, 'migration 024', 'migration 024');
  insert into egress.rules (rule_set, effect, host, ports, revision, created_by, updated_by)
  select s.rule_set, 'allow', s.host, s.ports, rev, 'migration 024', 'migration 024'
    from (values
      ('npm', 'registry.npmjs.org', '{443}'::integer[]),
      ('pypi', 'pypi.org', '{443}'),
      ('pypi', 'files.pythonhosted.org', '{443}'),
      ('debian', 'deb.debian.org', '{80,443}'),
      ('debian', 'security.debian.org', '{80,443}'),
      ('github-public', 'github.com', '{443}'),
      ('github-public', 'codeload.github.com', '{443}'),
      ('github-public', '.githubusercontent.com', '{443}'),
      ('go', 'proxy.golang.org', '{443}'),
      ('go', 'sum.golang.org', '{443}'),
      ('rust', 'crates.io', '{443}'),
      ('rust', 'index.crates.io', '{443}'),
      ('rust', 'static.crates.io', '{443}'),
      ('open-web', '*', '{443}')
    ) as s (rule_set, host, ports);
end $$;
