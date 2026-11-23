-- Sandbox runtime (issue #406): which named runtime (the chart's `sandbox.runtimes`) a session's sandbox runs under,
-- fixed when the session is created from its profile version. Null: the default runtime (`sandbox.runtimeClassName`),
-- which is every session created before named runtimes. With the size, the network mode and the flavour it picks the
-- SandboxWarmPool (pi-env-rt-<name>-pool). A nullable column with no default is a catalog-only change in Postgres:
-- no table rewrite and no long lock (ADR 0005). Idempotent, like 001 to 037.

alter table inbox.sessions add column if not exists sandbox_runtime text;
