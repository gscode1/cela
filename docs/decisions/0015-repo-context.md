# 0015: The repo's AGENTS.md / CLAUDE.md becomes project instructions

Status: accepted, 2026-11-16 (issue #72). Builds on [0014](0014-repo-skills.md) (the scan hook, `configure`) and
[0010](0010-session-profiles.md).

## Context

Pi loads the project's context file into the system prompt (`core/resource-loader.ts`, `loadContextFileFromDir`) and
renders it as `<project_instructions path="...">` (`core/system-prompt.ts`). Nothing here loaded such a file: a repo
session ran without the repo's own instructions.

## Decision

- **Which file.** In `/workspace/repo` (the checkout root only; no ancestors, no user-level file), the first regular file
  of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`, in that order, as Pi picks it. One
  `listDir` of the root finds it, and a symlink or directory of that name is passed over, so a repo cannot point the
  prompt at another file. A file that cannot be read is skipped with a log line (`repo-context-skipped`), as one over
  1 MiB is. A leading BOM is dropped.
- **Size cap.** 32 KiB of UTF-8. A longer file is cut at a character boundary and ends with
  `[truncated: <name> is <n> bytes, only the first 32768 are shown]`, logged as `repo-context-truncated`. Truncating keeps
  the start, where a context file puts what matters, instead of dropping the whole file.
- **Rendering.** Pi's `renderProjectContext` for one file: `Project-specific instructions and guidelines:`, a blank line,
  then `<project_instructions path="/workspace/repo/AGENTS.md">`, the content and the closing tag. (Pi also wraps its
  sections in `<project_context>`; our text is appended to the conversation's instructions, which have no such
  wrapper.)
- **Order.** Profile instructions, then project instructions, then the skills catalog. This is Pi's order: its
  `buildSystemPromptSections` puts the appended system prompt (our profile instructions) first, then `project_context`,
  then `skills`.
- **Same hook.** Read in the same pass as repo skills (`SessionService.#refreshRepoContext`, ADR 0014): after the clone and
  at each new message, only while the sandbox is already open, applied with one `configure({ instructions })` that writes
  nothing when the text is unchanged; a failure logs and keeps the instructions. The instructions are rebuilt from the
  profile's, the file, and the catalog (admin skills, plus the repo's when `repoSkills` is on), so turning only one switch
  on leaves the other part as the conversation was created.
- **Switch.** `definition.repoContext?: boolean`, absent means off, in the snapshot, shown as `repoContext: true` in
  `GET /sessions/{id}`, ignored without a repo. Unlike repo skills it needs no `read` tool: the text is in the prompt.
  Migration `013_coding_repo_context.sql` turns it on in `coding` as version 3, only while `coding` is still what `012`
  seeded.
- **Not pinned.** Like repo skills the file is whatever the checkout holds; a repo's instructions are repo content in the
  prompt, which choosing the repo already trusts. Nothing widens the tools.

## Not done

Nested or ancestor context files, a user-level file, `AGENT.md` (singular, which Pi does not load either), a per-file
trust label, a watcher.
