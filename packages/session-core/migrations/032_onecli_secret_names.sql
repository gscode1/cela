-- The names of the OneCLI secrets an MCP server could name as its `onecliSecret` (issue #283, ADR 0040 amendment): what
-- the orchestrator last listed, for the admin console's picker. Names only, never values or ids, and without the secrets
-- the orchestrators create for sessions. Null while unknown (no admin key, a failed listing at start, an older
-- orchestrator). Idempotent, like 001 to 031.

alter table inbox.orchestrator_capabilities add column if not exists onecli_secret_names jsonb;
