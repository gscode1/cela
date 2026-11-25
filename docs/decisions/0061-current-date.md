# 0061: The current date in every model request

Status: accepted, 2026-11-22 (issue #371). Builds on [0049](0049-sandbox-environment-instructions.md) (no timestamps in
the instructions) and [0055](0055-fit-images.md) (extensions in the pinned host default).

## Context

ADR 0049 keeps the instructions free of anything that changes over time, so the start of every request stays the same
and the provider can cache it. Nothing else told the agent the date, so it took "now" to be near its training cutoff. On
2026-11-22 a GPT agent assumed 2025-11-17, dismissed the 2026-07-28 MCP specification as "from the future" and reported
an older one as the latest. Release notes, "latest version" checks and renovate reviews are all exposed.

Options weighed:

- **A profile instruction to run `date`.** No code, but it relies on the model doubting itself, and the agent above was
  sure. It also costs a tool round and has to be repeated in every profile.
- **A prompt section with today's date.** Pi Durable stores a changed section as a positional entry, which is free on a
  model with `supportsMidConvoSystemMessages`. That flag defaults to false in pi-ai, and then the system messages are
  folded into the head (`collapseSystemMessages`), so the whole prefix changes once a day for every running session.
- **A `Current date:` prefix written into each user message at submit.** Cache-safe, but it rewrites the user's own
  text in the stored transcript (session API, console), breaks the scripted test model that reads the message as JSON,
  and misses user messages Pi Durable writes itself.

## Decision

The `current-date` extension (`packages/orchestrator/src/current-date.ts`) has one `beforeRequest` generation hook. For
every request it puts a text block `<current_date>YYYY-MM-DD (UTC)</current_date>` in front of each user message, with
the date taken from that message's stored `timestamp` (set by Pi Durable when it admits the input).

- **Per request, never stored.** The transcript keeps the user's text; the session API and the console show it as sent.
- **Cache-safe.** The block is a pure function of stored messages, so every request of a conversation sends the same
  bytes for the same message; nothing reads the clock. A new message adds its own date at the end, where the prefix
  already changes.
- **Every input.** Messages, steers, follow-ups and the user messages Pi Durable adds (continuations) all have a
  timestamp. A message without a usable one is left as it is.
- **UTC, date only.** A time would differ for every message for no gain; the date can be a day off for a user near
  midnight in their zone. The sandbox facts (ADR 0049) say where the date is and that `date` gives the exact time,
  which covers a long run that crosses midnight after its last message.
- **Installed in the pinned host default** `settings.extensions` (`[coding, fit-images, current-date]`, and `trim-context` since [0067](0067-trim-context.md), `model-calls` since issue #497), which Pi Durable
  reads at every start, so conversations created before this change get it too (ADR 0055). It has no tools, so nothing
  offered changes.
- The scripted test model skips the block when it reads a script (`model.ts`, `isDateBlock`).

## Consequences

- About 15 tokens per user message.
- Existing conversations miss the provider cache once, at their first request after the upgrade: every earlier user
  message gains its block then.
- Conversations created before this change keep their stored instructions, so they get the date but not the sandbox
  line about it; a repo session with `repoSkills` or `repoContext` gets the line at its next rescan.
- `test/current-date.test.ts` pins that the model sees the block and the stored transcript does not.
