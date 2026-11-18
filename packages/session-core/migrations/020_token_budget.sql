-- Per-session token budget (issue #178, docs/decisions/0028-token-budget.md). Null: no limit, which keeps every
-- existing deployment as it was. Total tokens Pi Durable records in `pi.usage`, so bigint. Validated in session-core
-- like the other settings. Idempotent, like 001 to 019.

alter table inbox.settings add column if not exists token_budget bigint
  check (token_budget is null or token_budget >= 1);
