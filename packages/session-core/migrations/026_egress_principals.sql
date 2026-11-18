-- Per-session egress principals (epic #50, slice 4, docs/decisions/0036-egress-principals.md).
--
-- One row per session that gets the proxy environment: who the proxy sees behind a token. The orchestrator writes it,
-- the proxy reads it (and nothing else of it):
--  - token_hash: sha256 (hex) of the egress token. The token itself is never stored. The orchestrator derives it from its
--    master key, the session id and `token_salt` (random, per session), so it can hand the same token to the sandbox
--    again after a restart without keeping it; the proxy's role cannot read the salt (column grant below).
--  - profile_name, profile_version, rule_sets: the profile the session was created with and the `egressRuleSets` of that
--    version. Profile versions are immutable and a session pins one, so this copy is what a reference would resolve to;
--    keeping it here means the proxy needs no access to schema `inbox`.
--  - pod_ip: the sandbox Pod's address while known. The proxy accepts the token only from that address.
--  - revoked_at: set when the session is deleted (or swept); the proxy then answers 407 to the token.
-- Every write notifies channel `egress_rules` (the proxy already listens), so a revocation reaches the proxy at once and
-- within its poll (5 s) at worst. Idempotent, like 001 to 025.

create table if not exists egress.principals (
  session_id      text primary key check (length(session_id) between 1 and 64),
  token_hash      text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  token_salt      text not null check (token_salt ~ '^[0-9a-f]{64}$'),
  profile_name    text,
  profile_version integer,
  rule_sets       text[] not null default '{}' check (cardinality(rule_sets) <= 64),
  pod_ip          inet,
  created_at      timestamptz not null default clock_timestamp(),
  updated_at      timestamptz not null default clock_timestamp(),
  revoked_at      timestamptz
);

create or replace function egress.notify_principals() returns trigger
language plpgsql as $$
begin
  perform pg_notify('egress_rules', 'principals');
  return null;
end $$;

create or replace trigger principals_notify
  after insert or update or delete on egress.principals
  for each statement execute function egress.notify_principals();

-- As 025, plus read access to the principals without their salt. A column grant: the role cannot select token_salt.
create or replace function egress.grant_proxy_reader(reader name) returns void
language plpgsql as $$
begin
  execute format('grant usage on schema egress to %I', reader);
  execute format('grant select on egress.revisions, egress.rule_sets, egress.rules to %I', reader);
  execute format(
    'grant select (session_id, token_hash, profile_name, profile_version, rule_sets, pod_ip, created_at, revoked_at) on egress.principals to %I',
    reader);
  execute format('grant select, insert, update, delete on egress.proxy_status to %I', reader);
end $$;

revoke all on function egress.grant_proxy_reader(name) from public;

-- The role `pi_egress` (the bundled Postgres) gets the new grant now; a reader with another name needs
-- `select egress.grant_proxy_reader('<role>')` once more, as the app's database user (docs/network-policy.md).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pi_egress') then
    perform egress.grant_proxy_reader('pi_egress');
  end if;
end $$;
