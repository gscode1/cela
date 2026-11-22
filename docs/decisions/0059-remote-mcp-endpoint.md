# 0059: A remote MCP endpoint on the cluster, with MCP Events once the SDK ships them

Status: proposed, 2026-11-22 (issue #336 for the endpoint, issue #366 for this design). Nothing is built. Builds on
[0031](0031-mcp-adapter.md), [0050](0050-mcp-admin-mode.md), [0026](0026-ingest-routes.md) and
[0058](0058-input-outcome-and-owner-feed.md).

## Context

The MCP adapter (`packages/mcp`) speaks stdio only. It runs where the client runs, with the user's token in the client's
config. Clients that take only remote MCP servers (claude.ai and Claude Desktop custom connectors, mobile) cannot use
cela (#336).

MCP Events (extension `io.modelcontextprotocol/events`, SEP-3415 Final, extension Beta, protocol `2026-07-28`) let a
server publish typed event sources that a client polls (`events/poll`), streams (`events/stream`, SSE on streamable HTTP,
notifications on stdio) or receives by webhook (`events/subscribe`), each with a resumable cursor. The spec says to use
Tasks, not Events, to wait on an operation the client started.

Support on 2026-11-22: the TypeScript SDK's Events support is a draft (typescript-sdk PR #3209, `ext/events` subpaths,
experimental); the conformance suites are drafts (conformance PR #521 for servers, #541 for clients, stacked on it); the
extension client matrix has no Events entry; the pinned SDK 2.4.0 has none.

## Decision

### 1. The endpoint

- **A Deployment of its own** (`cela-mcp`), the same `packages/mcp` code with a streamable-HTTP transport beside stdio.
  Not a route of ingest: ingest stays the session API, and the MCP server stays only its client (0031). Its NetworkPolicy
  admits the gateway in and lets it reach ingest only.
- **Per-caller auth, no token in the server's environment.** Each MCP request's bearer is passed to ingest on that
  request's calls; ingest authenticates and owner-checks as for any client. The server stores no token, keeps no session
  map keyed by token, and scrubs the caller's token from every result and log line as the stdio adapter does. OAuth for
  remote connectors (protected-resource metadata, an authorization server) follows the session API's OIDC verifier and
  is a separate step: until then the endpoint serves clients that can send a static bearer.
- **Admin tools off** on the remote endpoint. 0050's two-token model does not fit one caller token; per-caller admin
  tools would need ingest's admin list behind the same token, which is a later decision.
- **The session cap moves to ingest.** A per-process cap (`PI_MCP_MAX_SESSIONS`) bounds nothing when many callers share
  the process. The remote endpoint needs a per-owner live-session quota enforced atomically in ingest (the same
  mechanism the triggers of [0060](0060-mcp-event-triggers.md) use); the stdio cap stays as a local guard.
- **Route.** An HTTPRoute rule for the MCP path with no total request timeout (SSE, as the session stream in 0026) and
  HTTP/2 to the gateway, since a client may hold several streams.

### 2. Events on the endpoint (and on stdio)

**Gate.** Build when the TypeScript SDK ships Events (PR #3209 merged and released) and the conformance suites
(#521, #541) pass against it, then pin that SDK on purpose. No hand-written `events/*` JSON-RPC before that: it would be
replaced, and it bypasses the pinned SDK.

**Event types**, all owner-scoped, each a projection of feed rows (0058):

| Event | Feed rows | Value |
|---|---|---|
| `session.park` | `park.opened`, `park.closed` ([0054](0054-signals-parking-and-approval-gates.md)) | Medium: a session waits for a person. A caller watching its own `run_task` learns this through Tasks (`input_required`) instead. |
| `session.failed` | `session.status` with `failed` | Medium: sessions the caller no longer watches. |
| `session.input_settled` | `input.settled` | Low: observers only (another agent, a dashboard). The caller of its own task uses Tasks. |

Arguments filter by `sessionId` (optional). Payloads are the feed's minimal hints; the client reads details with
`get_session` or the event route. Payloads are untrusted output, as every adapter result.

**Delivery.**

- **Poll**: `events/poll` maps onto `GET /events?cursor=` with the caller's bearer. The MCP cursor is the feed cursor;
  `cursor: null` maps to `cursor=latest`; `truncated` passes through; `nextPollMs` defaults to 5 s.
- **Push**: `events/stream` reads `GET /events/stream` and re-emits each row as `notifications/events/event`, the feed's
  heartbeat as `notifications/events/heartbeat` (data frames). Authorization is checked at subscribe and again on every
  delivery: the upstream stream is reopened with the caller's token at least every 5 minutes, so a revoked token stops
  delivery within that bound. On stdio the same events go out as notifications.
- **Webhook: not offered.** `events/subscribe` would make the cluster POST to a URL a client or a model supplies: an
  SSRF and exfiltration path out of the cluster. `events/list` advertises `delivery: ["poll", "push"]` only.

## Consequences

- claude.ai and other remote-only clients can use cela once the endpoint ships; Events add nothing until a client
  consumes them, and cost only the projection, since the feed already exists.
- The per-owner quota in ingest is a prerequisite shared with 0060.
- Open: OAuth for remote connectors; per-caller admin tools.
