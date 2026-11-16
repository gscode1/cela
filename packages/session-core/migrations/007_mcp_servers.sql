-- The MCP server catalog moves from the static PI_MCP_SERVERS environment into Postgres
-- (docs/decisions/0009-mcp-catalog-in-postgres.md). One row per server; the name is the `mcp__<name>__` tool prefix and
-- is immutable. The checks repeat only the cheap shape rules: the full validation is session-core's, shared by the
-- admin writes and the reads. A row never opens egress: the OneCLI host rules and the network policy must also allow
-- the host. No credential is stored: `onecli_secret` is a reference (unused until #42).
-- `mcp_servers_history` is append-only (the application only inserts) and, unlike settings_history, records deletes,
-- so `new` may be null. Every write also notifies channel `pi_mcp_servers`. Idempotent, like 001 to 006.

create table if not exists inbox.mcp_servers (
  name             text primary key check (name ~ '^[a-z][a-z0-9-]{0,31}$'),
  url              text not null check (url ~ '^https://' and length(url) <= 2048),
  transport        text not null default 'streamable-http' check (transport = 'streamable-http'),
  enabled          boolean not null default true,
  read_only        boolean not null,
  timeout_ms       integer not null check (timeout_ms between 1000 and 300000),
  max_output_bytes integer not null check (max_output_bytes between 1024 and 24576),
  onecli_secret    text check (onecli_secret is null or length(onecli_secret) <= 200),
  created_at       timestamptz not null default clock_timestamp(),
  created_by       text not null,
  updated_at       timestamptz not null default clock_timestamp(),
  updated_by       text not null
);

create table if not exists inbox.mcp_servers_history (
  id         bigint generated always as identity primary key,
  changed_at timestamptz not null default clock_timestamp(),
  changed_by text  not null,
  name       text  not null,
  action     text  not null check (action in ('create', 'update', 'delete')),
  old        jsonb,
  new        jsonb
);
