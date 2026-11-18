-- Network mode (issue #47, docs/decisions/0038-network-modes.md): how a session's sandbox reaches the network, fixed when
-- the session is created from its profile version: `proxied` (the egress proxy only) or `direct` (the open internet, no
-- rules, no audit). It picks the SandboxWarmPool (pi-env-direct-pool-<size> for direct). Null for sessions created
-- before modes: they are `proxied`. Idempotent, like 001 to 027.

alter table inbox.sessions add column if not exists network_mode text;
