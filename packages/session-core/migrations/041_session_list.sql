-- The session list (issue #511): `GET /sessions` pages one owner's sessions newest first by (created_at, id). This index
-- serves both that and the `status` filter's scan. Idempotent, like 001 to 040; building it takes a short write lock on
-- a table of a few thousand rows (ADR 0005).

create index if not exists sessions_owner_created_idx
  on inbox.sessions (owner_subject, created_at desc, id desc);
