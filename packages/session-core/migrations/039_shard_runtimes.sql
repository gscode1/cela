-- Per-runtime status (issue #406, ADR 0064): `{"<runtime>": {"configured": "<class>", "observed": "<class>"|null,
-- "insecure": bool}}` with one entry for `default` and one per named sandbox runtime. `configured_runtime` and
-- `observed_runtime` stay the default runtime's values and are written only when a default-runtime session attaches, so
-- sessions on different runtimes no longer overwrite each other. A jsonb column with a constant default is a
-- catalog-only change in Postgres 11+: no table rewrite and no long lock (ADR 0005). Idempotent, like 001 to 038.

alter table inbox.shard_status add column if not exists runtimes jsonb not null default '{}'::jsonb;
