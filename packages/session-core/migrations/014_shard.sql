-- Schema sharding (ADR 0017): which orchestrator shard owns a session. Conversation ids are minted per shard schema,
-- so every shard starts at 2 and the identity of a conversation is (shard, conversation_id). Existing sessions belong
-- to shard 0. Idempotent, like 001 to 013.

alter table inbox.sessions add column if not exists shard integer not null default 0;

create unique index if not exists sessions_shard_conversation
  on inbox.sessions (shard, conversation_id) where conversation_id is not null;
