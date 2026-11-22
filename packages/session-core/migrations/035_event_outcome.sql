-- How each submitted input ended (issue #364, ADR 0058). The orchestrator writes it once, when Pi Durable settles the
-- submission (`Submission.wait()`, ADR 0029): `answered`, or `unanswered` with Pi's reason (`model_error`, `aborted`,
-- `run_failed`, `turn_limit`, ...). Never the provider's error text. Null while the input is pending or running, for
-- `cancel` and `delete` rows, and for inputs settled before this migration. Ingest only reads it. Idempotent, like 001
-- to 034.

alter table inbox.events add column if not exists outcome text check (outcome in ('answered', 'unanswered'));
alter table inbox.events add column if not exists outcome_reason text;
alter table inbox.events add column if not exists settled_at timestamptz;
