# 0007: Native remote MCP tools, called from the orchestrator

Status: accepted, 2026-11-16 (issue #39, first slice). Credentials are #42, per-session selection is #41, the server
catalog beyond static config is #40 (done: see [0009](0009-mcp-catalog-in-postgres.md), which replaces `PI_MCP_SERVERS`).

## Context

Sessions should get typed MCP tools that the model calls directly. `plan.md` says tools run in the sandbox, but an MCP
server over streamable HTTP is not a program to run: it is an HTTP endpoint, like the model provider. Putting the client
in the sandbox would need sandbox egress and, later, would put the server's credentials where the model's shell is.

## Decision

- **Remote MCP is an orchestrator-side HTTP client, like the model call.** `packages/orchestrator/src/mcp.ts` uses
  `@earendil-works/pi-mcp` (pinned, same release line as Pi Durable) and sends every request through the orchestrator's
  OneCLI gateway `fetch` (`createGatewayFetch`). Nothing runs in the sandbox, the sandbox env and network policy do not
  change, and the design does not depend on sandbox egress. `plan.md` is amended, not broken: tools that need a
  workspace still run in the sandbox.
- **Operator-defined URLs only.** `PI_MCP_SERVERS` is a JSON array of `{ name, url }` in the Deployment. The URL must be
  https; the name matches `^[a-z][a-z0-9-]{0,31}$`. No session, user or model input names a URL. A malformed value fails
  the start. Unset or empty means the feature is off. The host must also be allowed in OneCLI
  (`deploy/onecli-host-rules.sh`, `deploy/onecli-policies/egress.yaml`), so the gateway is the second gate.
- **A flag, not a default.** Off: no `tool_search`, no MCP extension, the offered tools are exactly the coding tools.
  On: `tool_search` and one extension `mcp-<name>` per server, whose tools are `deferred` (the model finds them with
  `tool_search`, so a big server does not fill every prompt), named `mcp__<server>__<tool>`.
- **Replay is `unsafe`.** A call interrupted by a crash settles `interrupted` and is never rerun: the server may have
  acted. A call is not a sandbox command, so it never sets the exec-in-flight marker of ADR 0003 and a crash does not
  recycle the sandbox Pod.
- **Stateless servers only.** One `McpClient` per server is shared by every conversation, so a server that keeps
  per-session state would mix conversations. On `McpSessionExpiredError` the client connects again and the call is
  tried once more (the server refused it before running it).
- **Discovery never blocks.** `listTools` runs after the Harness is open, in the background, with a timeout and a
  doubling backoff. The extension is installed empty at once and replaced when the tools arrive. Until then a call to
  one of its tools settles as Pi Durable's `tool_unavailable`; readiness is unaffected. The catalog is read once per
  process; a server that changes its tools needs an orchestrator restart (static config until #40).
- **Bounded.** Message size (2 MiB), call time (60 s), the text the model sees (`limitMcpContent`, 20 KB, then Pi's
  `outputLimits`), and the abort signal of the conversation reaches `callTool`.
- **Credentials are out of scope.** Only servers that need none (DeepWiki). #42 decides how a credential reaches the
  gateway; the orchestrator never puts a secret in a tool call.

> Amended by 0009: the server list is the catalog in Postgres, not `PI_MCP_SERVERS`, and the host default is pinned
> always, not only "with the flag on".

## Which conversations get MCP

Pi Durable selects every installed extension for a conversation that stores none (`selectExtensions` in
`harness/agent.js`: `settings.extensions ?? installed`). Installing `tool_search` and the MCP extensions would therefore
hand them to every existing conversation at the next start. With the flag on, the host pins the default selection
(`settings.extensions = [coding]`), and `Host` adds `tool_search` and the MCP extensions to the `agent` of each
conversation it creates from then on (`extensions: { add }`, which stores names). Conversations created before the flag
was set keep their tools. With the flag off nothing is pinned and nothing is added.

Selection is real authorization: the sandbox never holds the grant, so what a conversation stores is what it can call.
#41 replaces the `add` list with a per-session profile; the pin stays.

## Consequences

- Pinning `settings.extensions` is a host default, read at every use and not stored: turning the flag off again hides
  the MCP tools from the conversations that stored them (the stored names stay and resolve again when it is back on).
- One shared client means one connection to each server for all sessions; calls from different sessions run in
  parallel on it. The orchestrator's memory per concurrent call is to be recorded in the e2e run (issue #39).
- Rejected: a client in the sandbox through pi-env `openProcess` (that is for local stdio servers, later); a client per
  conversation (stateful servers, but a connection and a session per conversation); installing the extensions for every
  conversation (silent change to existing ones).
