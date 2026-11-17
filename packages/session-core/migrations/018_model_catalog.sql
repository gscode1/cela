-- The model catalog the orchestrator publishes with its capabilities (docs/decisions/0025-model-catalog.md): the models pi-ai
-- knows, per provider, for the admin console's pickers and for ingest to check new model settings against. Null until an
-- orchestrator that publishes it has started. Idempotent, like 001 to 017.

alter table inbox.orchestrator_capabilities add column if not exists models jsonb;
-- Per provider, whether a credential is configured in OneCLI: `[{ "provider", "credential" }]`, a hint only.
alter table inbox.orchestrator_capabilities add column if not exists model_providers jsonb;
