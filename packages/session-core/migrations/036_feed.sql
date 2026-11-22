-- The owner-scoped event feed (issue #365, ADR 0058). Triggers write one row per session change in the transaction that
-- made it, whoever the writer is (ingest or the orchestrator). `xid` is that transaction's id: a reader returns only rows
-- below the oldest transaction still open (`pg_snapshot_xmin`), ordered by (xid, id), so a row committed after a later
-- id was read is never skipped. Shard 0 of the orchestrator deletes old rows and records the newest deleted position in
-- `feed_horizon`; a cursor below it is `truncated`. Ingest only reads. Idempotent, like 001 to 035.

create table if not exists inbox.feed (
  id            bigint generated always as identity primary key,
  xid           xid8 not null default pg_current_xact_id(),
  owner_subject text not null,
  session_id    uuid not null,
  type          text not null,
  data          jsonb not null default '{}',
  created_at    timestamptz not null default clock_timestamp()
);

create index if not exists feed_owner_position on inbox.feed (owner_subject, xid, id);
create index if not exists feed_position on inbox.feed (xid, id);
create index if not exists feed_created on inbox.feed (created_at);

create table if not exists inbox.feed_horizon (
  singleton boolean primary key default true check (singleton),
  xid       xid8 not null,
  id        bigint not null
);

create or replace function inbox.feed_session() returns trigger language plpgsql as $$
begin
  if new.owner_subject is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into inbox.feed (owner_subject, session_id, type, data)
      values (new.owner_subject, new.id, 'session.created',
              jsonb_strip_nulls(jsonb_build_object('profile', new.profile_name)));
  elsif new.status is distinct from old.status and new.status in ('failed', 'deleting', 'deleted') then
    insert into inbox.feed (owner_subject, session_id, type, data)
      values (new.owner_subject, new.id, 'session.status',
              jsonb_strip_nulls(jsonb_build_object('status', new.status,
                'failure', case when new.status = 'failed' then new.failure end)));
  end if;
  return new;
end $$;

drop trigger if exists sessions_feed on inbox.sessions;
create trigger sessions_feed after insert or update of status on inbox.sessions
  for each row execute function inbox.feed_session();

create or replace function inbox.feed_event() returns trigger language plpgsql as $$
declare
  subject text;
begin
  if not ((new.status = 'failed' and old.status is distinct from 'failed')
          or (new.outcome is not null and old.outcome is null)) then
    return new;
  end if;
  select owner_subject into subject from inbox.sessions where id = new.session_id;
  if subject is null then
    return new;
  end if;
  insert into inbox.feed (owner_subject, session_id, type, data)
    values (subject, new.session_id, 'input.settled',
            jsonb_strip_nulls(jsonb_build_object('eventId', new.id::text, 'kind', new.kind, 'status', new.status,
              'outcome', new.outcome, 'reason', new.outcome_reason)));
  return new;
end $$;

drop trigger if exists events_feed on inbox.events;
create trigger events_feed after update of status, outcome on inbox.events
  for each row execute function inbox.feed_event();
