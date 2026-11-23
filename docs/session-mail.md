# Session mail: the MCP contract

Status: proposed ([ADR 0068](decisions/0068-session-mail.md), issue #420). Off unless the deployment sets
`sessionMail.server`. cela ships no mail backend; this is what a backend must serve.

## What cela does

An operator registers one MCP server in the catalog (`PUT /admin/mcp-servers/{name}`) with a OneCLI secret (`onecliSecret`), so
it is credentialed like any other (ADR 0040), and sets the chart value `sessionMail.server` (env `PI_SESSION_MAIL_SERVER`, on
the orchestrator and ingest) to that name. Then:

- A profile that names the server gets it as a tool set, the browser flavour included (the one credentialed server a browser
  profile may name; `networkMode: direct` and the desktop flavour still refuse it).
- The orchestrator sends the header below on every request of a session to that server, and on no other server's.
- Discovery (`tools/list` at the orchestrator's own start) sends no header.

## The owner header

| | |
| --- | --- |
| Name | `X-Cela-Mail-Owner` |
| Value | the session's OneCLI MCP agent identifier, `<PI_ONECLI_NAME_PREFIX><session id>-m` (ASCII, at most 50 characters), identical on every request of the session |
| Set by | the orchestrator, replacing any value; the model and the sandbox cannot set it |
| Authentication | the operator's secret, injected by the OneCLI gateway (its form, header or bearer, is the secret's own); the header is identity, not authentication |

The header is only meaningful together with the operator secret. A server must serve mail only to requests that carry both.

## What a server must do

- **No header: `initialize` and `tools/list` only.** Any other request without the header is refused (fail closed). Refuse a
  request that carries the header more than once or empty.
- **Owner from the header on every request.** Never from `Mcp-Session-Id`, a tool argument or a cookie. Every query is scoped by
  owner, `read_email` included: another owner's message id is "not found", not "forbidden".
- **The address is derived and never an argument.** `address = encode(HMAC(server-only key, owner))`, so nobody who learns a session
  id can compute or target its address. The server never accepts an address or an owner as a tool input.
- **Serve the host to this one backend only.** The catalog URL must point at a host that serves nothing else.
- **Expire inboxes** (a TTL) and never reuse an address. Mail that matches no owner is quarantined, not guessed onto a session.
- **Treat mail as untrusted input** for the agent: extract codes and links in code, strip HTML and hidden text, return full
  bodies only on request, fenced as untrusted.
- **Catalog `timeoutMs` of at least 150000.** `wait_for_email` may block 120 s and the default is 60000.

## The four tools

All tools take no owner and no address.

### `get_email_address`

Input: none. Output (text, JSON): `{ "address": "<local>@<domain>" }`: the session's own address, stable for the session,
typed by the agent into sign-up forms.

### `wait_for_email`

Blocks until a message newer than the call's start (or not yet returned by an earlier wait) arrives, or the time is up.

| Input | |
| --- | --- |
| `timeoutSeconds` | integer, 1 to 120, default 60; a larger value is clamped, not an error |
| `fromDomain` | optional string; ranks matching senders first, never lifts quarantine |

Output: `{ "email": { "id", "from", "subject", "receivedAt", "codes": [...], "links": [...] } }` or `{ "email": null,
"timedOut": true }`. `codes` and `links` are extracted by the server; links are limited to the sender's registrable domain unless
the server's policy says otherwise.

### `list_emails`

| Input | |
| --- | --- |
| `limit` | optional integer, 1 to 50, default 20 |
| `since` | optional ISO 8601 time |

Output: `{ "emails": [ { "id", "from", "subject", "receivedAt" } ] }`, newest first, owner's only.

### `read_email`

| Input | |
| --- | --- |
| `id` | string, an id from `list_emails` or `wait_for_email` |

Output: `{ "id", "from", "subject", "receivedAt", "text", "truncated" }`: the plain-text body, HTML and hidden text stripped, cut
to a size the server states, marked as untrusted content. An id of another owner, or an unknown one, is an error result.

## Backends

A Cloudflare Email Worker (inbound routing on a dedicated apex domain, mail stored in D1 or R2, the MCP endpoint in the Worker)
is one way to serve this contract. cela does not include, deploy or depend on it. Another backend works if it honours the rules
above.

## Not in this contract

Sending mail, attachments, waking an idle session on arrival (MCP Events) and owner-level inboxes that outlive a session.
