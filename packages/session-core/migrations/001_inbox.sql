-- Inbox schema of the session API. Own schema, separate from the Pi Durable storage schema (`durable`).
-- Idempotent: ingest and the orchestrator both apply it at start (under an advisory lock, see migrate.ts).

create schema if not exists inbox;

-- One row per API session. `conversation_id` is the Pi Durable conversation, set by the orchestrator when it
-- creates the conversation (lazily, on the first event or stream). One session = one conversation = one
-- SandboxClaim (`pi-conv-<conversation_id>`) = one PVC.
create table if not exists inbox.sessions (
  id               uuid primary key,
  owner            text not null,
  status           text not null default 'active' check (status in ('active', 'deleting', 'deleted')),
  conversation_id  bigint,
  created_at       timestamptz not null default clock_timestamp(),
  last_activity_at timestamptz not null default clock_timestamp()
);

-- The owner check compares the caller's subject (static tokens: `static:<owner>`, OIDC: iss + sub), not the name.
alter table inbox.sessions add column if not exists owner_subject text;

create table if not exists inbox.events (
  id              bigint generated always as identity primary key,
  session_id      uuid not null references inbox.sessions (id),
  source          text not null,
  source_event_id text not null,
  kind            text not null check (kind in ('message', 'steer', 'cancel', 'delete')),
  payload         jsonb not null default '{}',
  status          text not null default 'pending' check (status in ('pending', 'submitted', 'failed')),
  attempts        integer not null default 0,
  created_at      timestamptz not null default clock_timestamp(),
  submitted_at    timestamptz,
  error           text
);

-- Deduplication: the same (source, source_event_id) is one event, however often it is posted.
create unique index if not exists events_source_dedup on inbox.events (source, source_event_id);
-- The orchestrator's claim query: pending rows of one session in arrival order.
create index if not exists events_pending_by_session
  on inbox.events (session_id, created_at, id) where status = 'pending';
create index if not exists events_pending_any on inbox.events (created_at, id) where status = 'pending';

-- Wakes the orchestrator's LISTEN so a new event does not wait for the poll interval.
create or replace function inbox.notify_event() returns trigger language plpgsql as $$
begin
  perform pg_notify('inbox_events', new.session_id::text);
  return new;
end $$;

drop trigger if exists events_notify on inbox.events;
create trigger events_notify after insert on inbox.events
  for each row execute function inbox.notify_event();
