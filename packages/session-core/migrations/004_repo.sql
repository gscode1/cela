-- Phase 4c: an optional repository workspace per session, and the OneCLI objects that serve it.
-- Idempotent, like 001 to 003.

alter table inbox.sessions add column if not exists repo text;          -- `owner/name`, null: no repository
alter table inbox.sessions add column if not exists repo_branch text;   -- null: the repository's default branch
-- The session's OneCLI agent and per-session secrets (ids, never values). Null until provisioned.
alter table inbox.sessions add column if not exists onecli_agent_id text;
alter table inbox.sessions add column if not exists onecli_secret_ids text[];
-- Set once the clone is done and the workspace marker exists. A later missing marker means the workspace was
-- lost, which is reported instead of silently cloned again.
alter table inbox.sessions add column if not exists workspace_ready_at timestamptz;

-- Written first when a session is deleted, before any OneCLI object or claim goes away, so a crash mid-delete
-- leaves a record of what still has to be revoked. Never deleted: it is the audit trail of what a session held.
create table if not exists inbox.tombstones (
  session_id        uuid primary key,
  conversation_id   bigint,
  repo              text,
  onecli_agent_id   text,
  onecli_secret_ids text[],
  created_at        timestamptz not null default clock_timestamp(),
  completed_at      timestamptz
);
