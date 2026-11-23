# 0067: Trim old screenshots and large tool output from requests

Status: accepted, 2026-11-23. Follows [0055](0055-fit-images.md) and [0061](0061-current-date.md) (extensions in the
pinned host default). Closes gscode1/cela#424.

## Context

A measured desktop task: 29 tool calls, 430k tokens, about 94% of them cache reads. Every turn re-reads the whole
history, so what is dead weight after a few turns is paid for on every later turn: screenshots read back with `read`
(image content in tool results, about 500 to 1,100 tokens each, 12 in that run) and large text results (snapshots, page
dumps). Pi compacts only near the context window, which this run never reached.

## Decision

The `trim-context` extension (`packages/orchestrator/src/trim-context.ts`) has one `beforeRequest` generation hook that
returns a trimmed copy of `messages` for that request only. Pi Durable uses the result "for that request only": the
stored transcript, the events and what the session API shows are unchanged (`test/trim-context.test.ts` runs a harness
and compares what the model was sent with `root.context()`).

**Per profile.** The profile field `contextTrim` (`off`, `images` or `full`, validated at write like `sandboxFlavour`;
admin API, MCP admin tool, console editor, `docs/session-api.md`) chooses the rules for its sessions: `images` applies
rule 1 only, `full` rules 1 and 2, `off` none. Absent, the default is `full` for the `browser` and `desktop` flavours and
`images` for `default`: a coding agent keeps its old file reads and diffs, which `edit` needs. The extension reads the
mode of a conversation at its first request (conversation, then session row: profile snapshot, else the flavour's
default) and keeps it for the life of the process, because the snapshot and flavour are fixed per session and a mode
that changed would rewrite the cached prefix. A lookup that fails sends that request whole and is asked again.
`PI_TRIM_CONTEXT=0` is a deployment kill switch over every profile. The trim function itself stays pure:
`(messages, mode, constants)`.

Rules, with their constants (`TRIM_CONTEXT_DEFAULTS`):

1. **Images.** In the eligible tool results (below), the images of the last `K_img = 2` results that hold images stay;
   every other image becomes a text part `[image elided to save context: <path>; your note after it says what it showed; read it again if needed]`. `<path>` is
   the `path` (or `file_path`) argument of the tool call the result answers, else `earlier screenshot`.
2. **Large text.** An eligible tool result whose text is longer than `T = 4000` characters becomes its first 600
   characters plus `\n[... N chars elided to save context; rerun the command or re-read the file if needed]`. A result
   is never made longer, so an elided one stays as it is.
3. **Never touched:** system prompt, user messages, assistant messages (tool call arguments included), error and other
   results of `T` characters or fewer, and the newest `K_turns = 3` assistant turns.

**Cache steps.** Providers cache the longest unchanged prefix, so a boundary that moves every turn would rewrite the
prefix every turn and lose the cache. The eligible messages are those before the assistant turn number
`S = floor((A - K_turns) / B) * B`, with `A` the number of assistant messages and `B = 8`: they depend on `A` only
through `S`, and `S` is at most `A - K_turns`, so the newest turns are always out. Between two steps the trimmed prefix
is byte-identical request to request; at a step, up to 8 more turns of results are elided at once and the cache is
rewritten once. The function is pure (messages and constants in, messages out; no clock, no randomness), and trimming
trimmed messages changes nothing.

- **Captions.** The desktop and browser sandbox skills tell the agent to write one line after reading a screenshot (what matters on it); that line stays in the transcript when the image is elided, which is why the stub says "your note after it".
- Deviation worth knowing: "the last two image results" is taken among the eligible messages, not the whole history.
  Taking it over the whole history would make a kept image become elided in the middle of a step, as newer images
  arrive, and break the prefix. The cost is that up to two older screenshots stay until the next step.
- The first elision happens at the 11th assistant turn (`K_turns + B`); shorter conversations are sent whole.
- Image stubs are not counted as text, so a result with both is judged on its own text.

**Install.** Like `fit-images` and `current-date`: `registry.install` and the pinned host default `settings.extensions`
(`[coding, fit-images, current-date, trim-context]`), which Pi Durable reads at every start. Conversations created
before this change get it at their next start with nothing written to their `pi.agent`, and conversations created from a
profile (whose `{ add }` edits that default) get it too. All flavours (default, browser, desktop) have it. It has no
tools, so nothing offered changes. It is listed in `capabilities().extensions`.

**Configure** (orchestrator environment; errors fail the start):

| Variable                     | Default | Meaning                                                                    |
| ---------------------------- | ------- | -------------------------------------------------------------------------- |
| `PI_TRIM_CONTEXT`            | `1`     | `0` turns it off for every profile: not installed, not in the default, not in capabilities   |
| `PI_TRIM_CONTEXT_IMAGES`     | `2`     | `K_img`, 0 to 100                                                          |
| `PI_TRIM_CONTEXT_TEXT_CHARS` | `4000`  | `T`, 1,000 or more (above the 600 characters an elided text keeps)         |
| `PI_TRIM_CONTEXT_TURNS`      | `3`     | `K_turns`, 1 to 1000                                                       |
| `PI_TRIM_CONTEXT_STEP`       | `8`     | `B`, 1 to 1000                                                             |

## Consequences

- Input tokens and cache reads of long image-heavy sessions drop; the model sees a stub where an old screenshot or dump
  was, and can read or rerun again.
- Existing conversations miss the provider cache once, at their first request after the upgrade, and once per step.
- The session API, console and stored events still show the full results.

## Not done

- Summarising what is elided (the stub only says it was elided).
- Thresholds per model or per context window.
- Pi's own compaction settings (an earlier threshold would summarise, and rewrites the stored transcript).
- Trimming user-supplied images, assistant text or thinking.
