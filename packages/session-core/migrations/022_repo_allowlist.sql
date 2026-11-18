-- Which repositories a session may clone (issue #197, docs/decisions/0030-repo-allowlist.md). A JSON array of `*`,
-- `owner/*` or `owner/name`, validated in session-core like the other settings. Empty refuses every repo session: an
-- existing deployment keeps working only once an admin lists its repositories. A constant default is a catalog-only
-- change, so no table rewrite. Idempotent, like 001 to 021.

alter table inbox.settings add column if not exists repo_allowlist jsonb not null default '[]';
