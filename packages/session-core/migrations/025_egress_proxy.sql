-- The egress proxy's side of the egress schema (epic #50, slice 3, docs/decisions/0035-egress-proxy-runtime.md).
--
-- 1. egress.proxy_status: one row per proxy replica, written by the proxy only (upsert every few seconds), read by the
--    admin API's GET /admin/egress/status. A replica that stops reporting shows as stale; the proxy removes rows that
--    have been silent for ten minutes (old pod names).
-- 2. egress.grant_proxy_reader(role): the grants of the proxy's database role. The role is created by the operator
--    (CREATE ROLE needs CREATEROLE, which the app's database user does not have): read access to the four rule tables
--    and write access to proxy_status, nothing else, so the proxy cannot change a rule. This migration applies it to
--    the role `pi_egress` when that role exists (the bundled Postgres chart creates it); for any other role, or one
--    created later, the app's database user runs `select egress.grant_proxy_reader('<role>')`.
-- Idempotent, like 001 to 024.

create table if not exists egress.proxy_status (
  replica      text primary key check (length(replica) between 1 and 253),
  -- The revision this replica serves; null until its first successful read.
  revision     bigint,
  -- starting: no snapshot yet (the replica is not serving). serving: a snapshot read less than the stale limit ago.
  -- stale: the snapshot is too old, the replica denies everything.
  state        text not null check (state in ('starting', 'serving', 'stale')),
  last_read_at timestamptz,
  started_at   timestamptz not null,
  version      text not null default '' check (length(version) <= 100),
  updated_at   timestamptz not null default clock_timestamp()
);

create or replace function egress.grant_proxy_reader(reader name) returns void
language plpgsql as $$
begin
  execute format('grant usage on schema egress to %I', reader);
  execute format('grant select on egress.revisions, egress.rule_sets, egress.rules to %I', reader);
  execute format('grant select, insert, update, delete on egress.proxy_status to %I', reader);
end $$;

-- Only the owner (the app's database user) may hand out the grants; the proxy's role cannot call it.
revoke all on function egress.grant_proxy_reader(name) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pi_egress') then
    perform egress.grant_proxy_reader('pi_egress');
  end if;
end $$;
