-- Per-session upstream bindings (epic #50, slice 5, docs/decisions/0037-egress-onecli-route.md).
--
-- One row per session whose route=onecli traffic the proxy may chain through OneCLI: the session's OneCLI agent token,
-- sealed with AES-256-GCM. The orchestrator is the only writer, the proxy the reader. The key is in a Secret that both
-- mount (never in the database), so a database reader (a backup, the proxy's own role, an admin with SELECT) sees
-- ciphertext only:
--  - nonce: 12 random bytes per write;
--  - ciphertext: the token's encryption followed by the 16-byte GCM tag. The additional data is
--    'egress-binding:v1:<session id>', so a row copied onto another session's does not open;
--  - key_id: a fingerprint of the key (not the key), to tell "sealed with another key" from "corrupted".
-- A binding is deleted when its session is (and by the orphan sweep); the proxy then has no upstream token for it and
-- denies the onecli route (never a direct fallback). Every write notifies channel `egress_rules`, as 026 does.
-- Idempotent, like 001 to 026.

create table if not exists egress.bindings (
  session_id text primary key check (length(session_id) between 1 and 64),
  key_id     text not null check (key_id ~ '^[0-9a-f]{16}$'),
  nonce      bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 17 and 1040),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function egress.notify_bindings() returns trigger
language plpgsql as $$
begin
  perform pg_notify('egress_rules', 'bindings');
  return null;
end $$;

create or replace trigger bindings_notify
  after insert or update or delete on egress.bindings
  for each statement execute function egress.notify_bindings();

-- As 026, plus read access to the sealed bindings. Still no write besides proxy_status.
create or replace function egress.grant_proxy_reader(reader name) returns void
language plpgsql as $$
begin
  execute format('grant usage on schema egress to %I', reader);
  execute format('grant select on egress.revisions, egress.rule_sets, egress.rules, egress.bindings to %I', reader);
  execute format(
    'grant select (session_id, token_hash, profile_name, profile_version, rule_sets, pod_ip, created_at, revoked_at) on egress.principals to %I',
    reader);
  execute format('grant select, insert, update, delete on egress.proxy_status to %I', reader);
end $$;

revoke all on function egress.grant_proxy_reader(name) from public;

-- The role `pi_egress` gets the new grant now; another reader runs `select egress.grant_proxy_reader('<role>')` once more.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'pi_egress') then
    perform egress.grant_proxy_reader('pi_egress');
  end if;
end $$;
