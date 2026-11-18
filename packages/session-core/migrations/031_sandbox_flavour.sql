-- Sandbox flavour (issue #48, docs/decisions/0041-browser-sandbox.md): which sandbox image a session got, fixed when the
-- session is created from its profile version: `default` or `browser`. With the size and the network mode it picks the
-- SandboxWarmPool (pi-env-browser-pool-<size>). Null for sessions created before flavours: they are `default`.
-- Idempotent, like 001 to 030.

alter table inbox.sessions add column if not exists sandbox_flavour text;
