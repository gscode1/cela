# Brief: replace OneCLI with a minimal credential injector in our egress proxy, and add TCP

Working brief for a two-round proposal/critique exercise (2026-11-23). Not a decision.

## The idea under evaluation

1. Drop OneCLI (bundled v2.20.0) and add the *minimum* credential-injection functions to our own Go egress proxy
   (`packages/egress-proxy`, Smokescreen + goproxy fork, rules/principals/bindings in Postgres).
2. Make the egress proxy support TCP beyond today's HTTPS-CONNECT-on-80/443.

## What you must read first (repo paths)

- `plan.md` (sections on OneCLI, "Secrets", Phase 4b/4c) and `AGENT.md` (invariants: model credentials never in sandboxes,
  single owner per schema, no sandbox access to Postgres, no abstraction with one implementation).
- Proxy: ADRs `docs/decisions/0012` (spike, chaining, private-address bypass), `0034` (rules, evaluator, address tiers),
  `0035` (runtime, read-only DB role, fail-closed), `0036` (principals, egress token), `0037` (OneCLI route, sealed
  bindings AES-256-GCM), `0038` (network modes, why no transparent proxying, publicPorts), `0039` (revocation).
  Code: `packages/egress-proxy/internal/egress/*.go` (~2.5k lines non-test).
- OneCLI: ADRs `0022` (bundled, open sign-up, 3 releases, bootstrap), `0040` (MCP traffic orchestrator->OneCLI with
  per-session agents, host-rule reconciler), `0042` (admin key in orchestrator, accepted risk), `0043` (open defaults),
  `0056` (custom providers via OneCLI generic secret), `docs/model-credentials.md` (Codex OAuth placeholder JWT, refresh
  race #265, fallback store), `docs/research/egress-bakeoff.md` (h1.1-only on onecli route, credential echo, redirects,
  GitHub App minting not usable), `docs/research/onecli-v2-recheck.md`.
- Orchestrator touchpoints: `packages/orchestrator/src/onecli.ts`, `repo-access.ts`, `mcp-access.ts`, `github-app.ts`.

## Facts already established (do not re-derive)

- OneCLI today does, for cela: (a) sandbox `route=onecli` tunnels: TLS MITM with OneCLI's CA and injection of the
  session's repo-scoped GitHub installation token (minted by OUR `github-app.ts`, stored as a OneCLI secret, granted to a
  per-session OneCLI agent); (b) orchestrator model calls: placeholder API keys / placeholder Codex JWT swapped for the
  real credential, including Codex OAuth refresh (unlocked, race #265); (c) orchestrator MCP calls with per-session agents
  for credentialed servers; (d) custom OpenAI-compatible providers via generic secrets; (e) host rules (reconciled from
  the MCP catalog); (f) encrypted secret storage, a dashboard to enter secrets, and the CA.
- OneCLI pain: open sign-up on the management API (network is the only control), account-level admin key that lists every
  agent token, no scoped keys, own Postgres and 3 Helm releases plus a bootstrap that depends on observed behaviour,
  HTTP/1.1 only on the MITM leg, no per-agent repo scoping in OSS, Codex refresh race.
- The proxy today: CONNECT only (405 otherwise), no TLS interception, per-session egress token bound to pod IP,
  evaluator parity TS/Go via shared vectors, read-only DB role (writes only `proxy_status`), sealed per-session bindings
  already decrypted in the proxy for the onecli route, revocation closes tunnels, no DNS in proxied sandboxes,
  `egressProxy.publicPorts` 80/443 at the network layer, rule `ports` already exist. Transparent proxying was rejected in
  0038. Orchestrator traffic deliberately does NOT go through the proxy (0040: the proxy is a sandbox-only control).
- Tension to resolve explicitly: plan.md says "every credential goes through OneCLI, the orchestrator holds only a OneCLI
  agent token"; AGENT.md says "model credentials stay in the orchestrator and are never mounted into sandboxes".

## Questions the proposal must answer

Q1. **Inventory and minimum.** For each OneCLI function (a)-(f), is it needed at all, and where should it live if OneCLI
    goes: in the egress proxy, in the orchestrator in-process (it is trusted and already holds the GitHub App key, the
    master key and the binding seal key, ADR 0042), or nowhere? State the minimal set the proxy must own.
Q2. **Injection design in the proxy.** Which route triggers MITM (`route=inject`?), how the leaf certs are minted (CA
    storage, key custody, rotation, which pods hold the CA private key), the injection spec (exact host+port, header name,
    format, replace-only-placeholder vs always-set, strip client value), HTTP/1.1 vs HTTP/2, WebSocket upgrades,
    redirects, upstream cert verification, body untouched. How it composes with Smokescreen/goproxy (goproxy has MITM
    support; is it safe to use the fork's?), and with the existing decide->resolve->dial-the-judged-IP path.
Q3. **Secret custody and data model.** Where the plaintext credential lives (sealed in `egress.bindings`-like rows,
    written by the orchestrator, read by the proxy) and whether the proxy stays read-only. If OAuth refresh (Codex) is
    needed anywhere, who refreshes and how the race (#265) is avoided (advisory lock + compare-and-set). How an admin
    enters a secret without OneCLI's dashboard (admin API in ingest? sealed with what key?).
Q4. **Security deltas.** What gets better (sign-up hole, admin-key token listing, 3 releases) and what gets worse (proxy
    becomes a TLS-terminating component holding a CA key and plaintext credentials, facing untrusted sandbox traffic; the
    blast radius of a proxy RCE). Credential echo, header smuggling, injection into a host the session should not have,
    cross-session confusion. Which invariants need new tests (name them).
Q5. **TCP.** CONNECT already tunnels TCP; what concretely is missing: ports beyond 80/443 at the network layer, a SOCKS5
    listener (socks5h, remote DNS, same egress token as username/password), clients that ignore proxy env, SSH for git,
    database clients. Which of these is worth doing, with what rule shape (ports are already in rules), and what stays
    `direct`-mode only (UDP, transparent capture). No credential injection on raw TCP unless you justify it.
Q6. **Cost, phasing, kill criteria.** Size in slices (each one a reviewable PR with tests), what is deleted (charts,
    bootstrap, reconciler, `onecli.ts` paths), migration for existing installs, and the concrete conditions under which
    we should keep OneCLI instead (or keep it optional as an external mode).
Q7. **Alternatives considered briefly**: keep OneCLI as is; a different off-the-shelf injector (e.g. Envoy +
    credential injector / ext_proc, mitmproxy, agent-substrate atenet-egress style); orchestrator-only injection with the
    sandbox never needing MITM (e.g. git credential helper backed by a proxy-side token exchange). One paragraph each,
    why not or why.

## Output rules

- Concrete, cite file paths/ADRs. Separate facts (verified in repo) from assumptions. Flag every claim about goproxy,
  Smokescreen or OneCLI internals you did not read as UNVERIFIED.
- Do not modify any repository file other than your output file.
