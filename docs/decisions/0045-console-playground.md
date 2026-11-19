# 0045: Console playground

Status: accepted, 2026-11-19 (issue #293).

## Context

An operator who registers an MCP server or edits a profile could only find out whether it works by starting a session
from another client. The console is where the change is made, so it should be where it is tried. The session API
already has everything needed; the question is how the console uses it without a new endpoint or a new way to leave
sandboxes running.

## Decision

- **Console only, no backend change.** The Playground page (`/console/playground`) calls `POST /sessions`,
  `POST /sessions/{id}/events` (`message`, `cancel`), `GET /sessions/{id}/stream`, `GET /sessions/{id}` and
  `DELETE /sessions/{id}`. The session is owned by the owner of the console's bearer token, like any client's, so it
  needs no cross-owner access. The page is admin-only because the whole console is (its sign-in calls `/admin/settings`).
- **The stream is read with `fetch`**, not `EventSource`, which cannot send the `Authorization` header and would force
  the token into a URL or a cookie. The console parses the SSE framing itself, keeps the last entry id and reconnects
  with `Last-Event-ID` with a capped backoff; a `404` or `410` ends it for good. The token still lives only in the
  page's memory.
- **Model and tool output is rendered as text.** No Markdown and no HTML from the model or a tool, so a result cannot
  inject markup into an admin page.
- **A session must not outlive the page unnoticed.** The page says that a session starts a real sandbox and spends
  tokens; it warns on `beforeunload`, sends a `keepalive` `DELETE` on `pagehide`, and ends the session when the operator
  navigates elsewhere in the console. The API has no list call, so the browser remembers the ids of its sessions (not
  secrets, in `localStorage`) and lists those still open with an End button, checking each against
  `GET /sessions/{id}`. A tab that crashes or a lost network still leaves a session to the usual idle suspend and
  sweep ([ADR 0004](0004-idle-suspend.md), [ADR 0002](0002-orphan-sweep.md)); listing it later is the backstop.
- **"Try in playground" on the MCP servers screen** links to `?mcp=<server>`; the playground picks the first profile open
  to new sessions that names it (or the default), and says so when the server is disabled in the catalog.

## Consequences

- A listing of all of an owner's sessions would make "still open" exact across browsers; it needs an API change and is
  left out until the session operations scope of the [plan](../admin-ui-plan.md) is designed.
- The page cannot show a tool's result before the turn commits it: the stream reports committed entries, and for a
  call in progress only `live.tools` (name and status).
