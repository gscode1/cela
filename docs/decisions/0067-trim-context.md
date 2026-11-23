# 0067: Trim old screenshots and large tool output from requests

Status: accepted, 2026-11-23. Follows [0055](0055-fit-images.md) and [0061](0061-current-date.md) (extensions in the
pinned host default). Closes gscode1/cela#424. Amended by gscode1/cela#426: the 8-turn schedule is replaced by a gate on prompt size and savings.

## Context

A measured desktop task: 29 tool calls, 430k tokens, about 94% of them cache reads. Every turn re-reads the whole
history, so what is dead weight after a few turns is paid for on every later turn: screenshots read back with `read`
(image content in tool results, about 500 to 1,100 tokens each, 12 in that run) and large text results (snapshots, page
dumps). Pi compacts only near the context window, which this run never reached.

A first version trimmed on a schedule (the boundary moved every 8 assistant turns). Replaying a stored 30-request
desktop run on `openai-codex` (OpenAI Responses) showed that this costs more than it saves: the run cost $0.27 instead of
$0.11. After each step the provider credited none of the unchanged prefix: `cacheRead` fell to about 1.4k tokens (the size
of the earliest whole prompts) although the first 9 to 12k tokens were unchanged, and the request two after a step missed
again. In that data OpenAI matched whole earlier prompts (in 128-token rounding), not the longest common prefix. The
records price input at $2/M and cache reads at $0.10/M (0.05x).

**Cost model.** Let `P` be the prompt tokens after a trim, `E` the tokens it removed and `R` the requests remaining. A
rewrite pays about `0.95 * P` input-equivalents once (the whole prompt is read as new input instead of from the cache,
less the 0.05 it would have cost), and saves `0.05 * E` per later request. It pays only if `E * R > 19 * P`, and
`E * R > 38 * P` when a second request misses too. In the measured run `E` was 1 to 8k with `P` 12 to 16k: never worth
it. A trim is therefore a context-window tool (keep a long run under the model's limit), not a cost tool.

## Decision

The `trim-context` extension (`packages/orchestrator/src/trim-context.ts`) has one `beforeRequest` generation hook that
returns a trimmed copy of `messages` for that request only. Pi Durable uses the result "for that request only": the
stored transcript, the events and what the session API shows are unchanged (`test/trim-context.test.ts` runs a harness
and compares what the model was sent with `root.context()`).

**Per profile.** The profile field `contextTrim` (`off`, `images` or `full`, validated at write like `sandboxFlavour`;
admin API, MCP admin tool, console editor, `docs/session-api.md`) chooses the rules for its sessions: `images` applies
rule 1 only, `full` rules 1 and 2, `off` none. Absent, the default is `images` for every flavour: `full` also elides text a coding agent needs for `edit`, and under the
gate trimming is a context-window tool, so `full` is opt-in per profile. The extension reads the
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
   results of `T` characters or fewer, and the newest `K_turns = 3` assistant turns (with their results).

**The gate.** Nothing is trimmed until the prompt is large and most of it can go. The prompt size is exact, from the
provider: `usage.input + usage.cacheRead + usage.cacheWrite` of an assistant message, which Pi Durable stores with the
message and passes in `beforeRequest`'s `messages` (a test checks it in a harness). A request may trim only when
`prompt >= minPrompt` (default 100,000 tokens) and the tokens the trim removes are at least `minRatio * prompt` (default
0.5). Removed tokens are estimated: characters removed / 4, plus 1,000 per elided image (`TOKEN_ESTIMATE`). When the gate
opens, everything eligible is trimmed at once: the boundary jumps to the newest eligible point (everything before the
oldest of the newest `K_turns` assistant turns), with the last `K_img` images among the eligible kept.

**Purity and cache stability.** The boundary is a pure function of `messages` (no state, clock or randomness), derived by
replaying the conversation oldest request to newest, starting with no boundary. For the request that carries `k`
assistant messages, the last prompt is the usage of the `k`-th and the candidate boundary is what was eligible then. If
the last prompt is at least `minPrompt` and moving to the candidate would remove at least `minRatio * prompt` more than
the current boundary already removes, the boundary moves there; otherwise it stays. Replaying a prefix of the history
gives the same boundary for that prefix, so between two jumps the trimmed prefix is byte-identical request after request
and the provider's cache can hold; the request at a jump is the one that rewrites it. After a jump the recorded prompts
are the trimmed size, so the gate does not fire again until the prompt has grown back over `minPrompt` with enough to
remove again ("re-arm when back above"). An assistant message without usage never opens the gate. Trimming trimmed
messages changes nothing.

The "providers cache the longest unchanged prefix" assumption of the first version was wrong for OpenAI in our data (see
Context). Explicit-breakpoint caches such as Anthropic's behave differently and may keep the unchanged part, but the
gate does not depend on that: it assumes the worst case, a whole-prompt miss per trim.

- **Captions.** The desktop and browser sandbox skills tell the agent to write one line after reading a screenshot (what matters on it); that line stays in the transcript when the image is elided, which is why the stub says "your note after it".
- Deviation worth knowing: "the last two image results" is taken among the eligible messages, not the whole history.
  Taking it over the whole history would make a kept image become elided between two jumps, as newer images arrive,
  and break the prefix. The cost is that up to two older screenshots stay until the next jump.
- Conversations whose prompt stays under `minPrompt` (the common case) are sent whole.
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
| `PI_TRIM_CONTEXT_MIN_PROMPT` | `100000` | `minPrompt` in tokens, 1,000 or more                                      |
| `PI_TRIM_CONTEXT_MIN_RATIO`  | `0.5`   | `minRatio`, above 0 and at most 1                                          |

## Consequences

- Input tokens and cache reads of long image-heavy sessions drop; the model sees a stub where an old screenshot or dump
  was, and can read or rerun again.
- Existing conversations miss the provider cache once, at their first request after the upgrade, and once per trim (rare: only above `minPrompt`).
- Runs that stay under 100k tokens, like the measured one, are never changed and cost what they cost without trimming.
- The session API, console and stored events still show the full results.

## Not done

- Summarising what is elided (the stub only says it was elided).
- Thresholds per model or per context window (`minPrompt` is one number for all).
- Pi's own compaction settings (an earlier threshold would summarise, and rewrites the stored transcript).
- Trimming user-supplied images, assistant text or thinking.
