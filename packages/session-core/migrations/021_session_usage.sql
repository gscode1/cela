-- Session token usage on the session API (issue #185, docs/decisions/0028-token-budget.md). The orchestrator copies the
-- totals of the conversation's `pi.usage` here when a run settles, because ingest has no Harness to read them.
-- Null until the first run settles. Idempotent, like 001 to 020.

alter table inbox.sessions add column if not exists usage jsonb;
