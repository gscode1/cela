# Desktop web agent: status and handover (25 Nov 2026)

State at the end of the 25 Nov work on the desktop web agent (`desktop-web` in the desktop sandbox image, skill
`desktop-sandbox`). The benchmark and test scripts used here were session-local and are not in the repo; this note
keeps their results and the decisions taken from them.

## State

- cela-dev runs main at 9861d18: desktop profile v24, skill `desktop-sandbox` v22.
- The local desktop suite passes (381 checks). It runs nightly in CI (`.github/workflows/desktop-suite.yml`, about
  14 min) and on any PR labelled `desktop-suite`.

## Merged on 25 Nov

| PR | Issue | What |
|---|---|---|
| #490 | #485, #486 | Dialog buttons listed first past the cap of 8; `type` prefers the open modal's field |
| #492 | #487, #488 | A cold start resumes across a killed `open` (detached launch, exit 75 after 45 s); narrower empty-page notice |
| #491 | #489 | CI workflow for the desktop suite |
| #494 | #493 | Skill trimmed from 16.8 KB to 8.4 KB; `desktop-web help [cmd]` and `<cmd> --help` |
| #498 | #495 | After `type`: `appeared:` controls with refs, short new lines folded into one; "drew it again" only on the same URL; a `--near` miss lists the matches with refs (exit 1) |
| #499 | #496 | Chrome error pages: the notice names `net::ERR_…`, `open` exits 1, click and type are refused (certificate interstitials too); `--table` reads TD/TH under TR whatever the display |
| #500 | #497 | A `model-call` JSON log line per provider response; `usage` on streamed assistant messages ([metrics.md](../metrics.md)) |
| #502 | #501 | The skill's `--marks` line restored; the trim had doubled the calls on a star-rating task |

## Scored benchmark

Ten real-site tasks, scored by fixed checks (no LLM judge), at most 3 sessions in parallel, 3 runs per task. Amazon is
excluded from the totals: the site serves its own error page through the proxy on every run.

| Baseline | Build | Passed | Median calls | Total cost |
|---|---|---|---|---|
| b22 | desktop profile v22 | 25/27 | 18 | $2.33 |
| b23 | profile v23 (#494), skill v21 | 27/27 | 19 | $2.07 |
| b24 | profile v24 (9861d18), skill v22 | 26/27 | 16 | $1.89 |

- The books task (star ratings) is back to 10–12 calls and $0.041 a run, from 20 calls and $0.102 in b23.
- The one b24 failure (wizzwaw run 2) is a scorer false negative. The answer was correct, but the screenshot was taken
  with `desktop-web shot` and copied to the deliverable path, while the check accepts only a direct `desktop-shot`.
  Low-priority fix: let the scorer accept the copy, or add `--out` to `desktop-web shot`.
- Allegro's calls stay high because the task's start URL `%20` loads as a "+" search on the site (the tool keeps
  `%20`).

Hard tests round 5 on unseen sites (gov.uk, timeanddate, PyPI, MDN, Kiwi, PKP, OSM): 9/9 correct.

## Prompt cache: misses are on the provider's side

About 40% of the benchmark's model cost is prompt prefix billed again as uncached input. The median of uncached
input over final prompt is about 2.0; a fully cached run would be about 1.06.

- Running sessions serially does not help: median 1.97 serial against 2.05 in parallel.
- A byte-identical prompt sent 3 s after the previous call still missed fully, with one session on the cluster.
- Per-call telemetry (#500, 4 serial sessions): on a miss the provider reads back an older cached prefix, whose size
  matches an earlier call's prompt; the next call then hits in full. `trimMoved` was false on every call, so cela's
  prefix does not change mid-run. Gap length does not predict a miss (misses at 0.3–21 s, hits after 71 s).
- The orchestrator uses only the SSE transport (`withFetch` in `packages/orchestrator/src/onecli.ts`).

**Decision: the WebSocket transport is deferred.** It is the one untested lever (a pinned connection with
`previous_response_id`, as the Codex CLI uses), worth about $0.03 of the $0.07 per task. It is unproven to fix the
misses, specific to one provider, and saves cents at proof-of-concept volume. Revisit when traffic makes the model
bill matter or latency hurts. First step then: a time-boxed check, with no deploy, that WebSocket upgrades work
through the OneCLI gateway with the credential swap. Only if that passes: a `PI_CODEX_TRANSPORT=auto|sse` setting
(default `sse`), a serial A/B, and an ADR if adopted.

## Decisions

- Prefer tool output at the point of need over skill text: every skill change resets the prompt cache.
- Not doing: detecting cookie banners that are not dialogs (needs wording or bar scanning), reporting that a form
  reloaded, inferring captions for `--near`.
- desktop-web stays in this repo. If it grows a second consumer, first make it a package (`packages/desktop-web`,
  with `/workspace` configurable), then split it out.
- Observability: never log page text, typed text, full URLs, regex arguments or tokens. No OTel and no
  high-cardinality labels.

## Open items

- Fewer calls per task: this has paid more than caching so far.
- Observability: a desktop-web action log with an enum of notices, a run-outcome enum when a session settles, and the
  scored benchmark nightly in CI.
- Hard tests round 7 on unseen sites.
- The benchmark's releases check goes stale when agent-sandbox ships a version newer than v1.0.12.
- #463 (MCP Tasks) waits on the TS SDK.
