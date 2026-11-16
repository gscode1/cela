-- Operator cap on the reasoning effort a session request may ask for (issue #37,
-- docs/decisions/0008-settings-in-postgres.md). Null: no cap. Validated in session-core like the other settings.
-- Idempotent, like 001 to 006.

alter table inbox.settings add column if not exists max_reasoning text;
