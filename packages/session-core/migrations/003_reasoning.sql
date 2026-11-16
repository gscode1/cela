-- Reasoning effort (Pi's thinkingLevel) a session was created with. Null: none stored, Pi's default (off) applies.
-- Idempotent, like 001 and 002.

alter table inbox.sessions add column if not exists model_reasoning text;
