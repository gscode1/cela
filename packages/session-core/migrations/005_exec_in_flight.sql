-- Sandbox lifecycle: which sessions had a command running in their sandbox. Set when the first command of a burst
-- starts, cleared when the last one ended without being interrupted. A row that is still set at orchestrator start
-- means the previous process died mid-command, so the sandbox Pod may hold `setsid` children that survived the
-- kill: the orchestrator recycles that Pod (never the claim or the PVC). Idempotent, like 001 to 004.

alter table inbox.sessions add column if not exists exec_in_flight_at timestamptz;
