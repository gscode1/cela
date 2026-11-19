-- Each orchestrator's latest MCP discovery outcome per catalog server (issue #292, ADR 0044): a map from server name to
-- {state: 'ready' | 'failed', tools, toolNames | error, checkedAt}. The shard's own orchestrator writes it, ingest only
-- reads it for the admin API. Reset at every orchestrator start, like the other observations of this row. Idempotent,
-- like 001 to 032.

alter table inbox.shard_status add column if not exists mcp_discovery jsonb not null default '{}'::jsonb;
