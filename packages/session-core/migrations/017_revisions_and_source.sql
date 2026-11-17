-- Optimistic concurrency and a reserved catalog source for the admin console (docs/decisions/0023-admin-revisions.md).
-- `revision` counts the writes of a settings row, a profile (including enable and disable, which add no version) and
-- an MCP server: it starts at 1 and every write that changes something adds one. Writers may send it back as
-- `expectedRevision`. `source` is `{ "repository", "commit" }`, reserved for a future catalog repository sync, kept out
-- of every digest; a skill version's is set when the version is published and never changes (the rows are immutable).
-- Adding a column fires no row trigger. Idempotent, like 001 to 016.

alter table inbox.settings    add column if not exists revision integer not null default 1 check (revision >= 1);
alter table inbox.profiles    add column if not exists revision integer not null default 1 check (revision >= 1);
alter table inbox.mcp_servers add column if not exists revision integer not null default 1 check (revision >= 1);

alter table inbox.mcp_servers   add column if not exists source jsonb;
alter table inbox.skill_versions add column if not exists source jsonb;
