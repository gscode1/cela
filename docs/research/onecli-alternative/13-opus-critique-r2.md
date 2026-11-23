# Opus critique, round 2: Astra's revised proposal

Critique of `12-astra-proposal-r2.md` against `00-brief.md` and the round-1 critique `11-opus-critique-r1.md`,
2026-11-23. Not a decision.

Sources read for this round:

- Repo: `plan.md`, ADRs 0017, 0040, 0042, 0043 and 0056, `docs/model-credentials.md`,
  `charts/cela/templates/networkpolicy/{orchestrator,cilium,sandbox}.yaml`, `charts/cela/values.yaml`,
  `packages/orchestrator/src/{onecli,workspace,github-app,repo-access}.ts`,
  `packages/session-core/src/egress-rules.ts`, `packages/egress-proxy/internal/egress/{proxy,platform}.go`.
- Go modules, from `go env GOMODCACHE` = `$GOMODCACHE`: **G** = `github.com/stripe/goproxy@v0.0.0-20260922184237-948457f542a3`,
  **S** = `github.com/stripe/smokescreen/v2@v2.0.0-20261112132816-8ba9b4e488a8`.
- `@earendil-works/pi-ai@1.6.0`, the version pinned in `packages/orchestrator/package.json`. It came from `npm pack` into
  a scratch directory, because the local `node_modules` holds only 1.5.2. **P** = its `dist/`.

## Summary

Round 2 is a real revision. Every round-1 required change has an answer. The orchestrator-egress decision is now
explicit. Rotation semantics are fixed. The CA is name-constrained, with an honest caveat about what DNS subtrees mean.
B is costed instead of dismissed. The Codex refresh design is concrete and mostly right. The source claims I re-checked
are accurate, and the pi-ai `CredentialStore.modify` claim holds (P `auth/resolve.js:62-95`).

It still has five substantive problems. Two of them are new factual errors that change the design:

1. **The A design hooks into a path that Smokescreen cannot reach.** The proposal says to use "the fork's authorized
   CONNECT hijack hook". Smokescreen's only CONNECT handler returns either `OkConnect` or `ConnectMitm` (S
   `smokescreen.go:1033-1063`). goproxy stops at the first handler that returns an action (G `https.go:120-129`), and
   `httpsHandlers` is unexported (G `proxy.go:39`). `ConnectHijack` is therefore unreachable without forking a module.
   The hook that *is* reachable, and that already composes with the judged dial and the registry, is
   `ConnectCopyHandler` (G `https.go:186-189`). The proposal already plans to install it for half-close.
2. **Codex OAuth refresh bypasses the guarded transport, and its error path can leak tokens.** pi-ai 1.6.0's Codex
   refresh calls the **global** `fetch` (P `auth/oauth/openai-codex.js:126`), not the `fetch` that `withFetch` injects.
   On a malformed token response it throws `JSON.stringify(json)`, which can contain `access_token` and
   `refresh_token` (`:99-100`). That error becomes the `cause` of a `ModelsError`. The proposal's statement that "OAuth
   token endpoints use this same path" is false for the pinned SDK.
3. **The orchestrator-egress section is wrong about what it gives up, in both directions.** Under the default open
   OneCLI posture (ADR 0043, `plan.md:127`) the gateway was never a hostname chokepoint, so for default installs the
   "deliberate loss of the OneCLI chokepoint" is close to zero. For hardened Cilium installs it is a real regression,
   and the proposal offers no way to keep it. Separately, it silently breaks the motivating case of ADR 0043: a LAN MCP
   server added through the catalog at runtime. On the plus side, judged-IP dialing fixes 0043's documented
   DNS-rebinding residual risk, and the proposal does not claim that credit.
4. **B is described with a delivery channel the network does not allow, and its advantages are undercounted.** No
   sandbox may reach the orchestrator (`sandbox.yaml:3-4`; orchestrator ingress is from ingest only, `orchestrator.yaml:18-24`).
   The bridge runs orchestrator → sandboxd, so B has to be push-based. That is simpler and cheaper than the "endpoint
   behind the bridge" the proposal costs. B also keeps repo sessions working on `egressProxy.enabled: false` installs,
   covers `uploads.github.com` and `raw.githubusercontent.com`, and removes the unconstrained OneCLI CA from sandbox
   trust stores. None of these appears in the comparison.
5. **The credential store is a small vault, which the brief says not to build.** Static API keys and MCP bearer tokens
   do not need an encrypted Postgres table, a separate key, key rotation and an exec-only import CLI. A
   Kubernetes Secret mounted only in the orchestrator, fed by ExternalSecret the way `plan.md:202` already delivers
   `ONECLI_API_KEY`, is smaller and GitOps-friendly. Only the mutable Codex OAuth login needs Postgres.

The recommendation to prefer A is defensible as a product preference, but it is not the best engineering call for a proof
of concept. The steelman for B is stronger than the proposal states, and there is a missing option D (an explicit
injection endpoint with no MITM and no CA) that gets A's custody property at much lower cost.

Verdict: **adopt with changes**, with the GitHub recommendation changed (section 3).

---

## 1. Were the round-1 required changes and open questions really addressed?

| R1 # | Round-2 claim | Assessment |
|---|---|---|
| 1 Orchestrator egress | "Accepted": guarded direct egress, ADR 0040 amendment | **Partly.** A decision was made. The analysis is wrong in places (§2.1): private exceptions are chart-only, which breaks runtime LAN MCP; the hardened-Cilium regression gets no mitigation; and "reuse the existing TS evaluator/address classification" overstates what exists. TS has `classifyAddress` with the blocked and private tiers (`egress-rules.ts:254-330`), but the **platform** set (DB, kube API, the namespace's Services) is Go-only by design: "which cluster addresses those are is the proxy's to know" (`egress-rules.ts:254-258`; Go `platform.go:13-24`). Porting `Platform` to TS is new work that is not in slice 4. |
| 2 Authz vs credential | Accepted | **Yes.** The epoch/generation split, the per-request token read and the remint timeline (open question 5) are correct. Round 2's correction that remint happens before use, not on a timer, is right (`repo-access.ts:29`). |
| 3 Name constraints | Accepted with qualification | **Yes.** The subtree caveat is correct and honest. Note that A *improves* on today: the OneCLI CA that sandboxes trust now is unconstrained (`workspace.ts:98-111` writes it into every trust variable). |
| 4 Cite stock defects | Accepted | **Yes, but** it introduces the unreachable `ConnectHijack` route (§2.2). |
| 5 Cost B | Accepted | **Partly.** B is costed, but on a channel the NetworkPolicy invariant forbids, and with missing advantages (§3.1). |
| 6 Re-order | Accepted | **Yes.** Decision, TCP, SSH, schema, egress, API keys/MCP, Codex, A, removal. |
| 7 Re-baseline | 30–45 days | **Plausible but optimistic at the low end.** The slice table sums to 30–42 days for A and 22–32 for B, so 3 days of the headline ranges are unexplained slack. Not counted: the TS platform-address port, wrapping the Codex OAuth provider's transport (§2.3), a LAN-MCP network design, and the admin-ui (31 files) inside a 4–6-day slice 5 that also carries model, MCP, custom providers, ingest compatibility and sentinels. My estimate is **A 38–52 days, B 26–36 days**. |
| 8 Codex mechanics | Accepted; lease rejected | **Mostly yes.** Rejecting the lease is fine: a lock held on one checked-out client for at most 30 s is simpler. Two gaps: (a) `pg_advisory_xact_lock` cannot be cancelled by pi-ai's lock-wait `AbortSignal` (P `resolve.js:64-66, 83`) unless the store sets `lock_timeout` or polls `pg_try_advisory_xact_lock`; (b) an in-process promise queue per credential ID must come before the DB lock, or every concurrent request in a shard checks out a pool client to wait. The proposal's "constrain refresh concurrency" points at (b) but does not name the mechanism. |
| 9 Invariant tests | Accepted | **Yes.** The sentinel list is now good. It must name the Codex token-response error path explicitly (§2.3). |
| 10 TCP | Accepted | **Yes.** See §4 for the client-adapter correction. |
| 11 In-cluster CLI | Accepted | **Answered, but the premise is questionable** (§2.5). |

Open questions: 1 (pi-ai hook) **answered and verified**. 2 (Durable persistence) honestly partial. 3 answered, with
the gaps in §2.1. 4 answered with a quantified window. 5 answered well. 6 honestly UNVERIFIED with a defined gate.
7 answered for A; the B consequence is underplayed. 8 answered. 9 answered correctly: a legal/operator gate, with
Codex disabled if usage is not permitted. 10 answered. **None was dodged.** Questions 1 and 3 have the factual errors
below.

## 2. Verification of the new factual claims

### 2.1 Orchestrator egress: is direct HTTPS a security regression?

**What it replaces.** Under ADR 0043's open defaults, OneCLI's gateway has no host rules and forwards to any public host
and to RFC 1918:443 (`plan.md:127`; 0043 decision table). The orchestrator holds the agent token and the admin key that
lists every agent token (0042). Today, then, an orchestrator RCE can already send arbitrary data to any public HTTPS host
through the gateway, and can push to GitHub with tokens it mints from the plaintext App key. For default installs, the
exfiltration delta from direct egress is negligible. The proposal's "Security trade" paragraph overstates the loss.

**Where it is a real regression.** Under `networkPolicy.provider: cilium`, the orchestrator's only public FQDN today is
`api.github.com` (`cilium.yaml:51-83`), and an operator who applied 0043's hardening (`ONECLI_HOSTS` and
`egress-strict.yaml`) has a real allowlist at the gateway. The proposal widens that install to `world:443` with no opt-out.
There is a cheap fix that is consistent with 0043's "hardening as tools": an **optional static `toFQDNs` list rendered
from chart values**. Model hosts are compile-time constants and custom providers are already chart values (0056). An
operator can also list the MCP hosts they intend to use. A catalog MCP host missing from the list fails closed at the
network layer. This needs no reconciler and no policy-write RBAC. It should be in slice 4.

**Custody delta, which is the real cost.** Today, an orchestrator compromise can *use* model and MCP keys through the
gateway but cannot *read* them. Under the proposal, they become plaintext in orchestrator memory and decryptable from
Postgres with a mounted key, so they become portable. That is the mirror image of the argument the proposal uses to
prefer A for GitHub, and the document should say so. It is acceptable because the same process already holds the
non-expiring GitHub App private key, which outranks any model key. The honest framing is: "model keys become portable on
orchestrator compromise; the App key already was".

**Per-session MCP isolation (#42, ADR 0040 §4).** Today the gateway enforces one agent and its grants per session. After
the change, only orchestrator code enforces it. Since 0042 lets the orchestrator list every agent token, an RCE gains
nothing new. A *bug*, however, is no longer caught outside the process. Add a release-blocking invariant test: a
credential object carries its single allowed origin, and the dispatcher refuses to attach it to any other origin or to a
conversation whose profile snapshot does not name the server.

**Interaction with ADR 0043: LAN MCP regresses.** 0043 exists because a LAN MCP server
(`mcp-searxng.gskode.com`, a private address) had to work. 0040 promises that a catalog PUT is reachable "in seconds
with no GitOps change". The proposal allows private destinations only as "chart-defined" origin, CIDR and port. A LAN MCP
server added through `/admin/mcp-servers` therefore needs a Helm upgrade and a shard restart. Round 3 must pick one:

- (a) Accept it and amend 0040/0043: LAN MCP becomes chart-declared, like 0056's direct providers.
- (b) Port 0043's `privateHttps` rule to the orchestrator: RFC 1918:443 with `except` for the pod, Service and kube API
  CIDRs. The TS guard then allows private addresses only for catalog-named hosts and always blocks the platform set.

I recommend (b). It keeps 0043's behaviour, and the judged-IP dial makes it *safer* than today (next point).

**Interaction with ADR 0043: DNS rebinding gets better.** 0043 lists as a residual risk that OneCLI re-resolves an
admin-named host, so "the address it connects to is not the one anybody checked". The proposed guard resolves all
answers, judges them, and dials only a judged address. That closes the residual risk for orchestrator calls. Claim the
credit and record it in the 0043 amendment.

**Interaction with ADR 0056.** Keyless direct providers keep their `ipBlock` rules (`orchestrator.yaml:61-70`).
*Keyed* LAN providers currently go through OneCLI on RFC 1918:443. After the change they need the same private route as
LAN MCP, so the decision above covers both. 0056's statement that a keyed direct provider "needs a new ADR that amends
that rule" is exactly the ADR this work produces. Name 0056 in the amendment list.

**The standard-policy fallback.** Without `kubeApiCidrs`, the standard policy already allows 443/6443 to *any* address
(`orchestrator.yaml:84-88`), including every pod on 443. That makes the TS guard, not NetworkPolicy, the only control
for in-cluster targets on such installs. Either make `kubeApiCidrs` required when the new egress is on, or have the
guard block the configured pod and Service CIDRs. That requires those CIDRs as chart inputs, which they are not today.

### 2.2 The A hook: `ConnectHijack` is not reachable; `ConnectCopyHandler` is

- G `https.go:120-129` runs `httpsHandlers` in order and stops at the first non-nil action. `httpsHandlers` is unexported
  (G `proxy.go:39`) and can only be appended to (G `dispatcher.go:216, 244`).
- Smokescreen registers its handler in `BuildProxy` (S `smokescreen.go:888`). For an allowed CONNECT it always returns
  `goproxy.OkConnect` or a `ConnectMitm` action (S `:1033-1063`). Our own handler, appended later, would never run for
  allowed tunnels. Nothing in Smokescreen returns `ConnectHijack`.
- G `https.go:186-189`: for `ConnectAccept`, after the 200 and after `ConnectDialContext` (our `p.dial`, `proxy.go:137`)
  has dialed the **judged** address and wrapped it in `trackedConn`, goproxy calls `ConnectCopyHandler(ctx, client,
  target)` when it is set. `ctx.Req` still carries our `reqState`, which records the route decided for this tunnel.

The design that follows is clean. One `ConnectCopyHandler` does an opaque, half-close-correct copy for `route=direct`.
For `route=inject`, it TLS-terminates the client leg with the leaf, then runs `tls.Client` over the already-dialed,
already-judged and already-tracked `target` with `ServerName` set to the exact host. Upstream keep-alive then lives on
exactly one TCP connection per tunnel, which also settles the proposal's concern about "pools scoped per tunnel". No
fork, no second dialer, no untracked socket. Its one cost: 200 is sent before the TLS handshake, so a missing binding
must fail inside TLS or as an HTTP 4xx on the inner request, not as a CONNECT error. That is acceptable, and the proposal
already concedes the point for hijack.

The proposal's own claim that a "plain `http.Transport` would bypass that composition" is correct. It is the reason to use
the copy handler rather than build a transport.

### 2.3 Codex OAuth with multiple shards

Verified:

- `CredentialStore.modify` is the serialized seam (P `auth/types.d.ts:44-48, 76`).
- `refreshStoredOAuthCredential` rereads under `modify`, skips the refresh if another process already refreshed, and
  uses a 15 s timeout. It ignores the caller's cancellation once the refresh has started (P `auth/resolve.js:46-95`).
- Shards are separate Deployments, each the single owner of its own schema (ADR 0017). A credential table outside the
  `pi*` schemas, locked by credential ID, coordinates all shards correctly. **The round-2 lock design is right.**

Not addressed:

1. **The transport.** `refreshAccessToken` calls the global `fetch(TOKEN_URL, …)` (P `auth/oauth/openai-codex.js:123-141`).
   The orchestrator deliberately never sets a global dispatcher (`onecli.ts:163`). Either the orchestrator registers a
   wrapped `openai-codex` OAuth provider whose `refresh` uses the guarded fetch, which is a small override and not a fork,
   or the refresh leaves the guard. By the proposal's own rule ("any unhookable SDK path blocks that provider's
   migration"), this has to be decided in slice 6 and named. Today the problem is hidden because OneCLI refreshes and
   pi-ai never does: the placeholder expires in ten years (`onecli.ts:84-95`).
2. **The token-bearing error.** `readTokenResponse` throws ``…missing fields: ${JSON.stringify(json)}`` (P
   `openai-codex.js:99-100`). A response with both tokens but a non-numeric `expires_in` puts live tokens into
   `ModelsError.cause`. Pi Durable persists `message.errorMessage` (proposal Q4, from `generation.js`). The wrapped
   provider from item 1 should also replace this error. The sentinel test must cover this exact case: a fake token
   endpoint that returns valid tokens with `expires_in: "x"`.
3. **The soak cannot exercise rotation.** The Codex access token lives "about 10 days" (`docs/model-credentials.md:164-166`).
   A four-week soak sees about three refreshes, so "no unexplained relogin" over 28 days is close to no evidence. Replace
   it with a **forced-rotation soak**: a staging override of the refresh margin (pi-ai's `minOAuthValidityMs`,
   `resolve.js:101`) that refreshes about hourly across at least two shards, giving roughly 600 rotations in four weeks.
   Check first that OpenAI tolerates that refresh rate (UNVERIFIED). Keep the four-week calendar soak only as a
   production confidence check.
4. **Lock-wait cancellation and in-process queueing**: see table row 8.

### 2.4 The A / B / C costing

The arithmetic is in table row 7. The structure of the costing matters more:

- **A's 10–14 GitHub days are probably low.** Slice 9 alone needs real-client CA-constraint matrices (git, curl, OpenSSL,
  Node, Python), smuggling tests and a 1 GiB benchmark with four streams. Add the review cycle for a TLS-terminating
  component, which the proposal already lists as extra elapsed time. 12–18 days is more honest.
- **B's 2–4 days assumes an "authenticated bridge endpoint"** that the network forbids (§3.1). The push design is about
  2–3 days: write to a tmpfs file through the existing `env.writeFile`, add a git credential helper that reads the file,
  set `GH_TOKEN` through a wrapper, and revoke at teardown. That is cheaper, but only if the token is kept off the
  workspace PVC, which is the one non-obvious requirement.
- **B also deletes A's migration step 4** (proxy mandatory for repo sessions, a 60-day legacy window) and the
  `route=onecli` concept in the evaluator, which is less work in slice 10. The A − B difference is about 12–16 days, not 8–10.

## 3. Is "A, with B as the cheaper alternative" the right call?

### 3.1 Steelman B

- **The custody benefit of A is narrow.** In both A and B, a hostile sandbox can push arbitrary code, open PRs and read
  the whole repository for the life of the session. Exfiltrating the repository needs no token: `git push` to any host
  the egress rules allow, or the GitHub API itself, will do. A protects only against *off-cluster* use of the token for
  at most 3,600 s after theft, with the same single-repo, `contents`/`pull_requests` scope (`github-app.ts:16-20`).
- **B's window can be cut well below an hour.** Installation tokens cannot be shortened, but they can be revoked
  (`DELETE /installation/token`). Remint every 15 minutes and revoke the previous token after a 5-minute grace. The
  portability window becomes about 20 minutes, plus teardown revocation. Each git HTTP request authenticates when it
  starts, so a grace period covers in-flight pushes. This is UNVERIFIED for very long LFS uploads and must be tested.
- **B removes risk that exists today.** Sandboxes currently trust an *unconstrained* OneCLI CA. B removes MITM trust from
  sandboxes entirely. A only constrains it.
- **B is protocol-transparent.** HTTP/2, `uploads.github.com` (`gh release upload`), `raw.githubusercontent.com` for
  private files, and any tool with a hard-coded GitHub URL all work. Today, and under A, only `github.com` and
  `api.github.com` are injected.
- **B works with `egressProxy.enabled: false`.** Repo sessions survive OneCLI's removal on installs without the proxy.
  A must deprecate them.
- **B keeps the proxy free of secrets** apart from its DB role: no CA key, no repo tokens, no plaintext in a process that
  faces hostile traffic. A proxy RCE under A yields every live repo token its role can read, across all sessions.

The real cost of B: `plan.md:173` ("Neither the orchestrator nor the sandboxes hold real secrets") has to be amended
for GitHub. It already does not hold for the orchestrator, which holds the App key under 0042.

### 3.2 Steelman C (keep OneCLI)

C is zero engineering for a known, working system. Its pain points are bounded. The sign-up hole is closed by the
network alone, the admin key sits only in an already trusted process, and the refresh race (#265) is recoverable and was
never reproduced. For a proof of concept, 6–9 weeks to replace a working component is a large share of the roadmap. C
loses on operational weight (three releases, a bootstrap that depends on observed behaviour, a second Postgres) and on
the upstream dependency for every new provider. Those are real, but they are not urgent.

### 3.3 Option D, which the proposal missed: an explicit injection endpoint (no MITM, no CA)

The proxy serves a **plain reverse-proxy endpoint** for two upstreams, for example
`http://egress-proxy:3129/github/` → `https://github.com/` and `…/api/` → `https://api.github.com/`. Git in the sandbox
uses `url."http://egress-proxy:3129/github/".insteadOf https://github.com/`, through `GIT_CONFIG_*` env, as
`workspace.ts` already does for `http.proxyAuthMethod`. The request carries the egress token, which already travels in
cleartext Basic today. The proxy authenticates principal and pod IP, checks the session's repository binding, injects,
and dials the judged address with verified TLS. Go's `httputil.ReverseProxy` covers most of it.

- **Custody:** the same as A. No portable token in the sandbox, and revocation is proxy-side.
- **Removes:** the CA, name constraints, leaf issuance, client trust distribution, TLS termination of untrusted traffic,
  SNI/Host/authority agreement checks, and A's CA-rotation timeline. Most of A's hostile-parser surface becomes
  `net/http` server code plus path-prefix routing.
- **Costs:** it is not transparent. Anything that dials `https://github.com` directly gets no credential and fails
  closed, which is safe. `gh` needs `GH_HOST` and GHES-style `/api/v3` path mapping, or a small wrapper (UNVERIFIED).
  Git LFS honours `insteadOf` for derived LFS URLs (UNVERIFIED, test it). Submodules work through `insteadOf`.
- **Estimate:** 5–8 days for the GitHub portion, against A's 10–14. Spike `gh` and LFS for one day before committing.

Two more variants deserve a line in the decision record:

- **D2, OneCLI shrunk permanently to the sandbox GitHub route, hardened** (`ONECLI_HOSTS=github.com,api.github.com`, no
  private destinations, no model or MCP secrets). This is a valid *end state* if A, D and B all fail their gates. The
  proposal allows only a temporary shrink.
- **The "helper by default, MITM for high-custody profiles" hybrid**: correctly rejected (two implementations).

### 3.4 My ranking

For this project at this stage: **B (with 15-minute remint and revoke) > D > A > C** on cost-adjusted risk. **D > A**
unconditionally if the owner insists on no portable token. A's only advantage over D is transparency for tools that
ignore git config, and that is not worth a CA in two pods plus TLS termination of hostile traffic. The proposal's "A
unless the product relaxes custody" should become "**B unless the product requires no portable token; then D; A only if
a D spike shows unacceptable client breakage**".

## 4. TCP decision

**CONNECT, no SOCKS5: right for now.** Corrections and additions:

- **Almost no non-HTTP client honours `HTTPS_PROXY`.** `ssh`, `psql`/libpq, `mysql`, `redis-cli`, Kafka clients and
  JDBC drivers all ignore it. Round 1 said these clients "usually ignore SOCKS as well". That overstates it: the JVM's
  `socksProxyHost` covers *all* JVM sockets, JDBC included, and MongoDB drivers and `mongosh` support SOCKS5 natively.
  Name those two as the concrete triggers for revisiting SOCKS5 (`things-go/go-socks5` with our auth and judged dial, as
  the survey says).
- **Use one generic adapter instead of per-client forwarders.** `proxychains-ng` supports `http` (CONNECT) upstreams with
  user and password from a config file (not argv). With `proxy_dns` it sends hostnames to the proxy, which is remote DNS.
  It covers dynamically linked clients, Java included, and **it keeps libpq's `verify-full` working without the
  `host=`/`hostaddr=` trick**, because the client keeps the real hostname. It does not cover static Go binaries, but most
  of those speak HTTP and honour the env. Add it to the SSH/image slice. The token must stay in a 0600 file.
- **Git over SSH: discourage it for repo sessions, and rewrite SSH remotes.** Injection cannot work on SSH, and an SSH key
  in the sandbox is a long-lived portable credential, worse than B. Set `url."https://github.com/".insteadOf
  git@github.com:` (and `ssh://git@github.com/`) in the workspace env, so submodules and SSH remotes use the HTTPS
  credential path. For third-party SSH with user keys, prefer **`ssh.github.com:443`-style endpoints** (survey §6) over
  widening `publicPorts` to 22 install-wide.
- **Half-close.** Accepted correctly. Under §2.2's design, the same `ConnectCopyHandler` owns it. It must forward
  `CloseWrite` through `trackedConn` (cela) and the `TimeoutConn` installed by `ConnectClientConnHandler` (S
  `smokescreen.go:796`). The idle timer must not close the surviving direction while it is still active. Half-close does
  not apply to the inject leg.
- **Limits.** A 1 h maximum age and 10 min idle timeout, documented: fine.

## 5. Remaining risks; are the phasing and kill criteria executable?

Phasing is good: TCP and the orchestrator move are independent of the GitHub decision. Kill criteria are mostly
testable. Problems:

1. **The Codex soak is not a measurement** (§2.3 item 3). Replace it with forced rotation.
2. **"Kill if supported provider transports bypass the guard" will fire on Codex refresh as written** (§2.3 item 1). Say
   in advance that a wrapped OAuth provider counts as hooked, so the gate is not argued after the fact.
3. **The performance gate is good** (400m, 192Mi, 1.25× direct, 1 GiB pack and LFS). Add the A/D comparison on the same
   harness if D is spiked.
4. **Slice 0 decides custody before any data.** That is acceptable as a product decision, but write the fallback chain
   now: A fails → D, or B if the exception is granted → D2 → C. "Otherwise C" skips cheaper options.
5. **Hardened-install regression and the LAN-MCP regression** (§2.1) need explicit acceptance criteria in slice 4:
   rendered-policy tests for the optional `toFQDNs` list and for the private-443 rule with its `except` CIDRs.
6. **Operational risk the proposal does not name:** after removal, model, MCP, GitHub and refresh all depend on
   orchestrator code. That is one fewer moving part, but it is also the first time cela owns provider auth bugs. Budget
   pi-ai upgrade checks (`CredentialStore` and OAuth provider shapes) into ADR 0053-style upgrade notes.

---

## Verdict

**Adopt with changes.** The orchestrator-side move (API keys and MCP first, Codex separately) and the TCP slice are
ready to approve once the changes below are made. Do not approve the GitHub recommendation as written.

## Required changes, ranked

1. **Replace the `ConnectHijack` plan with `ConnectCopyHandler`** (§2.2), with evidence S `smokescreen.go:1033-1063` and
   G `https.go:120-129, 186-189`. One handler for direct half-close and inject termination over the judged, tracked target.
2. **Codex transport and leak:** wrap the `openai-codex` OAuth provider so that refresh uses the guarded fetch and never
   echoes the token response. Add the `expires_in: "x"` sentinel test. Correct the claim that OAuth endpoints already
   use the guarded path (§2.3).
3. **Re-rank GitHub custody:** cost and spike option D (explicit injection endpoint). Add B's missing advantages and its
   15-minute remint/revoke variant. Make the fallback chain explicit (§3).
4. **Fix B's delivery design:** push-based, tmpfs, never the PVC, through the orchestrator → sandboxd bridge. No
   sandbox → orchestrator channel, which `sandbox.yaml` forbids (§3.1).
5. **LAN MCP and keyed LAN providers:** choose (a) or (b) in §2.1 and amend 0040, 0043 and 0056 accordingly. Claim and
   test the DNS-rebinding fix.
6. **Hardened installs:** an optional chart-rendered `toFQDNs` allowlist for orchestrator egress under Cilium. Restate
   the security trade accurately: negligible for open defaults, a regression for hardened installs, and portable model
   keys on orchestrator compromise (§2.1).
7. **Platform addresses in TS:** cost the port of `Platform` (or require `kubeApiCidrs` plus the pod and Service CIDRs)
   so that the guard can block in-cluster targets under the standard-policy fallback.
8. **Shrink the credential store:** Kubernetes Secrets for static API keys and MCP tokens, Postgres only for Codex
   OAuth. Drop the separate key and key-rotation work for static secrets (§2.5 below).
9. **Codex coordination details:** an in-process queue before the DB lock, `lock_timeout` or try-lock polling for
   cancellation, and a forced-rotation soak in place of the calendar soak as the kill gate.
10. **TCP:** add `proxychains-ng` (HTTP CONNECT, config-file credentials), the `insteadOf` rewrite of SSH remotes to HTTPS,
    and the JVM/Mongo SOCKS triggers. Name `ssh.github.com:443` as the alternative to opening port 22.
11. **Re-baseline:** fix the slice arithmetic (30–42 / 22–32 as tabled) and add the items above. Expect about A 38–52 and
    B 26–36 days.
12. **Add an MCP origin-binding invariant test** (§2.1, per-session isolation now enforced only in-process).

### 2.5 (referenced above) Why the encrypted credential store is more than the minimum

API keys and MCP bearer tokens are static. A Secret mounted as a **volume** (not env) in the orchestrator, fed by
ExternalSecret, updates without a restart. RBAC on the Secret is the access control, the key never leaves the cluster,
GitOps works, and e2e can create it with `kubectl`. The catalog's `credentialId` names a key in that Secret, and the
metadata view lists the key names. What this drops: the sealed table for static secrets, its encryption key and
rotation, the import CLI for API keys, and the "no HTTP secret-write API" debate. Only the Codex login, which the
orchestrator must rewrite, needs the Postgres row, the lock and the CAS. The cost is that a catalog edit naming a new
credential needs a Secret update first. The 30 s capability refresh already handles that ordering for OneCLI secret names today.

## Recommendation to the project owner

Approve now, independently of GitHub: the TCP slice, with the half-close fix, `proxychains-ng` and SSH-to-HTTPS remote
rewriting, and the orchestrator move of API-key providers and MCP credentials. Do the latter with Kubernetes Secrets, a
judged-IP undici transport, an optional static Cilium FQDN list for hardened installs, and an explicit decision on LAN
MCP. Do Codex last, with a wrapped OAuth provider and a forced-rotation soak, and keep it on OneCLI until that passes.
For GitHub, do not fund the MITM injector by default. The thing it protects, one hour of off-cluster use of a
single-repo token that the sandbox can already exercise in full, does not justify a CA in the proxy and TLS termination
of hostile traffic in a proof of concept. Choose B with a 15-minute remint-and-revoke cycle and amend `plan.md`'s "no
real secrets in sandboxes" for GitHub. If that principle is non-negotiable, spike the explicit injection endpoint (D)
for one day before considering A. Keep OneCLI running for GitHub and Codex until their replacements pass their gates,
then delete it in one release.
