-- The isolation probe (docs/install-plan.md section 6). Shard 0's orchestrator runs it and writes the result here;
-- ingest reads it, and asks for a new run by setting probe_requested_at (ingest has no Kubernetes access).
alter table inbox.shard_status
  add column if not exists network_policy_checked_at timestamptz,
  add column if not exists network_policy_detail jsonb,
  add column if not exists probe_requested_at timestamptz;
