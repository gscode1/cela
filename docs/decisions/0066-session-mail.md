# 0066: Session mail: a credentialed MCP server that scopes inboxes by an owner header

Status: proposed, 2026-11-23 (issue #420). Gated on issue #419: nothing below is accepted until a smoke test proves that the
OneCLI gateway forwards a custom request header unchanged and holds a response of 120 s or more. Builds on
[0040](0040-mcp-egress-flow.md) (per-session MCP identity), [0041](0041-browser-sandbox.md) (the browser flavour holds no
credential; amended here) and [0038](0038-network-modes.md) (direct mode). Research:
[docs/research/agent-session-emails.md](../research/agent-session-emails.md), variant 8d with the review of 8d. The wire
contract is [docs/session-mail.md](../session-mail.md).

## Context

An agent that signs up for a service (a browser session, typically) needs an inbox of its own to receive a code or a link.
Mail for one session must never be readable by another, and a prompt-injected model must not be able to choose whose inbox it
reads. All sessions share one catalog row and one `onecliSecret` per MCP server, so the server cannot tell sessions apart by
credential (ADR 0040, section 4). The browser flavour, where this matters most, may not hold a credentialed server (ADR 0041).

## Decision

1. **A session mail server is an ordinary credentialed catalog MCP server.** One operator `onecliSecret`, discovery, grants,
   egress rules and the orphan sweep stay as they are. cela only knows a contract (docs/session-mail.md): the operator secret,
   an owner header and four tools. A Cloudflare Email Worker is one possible backend; it is not part of cela, and any server
   that serves the contract works.
2. **Off by default, named by a deployment setting.** `PI_SESSION_MAIL_SERVER` (chart `sessionMail.server`, read by the
   orchestrator and ingest) holds the reserved catalog name. Unset: no server is special, no header is sent, no profile has an
   exception. A setting rather than a constant, because a deleted catalog name can never be created again.
3. **The owner header.** In `McpAccess.forConversation`, and only when the server is the configured one, the returned `fetch` sets
   `X-Cela-Mail-Owner: <the session's MCP agent identifier>` (`<prefix><session id>-m`) on every request, overwriting any
   value. The model cannot set headers, and the sandbox never holds the `mcp-catalog` rules. Discovery sends no header: the
   server may list its tools for it but never serve mail. No HMAC key is needed in cela: the operator secret authenticates the
   caller, the header only says whose inbox. The server derives the address as `HMAC(server-only key, owner)`, so knowing a
   session id does not give its address.
4. **The browser exception (amends 0041).** A browser profile may name the configured server although it is credentialed
   (`untrustedFlavourConflict`, the catalog-side `credentialedRefusal`, `McpAccess.credentialedFor`). `directModeConflict` is
   unchanged: `networkMode: direct` and the desktop flavour keep refusing it. A `route=onecli` egress rule stays forbidden for
   browser, and so does a repo. The sandbox still never holds the credential: the orchestrator calls the server through the
   gateway as the session's own agent.

## Consequences

- Sessions never reach other sessions' mail through cela. Isolation between inboxes rests on the orchestrator setting the header
  and on the server filtering every query by it; it does not rest on OneCLI grants. The operator secret is fleet-wide
  authority: whoever holds it can claim any owner, so a compromise of it breaks isolation. Keep it out of every other place.
- Every credentialed server of a session still sees the same gateway agent; only the mail server also gets a stable session
  identifier (the agent name) in a header. Other servers get no correlator.
- The exception trusts whatever URL and secret an admin registers under the reserved name. The ADR does not pin the host; an
  operator who wants that pins it in OneCLI (the secret's host pattern is already checked against the server's URL by
  `McpAccess`).
- A prompt-injected browser agent can still read and leak its own session's mail while it runs (the profile is open-web). The
  server must extract codes and links in code where it can, fence message bodies as untrusted, and expire inboxes.
- `wait_for_email` holds a request open for up to 120 s: the catalog row needs `timeoutMs` of at least 150000 (default 60000).
  A call in flight keeps the sandbox from idle-suspending, which matters because browser state lives only in the Pod.
- Terms of service of the services an agent signs up to, throwaway-only accounts, receive-only first and waking idle sessions by
  mail (MCP Events) are not decided here (research, "Decisions needed").

## Verification

- Unit tests (orchestrator `mcp-access.test.ts`, session-core `session-mail.test.ts`, ingest `sandbox-flavour.test.ts`): a
  browser session's `credentialedFor` returns at most the mail server, a direct or desktop one none, and with the setting unset
  a browser one none; the header is present only on the mail server's session requests, overwritten and never appended, and
  absent on discovery and on other servers; a browser profile naming the server is accepted only when it is configured; a
  direct or desktop profile naming it is refused.
- Before this ADR is accepted: issue #419's gateway smoke (header unchanged, 120 s response held), and an e2e of the contract
  against a real backend.
