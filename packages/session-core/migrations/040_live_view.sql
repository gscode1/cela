-- Public view-only live view of a desktop session (issue #418, ADR 0066): the unguessable token that is the viewer's
-- URL. Null: the live view is off, which is every session until its owner turns it on. Plaintext on purpose: GET must
-- return the URL, and the token grants view-only access to one desktop. A nullable column with no default is a
-- catalog-only change in Postgres: no table rewrite and no long lock (ADR 0005). Idempotent, like 001 to 039.

alter table inbox.sessions add column if not exists live_view_token text;

create unique index if not exists sessions_live_view_token_idx
  on inbox.sessions (live_view_token) where live_view_token is not null;
