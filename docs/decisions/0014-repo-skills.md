# 0014: Repo skills are scanned from the clone, not pinned

Status: accepted, 2026-11-16 (issue #71). Builds on [0011](0011-skills-in-postgres.md) (catalog, frontmatter parser) and
[0010](0010-session-profiles.md) (profiles, snapshots).

## Context

Pi discovers skills in the project it runs in (`.pi/skills`, `.agents/skills`, Pi 1.5.2 `core/skills.ts`) and shows the
model a catalog. Here the project is the session's clone at `/workspace/repo`, which lives in the sandbox, not on the
orchestrator's disk. Pi reads skills at startup and on `/reload`, not on every turn.

## Decision

- **Where and what.** Through the session's sandbox env (`listDir`, `readTextFile`), the orchestrator looks in
  `/workspace/repo/.pi/skills/**/SKILL.md` then `/workspace/repo/.agents/skills/**/SKILL.md`, anchored at the checkout
  root (the conversation's cwd is `/workspace`). A directory that has a `SKILL.md` is a skill and is not searched
  further; hidden directories and `node_modules` are skipped; a symlink is neither followed nor listed (the env reports
  it as neither file nor directory). Depth is bounded (4 levels below a skills directory, 200 listings, 100 files per
  scan). `.claude/skills` is not read. Locations point into `/workspace/repo`; nothing is copied.
- **Frontmatter.** The 0011 parser (`parseFrontmatter`). `description` is required (at most 1024 characters, no control
  characters), `name` falls back to the directory name (at most 64 characters), `disable-model-invocation: true` keeps
  the skill out of the catalog, and a `SKILL.md` over 32 KiB is skipped. An invalid file is skipped with a
  `repo-skill-skipped` log line (path and reason) and never fails the scan. Unlike the admin store the name need not match
  `[a-z][a-z0-9-]*`: Pi does not require it.
- **One catalog.** Admin skills (the profile's pins) come first and win a name collision; then the repo's in scan order
  (`.pi` before `.agents`, directories sorted by name; the first of two equal names wins). The admin and repo entries
  share the 0011 cap: 20 skills and a 32 KiB catalog; a repo skill that does not fit is dropped with a log line. It is
  the same `buildSkillCatalog` text, so the wording and `<available_skills>` shape are Pi's.
- **When.** Not per request and no watcher. In `SessionService.prepare`, which the inbox runs before it claims each new
  `message` or `steer` row of a repo session, right after `#prepareRepo` (so after the clone), the orchestrator rescans
  **only if the session's sandbox env is already open** (`Sandboxes.isOpen`, which is `#envs.has(id)`: it asks, never
  opens or resumes anything). A session whose sandbox is suspended, evicted or recycled keeps the instructions of its
  last scan until a tool call opens the sandbox again, and a chat-only turn never wakes it. After an orchestrator restart
  `#prepareRepo` opens the env (its clone check runs again), so the first message rescans; the instructions stored with
  the conversation are only ever replaced by a scan.
- **Apply.** `conversation.configure({ instructions })` with the profile's `instructions` and then the one catalog
  (`Host.setInstructions`). Text equal to what is stored writes nothing; no catalog and no instructions clears them. A
  scan or apply failure logs `repo-context-failed` and keeps the instructions: it never blocks a turn.
- **Switch.** `definition.repoSkills?: boolean`, absent means off, part of the snapshot, shown as `repoSkills: true` in
  `GET /sessions/{id}`, ignored for a session without a repo. A profile that enables it must keep `read` in `tools` and
  `modelTools` when given (the validator, as for `skills`). Migration `012_coding_repo_skills.sql` turns it on in `coding`
  as version 2, only when `coding` is still the seeded version 1 (an operator's own edit is left alone); versions are
  immutable, so version 1 and the snapshots of sessions that exist are untouched.
- **Content is not pinned.** The repo's skills change with the checkout (a pull, a commit by the agent) and are the
  agent's own workspace, so unlike 0011 there is no digest. They are repo content in the model's prompt: choosing a repo
  for a session is trusting its text, as with any repository the agent reads. Nothing here widens tools or the
  agent's permissions.

## Not done

Per-request rescans, watchers, trust labels, collision diagnostics beyond the log line, ignore files, standalone `.md`
skills, `/skill:name`, ancestor and user-level directories, `.claude/skills`.

## Consequences

- A message to a session with an open sandbox costs a few `listDir` calls (two if the repo has no skills) and, per skill,
  one read.
- The catalog can differ from what a session started with; the conversation's stored instructions are the one place to
  see what the model has.
