-- Skills take their description from the SKILL.md frontmatter (docs/decisions/0011-skills-in-postgres.md), including
-- `disable-model-invocation: true`: such a version can be pinned and is written to the sandbox, but is not in the
-- catalog the model sees. Existing rows are catalog skills. Adding a column fires no row trigger, so versions stay
-- immutable. Idempotent, like 001 to 010.

alter table inbox.skill_versions
  add column if not exists disable_model_invocation boolean not null default false;
