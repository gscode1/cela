# 0012: Egress proxy spike, Smokescreen chained to OneCLI

Status: accepted, 2026-11-16 (issue #51, slice 1 of epic #50). The local part is done and tested; the live cluster test ran in
slice 5 (see "Live results"), except the two-repository clone, which needs a GitHub App.

## Context

Epic #50 puts all sandbox egress behind our own proxy and leaves OneCLI as the credential injector only. Slice 1 has to
show that this is buildable before the schema (slice 2) and the cutover (slice 6) depend on it: Stripe Smokescreen
embedded in a small Go binary, chained to OneCLI's gateway, with one session's token per tunnel.

## Decision

### Layout and toolchain

- `packages/egress-proxy/` is its own Go module (`github.com/gscode1/pi-durable-k8s/egress-proxy`) with a
  `package.json` whose scripts call Go, so `pnpm check` runs it with the TypeScript packages: `build` is `go build`,
  `typecheck` is `scripts/gofmt-check.sh` (gofmt must be clean) plus `go vet ./...`, `test` is
  `go test -race -count=1 -timeout 180s ./...`. This is the whole Go lint for now; add `staticcheck` only when it earns
  its place.
- **Go is pinned** by the `toolchain go1.27.3` line in `go.mod` (and `go 1.27`), the same number in
  `images/egress-proxy/Dockerfile`. A newer local Go uses the pinned toolchain; an older one downloads it. Upgrade Go on
  purpose, in a change that touches go.mod, the Dockerfile and this ADR together.
- The repository has no `.github/workflows`, so there is no CI to edit. When CI exists it needs Go on the runner (use
  `actions/setup-go` with `go-version-file: packages/egress-proxy/go.mod`) and `pnpm check` then covers Go. `-race`
  needs cgo, which GitHub's Linux runners have.
- `images/egress-proxy/Dockerfile`: multi-stage, static `CGO_ENABLED=0`, `gcr.io/distroless/static:nonroot`, built for
  arm64 and amd64 with `buildx`. Not built or pushed in this slice.

### Smokescreen pin and upgrade policy

- Pinned to `github.com/stripe/smokescreen/v2` commit `8ba9b4e488a818b10b5ec44e7b9ef1f0ae282b74` (go.mod:
  `v2.0.0-20261112132816-8ba9b4e488a8`, 2026-11-12, 58 commits after tag `v0.1.0`). Its `go.mod` says `go 1.26.0`. The
  upstream repo has only `v0.x` tags, which Go cannot use for a `/v2` module path, so a commit pseudo-version is the only
  pin. Its goproxy fork (`github.com/stripe/goproxy`) is pinned through Smokescreen's own go.mod and go.sum.
- Upgrade only on purpose: read the diff of `pkg/smokescreen` (`smokescreen.go`, `config.go`, `ip_policy.go`) and of the
  goproxy fork's `https.go`, rerun `go test -race ./...`, and record the new commit here. The code relies on these
  internals, so an upgrade can break them silently if the tests are not read: `Config.UpstreamProxySelector`,
  `Config.UpstreamProxyConnectReqHandler`, `ProxyHttpServer.ConnectDialContext`, the `X-Upstream-Https-Proxy` header
  handling, and that `dialContext` re-resolves any address that is not the decision's `OutboundHost`.
- `go.sum` was completed with `GONOSUMDB=*` because the checksum database was unreachable from the dev machine; the
  module proxy supplied the hashes. Rerun `go mod verify` with the sumdb reachable before the first image build.

### How the proxy works

Smokescreen's `BuildProxy` gives the CONNECT handling, ACL hook, resolve-classify-dial path and logging. We run our own
`http.Server` around it (`StartWithConfig` calls `os.Exit` and installs signal handlers) and add:

- **Token to session** (`Config.RoleFromRequest`): the egress token is the password of `Proxy-Authorization: Basic`.
  `Principals.Lookup` maps it to a session, which is the Smokescreen role. The static file implementation keeps only
  SHA-256 hashes in memory; the interface is what slice 4 replaces with a Postgres-backed store. Missing, malformed or
  unknown tokens are denied (407 with `Proxy-Authenticate`). The header is deleted once read.
- **Per-session ACL** (`Config.EgressACL`, our `Decide`): a session needs a rule for host and port (suffix rules
  `*.x.org` never match the apex; the port defaults to 443). The rule carries the route, `direct` or `onecli`. A
  `onecli` rule for a session with no OneCLI token is denied, never routed direct. Deny is the default.
- **Chaining to OneCLI** (`Config.UpstreamProxySelector` and `Config.UpstreamProxyConnectReqHandler`): the selector
  returns the fixed upstream URL only for `route=onecli` (and `""` for an explicit direct route). The connect handler runs
  per tunnel with that tunnel's own context, reads the role from it and sets `Proxy-Authorization: Basic x:<that
  session's OneCLI token>` on the CONNECT to the upstream. The token is not in the upstream URL, so it is never in the
  `X-Upstream-Https-Proxy` header, a log line or a metric. Because the token is looked up from the tunnel's own
  context, there is no shared slot that two sessions could swap.
- **Client headers**: the handler in front of Smokescreen answers anything but `CONNECT` with 405 (plain HTTP proxying
  would forward client headers to the origin), and deletes every `X-Upstream-Https-Proxy` before Smokescreen reads it.
  This matters: Smokescreen falls back to the client's value when the selector returns `""`, so on the direct route a
  client could otherwise pick the next hop. `Proxy-Authorization` is deleted when read, and goproxy builds the upstream
  CONNECT headers from scratch, so the client's value is never forwarded.
- **No TLS interception**, no `MitmTLSConfig`. Fail closed: no policy match, no token, no binding, a policy change
  racing the selector (it returns an undialable address rather than `""`), or a proxy env var present at start (the
  binary refuses to start with `HTTP(S)_PROXY` or `NO_PROXY` set; goproxy reads them and `NO_PROXY` would turn an
  upstream tunnel into a direct one).
- **Tunnel registry** (`Registry`): every outbound connection is wrapped when dialled and registered by session.
  `Registry` closes them on demand; closing the upstream side ends the tunnel, goproxy then
  closes the client side. The CONNECT handshake with the upstream has a deadline (`EGRESS_UPSTREAM_HANDSHAKE_TIMEOUT`,
  default 10 s) that is cleared once the response header has been read, so a silent upstream cannot hold a tunnel. Each
  tracked connection's timer is installed before it is published, and a connection that is already closed is never
  registered, so expiry and close cannot race or leak. A maximum age (`EGRESS_MAX_TUNNEL_AGE`, default 1 h) closes each
  tunnel with a timer. The spike had a per-session close function behind an admin endpoint (`CloseSession`,
  `POST /admin/sessions/{session}/close-tunnels`); slice 7 replaced both with automatic re-evaluation, see
  [0039](0039-egress-revocation.md).

### How the private-address denial is bypassed, only for the upstream

Smokescreen's `dialContext` resolves every address it is asked to dial, classifies it, and refuses loopback, private,
link-local, CGNAT and IPv6-embedded addresses. The chained upstream is a ClusterIP (private), and goproxy dials it
through that same function, so it would be refused. We do not use `UnsafeAllowPrivateRanges`, `AllowRanges` or
`IPFilterBypassedDomains`: all three are address- or name-wide and also apply when a client asks for that address as a
destination.

Instead we set `ProxyHttpServer.ConnectDialContext`, which goproxy uses for every outbound dial. Our `dial`:

- if the tunnel's decision selected an upstream (route `onecli`): the address must equal the fixed
  `EGRESS_UPSTREAM_ADDR` exactly, the selected upstream must be our upstream URL, and the address must differ from the
  requested destination. Then it dials with a plain `net.Dialer`. Any other address in a `onecli` tunnel is refused, which
  also stops `NO_PROXY` or another proxy setting from redirecting the tunnel;
- otherwise (route `direct`): the address must equal the requested destination, and the dial goes to Smokescreen's own
  `dialContext`, with its full resolve-classify-dial checks;
- both paths register the connection in the registry.

So the exemption exists only for the one configured `host:port`, only inside a tunnel that the ACL routed to onecli. The
ACL also denies the upstream's host name as a destination for every session, and a test checks that a direct rule for the
upstream's own address, or a name that resolves to it, is still refused. What the origin hostname resolves to is still
classified for a `onecli` route (Smokescreen resolves it before selecting the upstream), so a name that resolves to a
private address is refused on both routes.

### Findings

1. The hooks needed exist in the pinned version: `UpstreamProxySelector` (trusted, URL not validated),
   `UpstreamProxyConnectReqHandler` (edits the CONNECT sent upstream, per tunnel context), `RoleFromRequest`,
   `EgressACL` (our `Decider`), `RejectResponseHandlerWithCtx`. `ConnectDialContext` is on goproxy, reached after
   `BuildProxy` returns.
2. The selector's URL ends up in the client request's `X-Upstream-Https-Proxy` header and is read back by goproxy, so it
   must not carry credentials. Use the connect-request handler for the token.
3. Smokescreen reads the client's `X-Upstream-Https-Proxy` before `RoleFromRequest` runs and uses it when the selector
   returns `""`. Stripping has to happen in a wrapper in front of Smokescreen.
4. The tunnel limiter (`MaxConcurrentConnectTunnels`) and Smokescreen's connection accounting live in its
   `dialContext`, which the upstream hop skips. A `onecli` tunnel is therefore not counted by them. A cap per session is
   slice 3 work, on our own registry.
5. goproxy does not forward the client's `Proxy-Authorization` to the upstream CONNECT (it builds the headers from the
   upstream URL), but plain HTTP proxy requests would forward client headers, hence CONNECT only.
6. A `onecli` tunnel resolves the origin name inside the proxy before chaining (the sandbox has no DNS in the target
   design, so the proxy needs DNS to kube-dns or the world for that lookup).
7. Go integration tests with a fake upstream proxy and a fake origin cover all of the above without a cluster.

### Live results (slice 5, 2026-11-18, [0037](0037-egress-onecli-route.md))

Run with `hack/egress-onecli-smoke.sh` on a throwaway kind cluster (`hack/kind-up.sh --name pi-egress --no-expose --cni
cilium --build --onecli --egress-proxy`: Cilium, bundled OneCLI, the proxy, the NetworkPolicies of the charts; deleted
afterwards). Proven live:

- **Dialling the real OneCLI ClusterIP `:10255` from the proxy's pod label works through the NetworkPolicy**, and the
  management API `:10256` and the orchestrator from the same label do not (`egress-proxy-allow-onecli-egress`, OneCLI's gateway
  ingress admitting `pi-egress-proxy`).
- **OneCLI's MITM on the chained CONNECT works.** The gateway log shows `CONNECT api.github.com:443`, lane `Mitm`, agent
  `pi-session-<uuid>`, peer the proxy's pod. The sandbox trusts it only with OneCLI's CA: without the CA the request fails
  TLS certificate verification, with it GitHub answers `401 Bad credentials`, which GitHub
  sends only when an `Authorization` header arrived, that is, the dummy GitHub token the session's OneCLI secret injects. A
  header-echo origin (`httpbingo.org`) shows the injected `X-Smoke-Credential`, and no egress token, no OneCLI token and no
  `Proxy-Authorization` header.
- **Per-session identity**: the chained CONNECT carried the session's own OneCLI token (the log names the session's agent);
  session B with the same rule and no binding is denied, A's sealed row copied onto B does not open, A's egress token from
  B's Pod is refused.
- **Tunnel kill on the live path**: closing the session's tunnels (the spike's admin endpoint, since removed) ended a 10 s
  response through OneCLI after 4 s (`UND_ERR_SOCKET`).
- **No binding, no route, and never a direct fallback**: deleting the binding row made the proxy deny in 1 to 2 s, and
  `api.github.com` was not reached directly (an unauthenticated direct call would have answered 200).

**Not proven: `git clone` of repo A succeeds and the same clone of repo B fails.** A throwaway cluster has no GitHub App,
so a real repo session cannot be made, and the credentials of the maintainer's own App were not searched for or used. What
stood in for it: the orchestrator's own `RepoAccess` (real OneCLI agent, secrets, grant narrowing, sealed binding, session
rules) run with a fake GitHub minting a dummy token, and a real HTTPS request to `api.github.com` through the whole chain.
Repository scope itself is GitHub's installation token (unchanged, ADR 0032 and `docs/repo-workspace.md`); the
`proxyAuthMethod=basic` handshake of `git` against the proxy is covered by `hack/egress-session-smoke.sh` (a real `git
ls-remote` through the proxy). The issue's "repo A / repo B" check stays with `tests/e2e/run.sh phase4c`, which needs `REPO_A`
and `REPO_B`,.

## Comparison with Agent Substrate's `atenet-egress`

Source: `github.com/agent-substrate/substrate`, docs `security/security.md`, `security/threat-model.md`,
`security/extensibility.md`, `guides/egress-credential-injection.md`, read 2026-11-16 (design level only; its source
was not read).

| | Substrate `atenet-egress` | This design |
|---|---|---|
| Identity | Short-lived SPIFFE X.509 per actor, held by `atunnel` outside the sandbox. nftables outside the sandbox send the actor's TCP to `atunnel`, which presents the certificate to the gateway. The actor holds no identity. | A static per-session token (the egress token) in the sandbox's environment, readable by the agent. Bound to a pod IP in slice 4. |
| Policy point | A fail-closed PEP (Envoy) with per-actor destination allowlists, replaceable or extended with `ext_proc`. Policy changes apply to new connections only. | Smokescreen `EgressACL` (`Decider`) over a policy snapshot. A rule or session delete also closes open tunnels (slice 7). |
| Credential injection | At the gateway after TLS termination for listed names, from a credential provider; the actor sends a placeholder header. | OneCLI, chained behind the proxy, injects for `route=onecli` hosts only. No TLS interception in the proxy itself. |
| Threat model | Actors untrusted and mutually hostile; no credentials, no open network, no escape. DNS answers only allowed names. Non-TCP dropped. | Same stance for TCP egress. DNS is closed in the sandbox and slice 6 drops everything but the proxy listener. |

Borrowed: default-deny and fail closed when policy is missing or stale; credential injection outside the sandbox, so a
prompt-injected agent has nothing to exfiltrate; per-actor attribution on every connection, with the identity in the
log; immediate revocation (their "dynamic egress revocation", our tunnel registry); redaction of tokens in logs.

Not borrowed, and why: SPIFFE certificates and mTLS (they need a per-worker tunnel outside the sandbox and a pod
certificate controller; our sandbox is a gVisor pod with NetworkPolicy and an env var, and this is a proof of concept);
Envoy and `ext_proc` (Smokescreen's `Decider` is our policy point, in-process); TLS termination of all HTTPS for policy
(we stay at CONNECT level, which cannot stop exfiltration through allowed hosts; that limit is accepted in #50); actor
JWTs for backends that verify identity (a later option for the MCP slices, minted by the orchestrator, not needed now).

### The bar: the identity the sandbox holds must not be usable to call a backend directly

Adopted from the Google review (issue #51 comment). Our egress token is readable by the agent, so it is acceptable only
if it is useless anywhere but the proxy:

- It is not a credential of any backend. OneCLI never sees it, and the sandbox holds no OneCLI token (the OneCLI agent
  token stays in the proxy's principal store and is sent only on the proxy-to-OneCLI hop).
- Presented to OneCLI, GitHub, an MCP server, Postgres or the orchestrator it is meaningless. The only place it
  authenticates is the proxy listener, and there it buys exactly the session's own rules: what the agent can already
  ask for. OneCLI ingress is limited to the proxy and the orchestrator (slice 5/6), so the sandbox cannot present a
  OneCLI token even if it found one.
- A stolen token used from outside the sandbox is the remaining gap: the token travels in plaintext inside the cluster
  and is not bound to the pod until slice 4 (pod IP in `principals`). Until then the bar is met for backends but not for
  replay against the proxy itself. Slice 4's acceptance test ("A's token from B's pod fails") is the check.

Tests that enforce the parts of the bar that exist today: the origin never sees the egress token or the OneCLI token;
the upstream gets only the session's own OneCLI token, never the egress token (`TestConcurrentSessionsNeverSwapUpstreamTokens`).

## Consequences

- Go is now a build prerequisite for `pnpm check`. A machine without Go cannot run it; the failure is the missing `go`
  command, not a silent skip.
- The proxy keeps no state across a restart besides the policy file: tunnels close, tokens come from the file (later the
  database).
- Direct-route tests dial loopback with `AllowRanges` and `AllowSelfConnections` set in the test only.
- Rejected: forking Smokescreen; `IPFilterBypassedDomains` or `AllowRanges` for the upstream (too wide, see above);
  putting the OneCLI token in the upstream URL (it would travel in a header and could reach logs).
