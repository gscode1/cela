# 0071: MCP `get_transcript` reads the session stream; it adds no API route

Status: accepted, 2026-11-27 (issue #521). Relates to [0031](0031-mcp-adapter.md) (the adapter) and to the streaming
section of [session-api.md](../session-api.md#streaming).

## Context

An MCP client sees an agent's text through `wait`, its status through `get_session` and the feed through
`list_events`. While an agent runs a long chain of tool calls the client sees nothing of them: which searches it ran, with
which arguments, what came back, which call failed. The transcript has all of it (`calls`, tool results with `isError`,
`usage` per answer), and `GET /sessions/{id}/stream` already sends every committed entry.

The session API has no JSON route that reads the transcript. The orchestrator can read entries after an id
(`Conversation.entries()`, used to fill the gap of a stream that reconnects), but only inside `serveStream`.

## Decision

- **A new MCP tool, `get_transcript { sessionId, cursor?, limit?, kinds? }`, reads one page from the stream. No route, no
  storage.** It opens `GET /sessions/{id}/stream` with `Last-Event-ID: <cursor>` and reads `entry` events until the page
  is full or the first `live` event arrives. The orchestrator sends `live` right after the replay of the entries after the
  cursor, so it means "caught up". Then the connection is closed. Ingest authenticates the token and checks the session
  owner on this stream already, so the tool has the ownership of `wait` and nothing to add: another owner's session is a
  `404`, a deleted one `410`, an orchestrator that is down `503` with `Retry-After`.
- **Why not a paged JSON route in ingest.** It would be a new route in two services (ingest and the orchestrator that owns
  the Pi Durable schema of the shard), a new contract in `session-api.md` and a second path to the same data, to give one
  client a poll where it already has a resumable cursor. The adapter reads this stream for `wait` already, with the same
  cursor. If other clients need a plain read (the console, scripts), the route can be added later and the tool switched to
  it without changing its result.
- **The cursor is the id of the last entry read**, as in `wait`, including entries a `kinds` filter dropped, so the next
  call does not read them again. `hasMore` is true when the page stopped before the replay caught up (limit, size cap, the
  500-entry scan cap per call, or a stream that ended) and false when the next entry would be a new one. A page that ends
  exactly at the end of the transcript says `hasMore: false` (the read looks at the next event before it answers). Entries
  are sent once and in order, so a client that follows `cursor` sees every entry exactly once.
- **Entries as the stream sends them, with the calls split.** `{ id, kind, messages }`; a message is `{ role, text, calls?,
  isError?, usage? }`, with `calls` as `{ name, arguments }` (the orchestrator writes a call as `name(<JSON>)`; the
  arguments stay the JSON text). A tool result is its own entry with role `toolResult`, after the entry of the call, in
  call order; the stream carries no call id to join them, so none is invented.
- **Per-field and per-response caps.** `text` and `arguments` are cut at 4 KiB of UTF-8 (never inside a character), with
  `truncated: true` and `length`, the original size in bytes. The entries of one response are at most 24 KiB, as the text
  of `wait`; an entry that would pass it starts the next page. An entry that alone does not fit at 4 KiB is shown at 1 KiB,
  256 B and 64 B per field; one that still does not fit is `{ id, kind, messages: [], omitted: true, length }`, so the
  cursor always moves on.
- **`kinds` keeps entries that have any of `user`, `assistant`, `call` (an assistant message with tool calls), `result`
  (tool output) and `error` (a tool result with `isError`).** `["call", "error"]` is the compact view. These are tags of
  the tool, not Pi Durable's entry `kind` (`pi.user`, `pi.assistant`, `pi.tool-result`), which stays in each entry.
- **Everything in an entry is untrusted**: the tool's note and description say so, and the note names `arguments`.
- **No admin variant.** An operator who needs another owner's transcript has the console and the orchestrator logs; the
  session API has no admin route to the stream.

## Consequences

- The result of one call is bounded in size and in time (a read ends after 20 s; the caller continues from `cursor`).
- A `live` event that never comes (a bug in the server) would end the read at the timeout with `hasMore: true`.
- A transcript is read from the start for a client without a cursor: `limit` bounds the page, not the work of the replay,
  which the orchestrator does by pages of 100 entries.
