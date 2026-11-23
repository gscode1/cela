# Agent session emails: research and evaluation

Status: research, 2026-11-23. Not a decision; an ADR is needed before building (see "Decisions needed").
Method: three research subagents (address routing, MCP Events, security), then two review rounds by two independent
reviewers each; every repo citation below was re-checked against the files.

## The idea

Agents get an email address to sign up for services (verification codes, magic links). Each session gets its own
alias, e.g. `agent+<sessionid>@mydomain.com`; mail for a session should reach that session's agent, maybe through MCP
Events. Open question: how does mail to `agent@` map to session abc123 and not xyz321?

## 1. Mapping: one derived address per session, keyed on the envelope recipient

- The key is the envelope recipient (SMTP `RCPT TO`), not the `To:` header (Bcc, lists and forwarding change it).
  Cloudflare Email Workers expose it as `message.to` and can refuse with `message.setReject()` (Cloudflare runtime API
  docs, verified).
- One address per session, local part derived by the orchestrator: `base32(HMAC(key, session_id))[:16]`. No
  address table to provision, and the orchestrator can always recompute a session's address. An HMAC cannot be checked
  without the session id, so the Worker cannot validate addresses by itself: it either stores mail by recipient and
  lets mail for unknown addresses expire unread, or rejects at the edge against a list of live addresses the
  orchestrator pushes (needed anyway to tombstone addresses of deleted sessions).
- Not `agent+<uuid>@`: some signup forms reject `+` (anecdotal: Netlify, WordPress; no quantified rate found), some
  store the address without the tag so the mail arrives unattributable, and the tag leaks the session UUID.
- Use a dedicated apex domain (decided 2026-11-23: one is available). Cloudflare catch-all works on the apex only; a subdomain needs one literal rule per
  address, at most 200 per domain (Cloudflare Email Routing subdomain and limits docs, verified). It also isolates
  sending reputation and blocklisting from the main domain. Inbound routing is free and unlimited; the Worker bills as
  Workers; 25 MiB per message (Cloudflare pricing and limits pages, verified).
- Never reuse an address. Unmatched mail is quarantined, never guessed onto a session by sender. `In-Reply-To`
  matching matters only once agents send mail.

## 2. Scoping: the model never chooses the address

All sessions share one credential per MCP server: a session's OneCLI agent `<prefix><uuid>-m` is granted the catalog's
single `onecliSecret` (`docs/decisions/0040-mcp-egress-flow.md:105-110`). A catalog mail server therefore cannot tell
sessions apart, and if the address were a tool argument an injected prompt could read another session's inbox (the
address is no secret: it is typed into third-party forms).

So the mail tools are **orchestrator-side tools** that insert the session's own derived address themselves. The
orchestrator holds the one mail-service credential and reaches the service through the OneCLI gateway (its only route
out, `docs/network-policy.md:56-59`). This is a new kind of built-in tool and a new orchestrator dependency: a design
change that needs an ADR (AGENT.md). The ADR must also settle whether this counts as a credential in a browser session,
which `0041:109-113` forbids for credentialed MCP servers and `route=onecli` rules; the sandbox never sees the
credential, but the question is the ADR's to answer, not this note's.

## 3. Delivery, first slice: a synchronous bounded wait, no Events

- `wait_for_email(timeoutSeconds ≤ 120)` blocks and polls the mail service, returning the extracted code or link (see
  section 5); the agent calls again if nothing came. A call in flight keeps the sandbox from idle-suspending
  (`0004:39-40`), which matters because browser state lives only in the Pod (`0041:142`, `0054:72`).
- Why not a parked tool (`0054`) or `wait_for_event` (`0060` §5): both are proposed, nothing built
  (`0054:2`, `0060:3`); 0054 park kinds are `login|approval|egress` only (`0054:35`), resolved by the owner
  (`0054:48`); a parked call is not in flight, so the sandbox suspends and the signup's browser state is lost
  (`0054:109-111`); 0060 §5 does not say who writes the `signal` row.
- Why not posting into the session: `POST /sessions/{id}/events` needs the owner's token (`session-api.md:253`), dedup
  is per owner (`:158`), ingest is the only session writer (`0060:57`), and a `message` to a busy session waits for the
  running turn to end (`:143-145`); `steer` joins after the current tool round (`:148`) but has the same writer problem.
- No inbound route into the cluster: the Worker stores mail (D1/R2) and the orchestrator pulls.
- The mail service is Events-shaped from day one: it implements `events/list` and `events/poll` (cursor, stable
  `eventId`, minimal `email.received { id, from, subject, receivedAt }` payload) next to its tools. The first slice's
  wait loop calls `events/poll` as plain JSON-RPC; when the orchestrator gets an Events client, only the client side
  changes. It also satisfies the "one server emits Events" half of 0060's build gate (`0060:93-95`), and lets
  Events-capable desktop clients use the same server.

## 4. Later: MCP Events, for waking an idle session

- MCP Events is real: `io.modelcontextprotocol/events`, SEP-3415 Final, extension Beta, needs protocol 2026-07-28,
  delivery modes poll, push (`events/stream`) and webhook (modelcontextprotocol.io Events overview, verified). Client
  matrix: only ChatGPT marked, Partial (webhook only); Claude rows blank in the fetched text (may be extraction loss).
  In cela the MCP client has no `events/*` and TS SDK support is draft PR #3209 (`0060:18-19`).
- Events only matter for unsolicited mail waking an idle session. ADR 0060 does not cover that: its `/fire` route
  creates a new session (`0060:57-61`), and triggerable profiles may not use `open-web` (`0060:37-40`), which the
  browser profile does (`0041:136-138`). That would be a new route and a new ADR, with 0060's controls (admin-fixed
  prompt, payload fenced and cut, rate caps, token budget), since every wake spends tokens on attacker-controlled input.

## 5. Security

1. **Untrusted mail plus open egress in one session** (the browser profile is `open-web`) is the "lethal trifecta".
   Codes and links are extracted by plain code, not the model; links are limited to the signup's domain; full bodies
   only on request, fenced as untrusted, HTML and hidden text stripped. EchoLeak (CVE-2025-32711) is the reference case.
2. **Sender trust ranks, never releases.** Services send from ESP domains and many DMARC policies are `p=none`.
   Compute auth at the edge, ignore inbound `Authentication-Results`. The expected domain passed to `wait_for_email`
   comes from the model, so it may rank mail but never lift quarantine.
3. **Receive-only first.** Sending later, on a separate domain, with caps.
4. **Terms of service are a product decision.** Gmail and GitHub forbid accounts created by automated means;
   disposable-email blocklists will catch the domain. Keep an audit log of accounts created; CAPTCHAs go to a human.
5. **Retention:** short; delete codes after use; no attachments into the sandbox by default.

## 6. Accounts: throwaway only

An agent that signs up types the password in the sandbox browser, so it lands in the transcript and the Pod, and
`0041:240` rules out persistent signed-in state. So agent-created accounts are throwaway: address and account die with
the session. Accounts worth keeping need a human to own the credentials (as 0054's login flow does) and an owner-level
address, which is a separate design.

## 7. Desktop agents and buy-vs-build

Desktop agents that are not cela sessions have no orchestrator: there the agent's own MCP client calls the mail
service directly (scoped by a per-install token), or uses AgentMail (inbox API, webhooks, WebSockets; free tier 3
inboxes, paid tiers unverified). For cela at one address per session: Cloudflare plus our own service (free inbound,
own domain, own custody).

## 8. Simpler alternative: a plain catalog MCP server with capability tokens

Instead of an orchestrator-side tool, the mail service is an ordinary catalog MCP server with no OneCLI secret:

- `request_email({ ttlHours? })` returns `{ address, inboxToken, expiresAt }`: a random address and a separate random
  secret. The address is public (typed into forms); the token is what grants reading.
- `wait_for_email({ inboxToken, timeoutSeconds ≤ 120, fromDomain? })`, `list_emails`, `read_email` take the token.

For: no cela code change (like 0057), allowed in browser profiles because the server is uncredentialed (0041 forbids
credentialed servers), one server for cela and desktop agents, several addresses per session, Events-shaped later.

Against: the token sits in the model's context and the transcript, so an injected instruction can leak it (the browser
profile has `open-web`) and the attacker can read that one inbox; no other session is exposed. The server is on the
internet, so inbox creation must be gated without a credential: a Cloudflare rule allowing only the cluster's egress
IP (desktop agents get a per-install key). Inboxes are not tied to session delete, so they expire by TTL and are
tombstoned.

### 8b. Same server, token injected by OneCLI (preferred)

The server authenticates by `Authorization: Bearer <token>` and derives the inbox from the token
(`address = base32(sha256(token))[:16]`), so its tools take no token: `get_email_address()`, `wait_for_email`,
`list_emails`, `read_email`. In cela the orchestrator mints a per-session OneCLI secret `<prefix><uuid>-mail` (host
pattern = the mail server) and grants it to the session's MCP agent `<prefix><uuid>-m`, following the existing
per-session `-git`/`-api` secrets (`0002:29`) and swept with them. The gateway injects it; the model never sees it.
Desktop agents put a per-install key in their MCP client config.

Cost: a small orchestrator change (mint, grant, sweep) and a narrow amendment to 0041, which today grants a browser
session no credentialed server (`0041:109-118`): allow a per-session secret that only reaches that session's own inbox.

Review (Fable, 2026-11-23, checked against the code): 8b is larger than first estimated. `onecliSecret !== null` decides
credentials in 17 production files (53 references), discovery would fail for a server with no catalog secret
(`mcp.ts:262`, `mcp-access.ts:115`), and the sweep's name patterns hardcode `(git|api)` (`onecli-names.ts:71`, `:79`).
Realistic size about 350-500 lines over 12-15 files. The secret must never rotate (it is the inbox).

### 8c. Operator secret plus a per-session header (simpler than 8b)

The mail server is an ordinary credentialed catalog server with one operator `onecliSecret`, so discovery, grants,
egress routes and the sweep stay as they are. For this one server the orchestrator's MCP transport adds a header
`X-Cela-Inbox: HMAC(key, sessionId)`; the Worker derives the address from it. The model cannot set headers; the
operator secret authenticates the caller, which also closes the inbox-creation hole (an IP allowlist does not: the
gateway likely shares the cluster's egress IP with the egress proxy, and browser sessions are `open-web`). Isolation
between sessions rests on the orchestrator, not on OneCLI grants. Still needs the 0041 browser exception, which must
keep refusing `direct` (`credentialSource` serves both, `network-mode.ts:47`).

In every variant a prompt-injected agent can still read and leak its own session's codes during the session (open
web); the variants differ only in what leaks after or outside it. Inboxes need a TTL in the Worker either way.

### 8d. No HMAC key: the session's existing MCP agent name as the header (simplest so far)

Review by Astra (2026-11-23, citations re-checked). The HMAC key in 8c only pseudonymises; the operator secret already
authenticates the caller. So the orchestrator sends the identity it already has: in `McpAccess`'s `stable` fetch
wrapper (`mcp-access.ts:184-187`) it sets `X-Cela-Agent: <prefix><uuid>-m` (the identifier `#ensure` already passes,
`:214-224`), overwriting any value. Generic, so no mail-specific branch in `mcp.ts` and no new key. The Worker requires
the operator credential, takes the header as the inbox owner (address = hash of it), and filters every lookup by owner,
`read_email(id)` included; address and owner are never tool arguments. Discovery runs under another identity and may
list tools but never read mail.

Size: about 40-80 production lines (the header, plus the browser exception in `mcp-access.ts:90-97`,
`sandbox-flavour.ts:30-38` and `mcp-servers.ts:433-452` for one reserved catalog name), 100-200 test lines; no
migration, no new secret, no sweep change. Catalog `timeoutMs` must exceed 120 s (default 60 s, `mcp-servers.ts:62`).
Costs: every credentialed server now sees a stable session identifier; the operator secret is fleet-wide authority
(compromise breaks isolation). Unverified: that the OneCLI gateway forwards the header unchanged.

Review of 8d (Opus and Fable, 2026-11-23, citations re-checked). Both: sound, the smallest variant, no path found for
an injected model to set the header or reach the Worker with the operator secret (sandboxes never get the
`mcp-catalog` set, `egress-mcp-rules.ts:16-18`; browser sessions have no OneCLI binding, `0041:117-119`; redirects
fail, `mcp.ts:84-90`). Changes to 8d:

1. **Prove the gateway forwards the header first.** Nothing in the repo shows it; the smoke driver only prints
   `x-smoke-*` echoes (`hack/egress-mcp-driver.mjs:142-145`). Extend `hack/egress-mcp-smoke.sh` to send a custom
   header to httpbingo and assert it arrives unchanged, and hold a response ≥ 120 s through the gateway. The Worker
   fails closed on a missing header.
2. **Send the header only to the mail server**, from `forConversation`, not discovery. The reserved-name check exists
   anyway for the browser exception, so this adds no new kind of special case; other servers get no session
   correlator; the Worker needs no knowledge of the prefix (no header: `initialize` and `tools/list` only). Merge via
   `new Headers(init?.headers)` and `.set`, since pi-mcp passes both `Headers` and plain objects.
3. **Worker:** owner from the header on every request (never `Mcp-Session-Id`), reject duplicated values, address =
   HMAC(Worker-only key, owner) so nobody who learns a session UUID can compute and target its address; every query
   scoped by owner; a host that serves only the Worker.
4. **Reserved name as a deployment setting**, not a constant: a deleted catalog name can never be recreated
   (`mcp-servers.ts:357`, `deletion.ts:57`). The ADR states that the exception trusts whatever URL and secret an
   admin sets under that name (or also pins the host by a chart value).
5. **Real size:** the exception touches `mcp-access.ts:92`, `credentialSource` (`network-mode.ts:47`, shared with
   direct mode, so a browser-only parameter), the `credentialedRefusal` SQL (`mcp-servers.ts:437-446`) and its fake
   (`test/fake-settings-db.ts`), a shared export; plus `hack/seed-browser-profile.mjs`, admin-ui copy, the 0041 smoke
   checks and docs (0041, 0040 §4, `network-policy.md`). About 60-100 production lines in cela; the Worker and e2e
   are extra.
6. Invariant tests: a browser session's `credentialedFor` returns at most the mail server, direct returns none; the
   header is overwritten, not appended; no other server receives it.

Off by default, and Cloudflare is optional. cela only knows an MCP contract (operator secret, owner header, the four
tools); the Cloudflare Worker is one implementation, and any mail backend serving the same contract works. With the
reserved-name setting unset there is no mail server and no browser exception; with it set, mail still reaches only
sessions whose profile names that server.

Unverified: the gateway's header pass-through and long-request timeout; that the orchestrator's own model-call agent
holds no MCP secrets (`0040:135` says so, no narrowing code found).

## Decisions needed (ADR)

1. Orchestrator-side mail tools, and whether they are allowed in browser sessions under 0041.
2. Throwaway-only accounts, or an owner-level identity with human-held credentials.
3. Terms-of-service stance: which services agents may sign up for.
4. Whether idle sessions are woken by mail at all (new route; Events), or mail is only read while the agent waits.

Unverified: how often `+` addresses are rejected or stripped; AgentMail paid tiers; latency of the poll loop.
