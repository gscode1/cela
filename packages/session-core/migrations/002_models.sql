-- Phase 4b: each session records the model it was created with, and a terminal `failed` state.
-- Idempotent, like 001.

alter table inbox.sessions add column if not exists model_provider text;
alter table inbox.sessions add column if not exists model_id text;
-- Why the session is `failed` (model credentials rejected, turn budget used up). Null otherwise.
alter table inbox.sessions add column if not exists failure text;

-- `failed` is terminal: no further events are accepted, only DELETE. Replace the inline check from 001, once.
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conrelid = 'inbox.sessions'::regclass
       and conname = 'sessions_status_check'
       and pg_get_constraintdef(oid) not like '%failed%'
  ) then
    alter table inbox.sessions drop constraint sessions_status_check;
    alter table inbox.sessions add constraint sessions_status_check
      check (status in ('active', 'deleting', 'deleted', 'failed'));
  end if;
end $$;
