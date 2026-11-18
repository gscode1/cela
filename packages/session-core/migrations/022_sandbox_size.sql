-- Sandbox sizes (issue #108, docs/decisions/0030-sandbox-sizes.md): the size a session was created with, which picks
-- its SandboxWarmPool (pi-env-pool-<size>). Null for sessions created before sizes, or by a deployment without sizes;
-- they use the unsized pi-env-pool. Idempotent, like 001 to 021.

alter table inbox.sessions add column if not exists sandbox_size text;
