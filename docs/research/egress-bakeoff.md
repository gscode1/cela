# Egress bake-off: sandbox → egress proxy → OneCLI (2026-11-18)

Last slice of epic #50 (issue #264). It checks how the chain behaves on the cases the epic lists, live, and answers the open
question about OneCLI's GitHub App minting. The decisions it tests are [0034](../decisions/0034-egress-rules.md) to
[0041](../decisions/0041-browser-sandbox.md); the runnable cases are `hack/egress-bakeoff.sh`.

## Result in one table

| # | Case | Verdict |
| - | ---- | ------- |
| 1 | Repo A/B isolation, 45 parallel requests each | Pass. One sharp edge: a `pathPattern` is a prefix glob. |
| 2 | Codex refresh under concurrency | **Not run** (needs a real Codex login). Source reading finds no lock: a risk, issue filed. |
| 3 | HTTP/2 and WebSockets | Pass with a limit: direct route is end to end; the onecli route is HTTP/1.1 only, WebSocket works and is injected. |
| 4 | Upstream certificate rejection | Pass on both routes. |
| 5 | Revocation time | Pass: 0 to 1 s on both replicas (target 10 s); stale proxies close tunnels at 120 s. |
| 6 | Credential echo | Confirmed exposure, inherent to injection. No reasonable mitigation inside the chain beyond scoping. |
| 7 | Redirects | Pass. The credential does not follow; a redirect to a denied host is refused. |

## Set-up and versions

- Throwaway kind cluster `pi-egress`, Cilium (chart 1.20.5), `hack/kind-up.sh --no-expose --cni cilium --build --onecli
  --egress-proxy`. Two proxy replicas. Deleted afterwards.
- OneCLI 2.20.0 (`onecli-api`, `onecli-web`, `onecli-gateway` images, chart `oci://ghcr.io/onecli/charts/onecli` 2.20.0).
  The gateway runs without `GATEWAY_DANGER_ACCEPT_INVALID_CERTS` and `GATEWAY_SKIP_VERIFY_HOSTS` (checked by the script).
- Egress proxy `pi-egress-proxy:0.0.0-f4d13c1`: Go 1.27 (toolchain 1.27.3), Smokescreen `v2.0.0-20261112132816-8ba9b4e488a8`.
- Sandbox client: Node v22.23.5 (the orchestrator image's binary, copied into the workspace; the sandbox image has no curl),
  `hack/egress-bakeoff-probe.mjs`.
- Origins, all public: `httpbingo.org` and `postman-echo.com` (echo the headers they receive, speak h2),
  `echo.websocket.org` (WebSocket echo), `badssl.com` hosts (bad certificates).
- Two sessions, A and B. Each has a OneCLI agent, a sealed binding and session rules (`route=onecli`, or `direct` for the
  comparison). **All credentials are dummy values made up by the script** (`smoke-a-<hex>` and so on). No real credential was
  read or used.

## 1. Repo A/B isolation

- **Method.** A has a generic secret on `httpbingo.org` with `pathPattern /anything/repo-a*`, B one with
  `/anything/repo-b*`, each injecting its own dummy in `X-Smoke-Credential`. Both sandboxes at the same moment sent 45
  parallel requests: 20 to `/anything/repo-a/<i>`, 20 to `/anything/repo-b/<i>`, 5 to `/anything/repo-ab/<i>`. The origin
  echoes the headers it got.
- **Expected.** A's value only on A's `repo-a` paths, B's only on B's `repo-b` paths, never the other's value anywhere.
- **Observed.** All 90 answered 200 (1 s in total). A: 20 of 20 `repo-a` requests carried A's value and nothing else, 20 of 20
  `repo-b` requests carried nothing. B: the mirror image. B's value appears in no response A read, and A's in none B read.
  A's egress token used from B's Pod is refused (407).
- **Verdict. Pass.** Two things to know:
  - `repo-a*` also matched `/anything/repo-ab/…` (5 of 5 got A's value). A `pathPattern` is a prefix glob, not a path
    boundary. We do not use `pathPattern` for repo scope (the orchestrator mints a token limited to one repository, ADR
    0037), so nothing changes. If someone does, the pattern needs the slash: `/owner/repo/*`.
  - The OneCLI path rule is the second fence only. Isolation between sessions rests on the binding: one agent per
    session, sealed per session id (ADR 0037, live checks in `hack/egress-onecli-smoke.sh`).

## 2. Codex refresh under concurrency (not run)

- **Why not.** A live test needs a real Codex `auth.json` (access and refresh token) and spends a real refresh token. The
  brief forbids real credentials.
- **From the source** (OneCLI v2.20.0, read, not run):
  - Refresh of the Codex login (secret type `openai`, `authMode: oauth`) is `refresh_openai_oauth_if_expired`
    (`crates/inject/src/secret_inject.rs`), called from `crates/proxy/src/connect.rs` each time injection rules are built for a
    request. It refreshes when the access token's JWT `exp` is within 300 s, posts the refresh token to
    `auth.openai.com/oauth/token`, then writes the result with a plain `UPDATE secrets SET encrypted_value = …` (no
    compare-and-set).
  - There is **no lock** on this path: no in-process queue, no advisory lock, no re-read. Other OAuth connections (apps) do
    have all three (`crates/context/src/refresh_gate.rs`, `crates/proxy/src/refresh.rs`: a stripe per connection, a Postgres
    advisory lock, a re-read and a compare-and-set, with tests for bursts). The Codex path was not moved onto it.
  - So N concurrent requests that arrive inside the 5-minute window each spend the same refresh token. If OpenAI rotates the
    refresh token on use and treats reuse as theft (the behaviour OneCLI's own comments describe for other providers),
    the second and later exchanges fail or revoke the login. On failure the gateway logs a warning and injects the old token.
  - What narrows it: the window is the last 5 minutes of a token that lives about 10 days, and only requests inside it
    race. With several sessions on one subscription a burst of parallel model calls is exactly that case.
- **Verdict. Unverified, plausible risk.** Issue filed (see "Defects and issues").
- **What a live test needs.** A throwaway Codex login (or a stub of `auth.openai.com` that counts exchanges, pointing the
  gateway at it with a test build), an access token with `exp` less than 300 s ahead, then 20 parallel requests through two
  sessions; count refresh-token exchanges (expected 1, the source says up to 20) and whether the login still works afterwards.

## 3. HTTP/2 and WebSockets

- **Method.** The probe opens a CONNECT through the proxy and a TLS handshake offering `h2` and `http/1.1`, then speaks HTTP/2
  or a WebSocket upgrade itself. Direct route: session B, hosts `postman-echo.com` and `echo.websocket.org`. Onecli route:
  session A, same hosts, each with a dummy secret.

| Check | Direct route | Onecli route |
| ----- | ------------ | ------------ |
| Certificate the client sees | the origin's own | `OneCLI Local Gateway CA` |
| ALPN negotiated | `h2` | `http/1.1` |
| HTTP/2 request | 200 | not possible; an h2-capable client falls back to HTTP/1.1 and the request works, injected |
| `wss://` upgrade, echo of one frame | 101, echoed | 101, echoed |
| Credential on the upgrade request | n/a | injected (gateway log: `WebSocket upgrade … injections_applied: 1`) |

- **Expected.** Direct: end to end, because the proxy only tunnels. Onecli: whatever OneCLI supports.
- **Observed and verdict. Pass, with a limit.** The onecli route is HTTP/1.1 only: OneCLI's TLS server offers `http/1.1`
  only (`crates/ca`, `crates/server`: `alpn_protocols = [http/1.1]`) and its upstream leg is HTTP/1.1. Clients fall back
  transparently. The cost is only HTTP/2 multiplexing on credentialed hosts (Git, MCP, model APIs work). WebSocket
  upgrades are handled by OneCLI's own module and carry the injection.
- **Not shown directly.** No public WebSocket server echoes its handshake headers, so the injection on the upgrade is
  shown by OneCLI's log line (one injection applied), not by the origin. `httpbingo.org` ignores upgrades; OneCLI turned that
  into its own 402 ("upgrade rejected by upstream"), so it cannot be used as a header mirror.
- pi-ai's Codex provider defaults to WebSocket (onecli-spike Q1). This run shows a WebSocket upgrade through the chain works
  for a credentialed host, but not the Codex host itself.

## 4. Upstream certificate rejection

- **Method.** `self-signed.badssl.com`, `expired.badssl.com`, `wrong.host.badssl.com`. Session A (onecli route, with a secret
  so OneCLI terminates TLS) and session B (direct route). The sandbox trusts OneCLI's CA.
- **Expected.** Onecli: OneCLI refuses the upstream and the sandbox never gets the origin's page. Direct: the client itself is shown
  the bad certificate and a verifying client fails.
- **Observed.** Onecli: HTTP 502 for all three; the gateway log says `invalid peer certificate: UnknownIssuer` and
  `certificate expired`. The sandbox got no body from the origin. Direct: the client's handshake shows the origin's own
  certificate with `DEPTH_ZERO_SELF_SIGNED_CERT`, `CERT_HAS_EXPIRED` and `ERR_TLS_CERT_ALTNAME_INVALID`, and a verifying
  fetch fails with those codes.
- **Verdict. Pass on both routes.** OneCLI verifies upstream certificates with the public roots by default; the two env
  switches that turn that off (`GATEWAY_DANGER_ACCEPT_INVALID_CERTS`, `GATEWAY_SKIP_VERIFY_HOSTS`) are not set in the bundled
  chart (the script checks it). That is the point to watch: setting either would let OneCLI accept a bad upstream while the
  sandbox, which only sees OneCLI's own certificate, would not notice.

## 5. Revocation time

- **Method.** `hack/egress-revoke-smoke.sh`, run from the bake-off script: a long response is held open through each of the two
  proxy replicas (the sandbox dials the replica's Pod address), then the rules change. Timed on the sandbox clock and by
  the proxy's `tunnel-revoked` log line.
- **Expected.** Closed within 10 s on every replica (ADR 0039).

| Change | Tunnel ended after | Log reason |
| ------ | ------------------ | ---------- |
| Delete the allow rule (route direct) | 1 s on both replicas | `rule-denied` |
| Delete the session (route direct) | 0 s on both replicas | `principal-revoked` |
| Delete the binding of a `route=onecli` tunnel | 1 s on both replicas | `binding-removed` |
| Postgres stopped (proxies go stale) | 120 s on both replicas (budget 130 s) | `stale` |

- **Verdict. Pass.** 0 to 1 s against a 10 s target; tunnels that the change does not deny keep streaming. This was measured on
  one cluster with the 5 s poll plus NOTIFY: the worst case without NOTIFY is about the poll time (5 s).

## 6. Credential echo

- **Method.** Session A has a dummy secret on `postman-echo.com` (all paths). The sandbox asks `/headers`.
- **Observed.** The response body the sandbox reads contains the injected value. The sandbox's env and workspace listing held
  none of it before the request (only the egress token).
- **Verdict. Exposure confirmed, inherent.** Injection means the credential is on the wire to the origin; an origin that
  reflects request headers (an echo service, a debug endpoint, an error page that prints headers) hands it to whoever asked.
  This is true for any injecting proxy. Mitigations that exist or are reasonable:
  - **Scope.** Inject only for hosts we trust not to reflect headers. `route=onecli` is per host (rules are explicit), and a
    host that echoes is not one to put there. Repo sessions: `github.com` and `api.github.com` only.
  - **Narrow, short-lived credentials.** The repo token is limited to one repository, with fixed permissions, and lives 1 h;
    the OneCLI agent and token die with the session. An exposed value is then worth little and not for long.
  - **`pathPattern`** limits which requests get the value (see case 1), not what comes back.
  - **Not available.** OneCLI 2.20 has no response scrubbing (the gateway forwards bodies as they are; the only redaction in
    the source is for its own logs). Our proxy does not decrypt TLS and must not (ADR 0035). Scrubbing a response in a
    decrypting component would also break signed or compressed bodies. It is not recommended.

## 7. Redirects

- **Method.** `postman-echo.com/redirect-to?url=…` (onecli route, A holds a secret on that host) and
  `httpbingo.org/redirect-to` (A holds a secret on `/redirect-to*`). The client follows or not (`redirect: manual|follow`).
- **Observed.**
  - OneCLI hands the 302 to the client as it is (its HTTP client has `redirect::Policy::none()`); the client's next
    request is a new CONNECT through the proxy, judged again, and a new MITM request, matched again by host and path.
  - From `postman-echo.com` to another credentialed host (`httpbingo.org/headers`): that response carries no credential of
    the first host. Same host, other path (`/redirect-to` to `/headers`): no credential, the path rule is evaluated again.
    B following the same redirect through its own routes: none.
  - A redirect to a denied host (`example.org`): the client's CONNECT is refused with 407. To the cluster
    (`kubernetes.default.svc`): refused. To plain `http://`: the sandbox has no proxy for http and no direct route, so it fails.
- **Verdict. Pass.** The credential is added by OneCLI per request by host and path, never copied into a response or a
  `Location`, so a redirect cannot carry it away. A redirect cannot reach a host the rules deny because every hop is a new CONNECT.
  Note that a redirect to a host that is allowed on the onecli route gets that host's own credential if the session has one; that is by design.

## Open question: could OneCLI's GitHub App minting replace `github-app.ts`?

Read-only analysis of OneCLI v2.20.0 and of `packages/orchestrator/src/github-app.ts`. **No, not as it is.**

- OneCLI mints an installation token in `refresh_github_app_token` (`crates/apps/src/lib.rs`) for a `github_app`
  connection. The request body carries only `repositories` (when the connection pins repos). **It does not pass
  `permissions`**, so the token gets the installation's full permission set. Ours asks for `contents: write`,
  `pull_requests: write`, `metadata: read` on one repository (`TOKEN_PERMISSIONS`). A least-privilege token is a stated
  invariant.
- Per-agent repository scope exists only in the enterprise edition: `crates/ee/.../granular_access/github.rs` enforces an
  agent's `session_policy.repositories` by minting a repo-limited token; the OSS validator rejects session policies
  (`packages/api/src/services/policy-service.ts`, "granular scoping is a OneCLI Cloud capability"). In OSS a connection's
  `repositories` pin applies to the whole connection, not per agent, so one connection per repository per session would
  be needed.
- A `github_app` connection is created through the dashboard OAuth flow (the spike's Q4); there is no documented
  non-interactive path to create one per session, and the orchestrator would still need the App key for the minting
  or the installation id lookup, unless the key moves into OneCLI.
- What would change the answer: OneCLI passing `permissions` and a per-agent repository pin in OSS, plus an API to create
  the connection. Until then `github-app.ts` stays; OneCLI keeps the injection (host and header), which is the seam in
  ADR 0037.

## Defects and issues

- **Fixed in this PR.** `hack/egress-onecli-smoke.sh` step 6 called the proxy's admin endpoint
  (`close-tunnels`, `EGRESS_ADMIN_TOKEN`) that slice 7 removed (ADR 0039). The step only ever printed "not proven". It is
  removed; tunnel closing is covered by `hack/egress-revoke-smoke.sh`.
- **Filed.** Codex refresh in OneCLI has no lock (case 2): #265.
- **No defect found** in the proxy, the bindings or the rules in cases 1, 3 to 5 and 7.

## Not verified, and why

- Codex refresh under concurrency: needs a real login (case 2).
- A real repo clone and push with a GitHub App token: no GitHub App on a throwaway cluster, and no real credentials were used.
- Injection on a WebSocket upgrade seen at the origin: no public origin reflects handshake headers; shown by OneCLI's log.
- Behaviour on gVisor: the kind cluster runs the sandboxes under runc.
- Origins other than the five public hosts above; their behaviour on h2, redirects or WebSockets can differ.
- A multi-node cluster and a OneCLI with more than one gateway replica.

## Repeating it

```sh
hack/kind-up.sh --name pi-egress --no-expose --cni cilium --build --onecli --egress-proxy
hack/egress-bakeoff.sh --name pi-egress            # about 12 minutes; --skip-revoke leaves out case 5
hack/kind-down.sh --name pi-egress
```

The script needs the public internet from the cluster. It prints `ok:` or `FAIL:` per check and keeps going; a failure
that is the origin's (a public echo service that is down) shows up as a failed check, not as a proxy defect.
