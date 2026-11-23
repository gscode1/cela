# OneCLI alternative — revised proposal, round 2

2026-11-23 · Proposer · **Proposal, not an implemented decision**

## Executive summary and recommendation

**Move model and MCP credentials into the trusted orchestrator; retain the existing policy proxy; replace OneCLI’s GitHub path with a narrowly scoped injector only after its custody and feasibility gates pass. Add opaque TCP through CONNECT, not SOCKS5.** Do not build a general-purpose vault or credential-injection gateway.

My recommended final GitHub option is **A: MITM injection**, because it preserves the existing product promise that a sandbox does not receive a portable GitHub credential. That is a custody preference, not a claim that MITM prevents a hostile sandbox from exercising the token’s permissions. **B: a no-MITM credential helper is genuinely smaller, saves roughly two engineer-weeks, and is the better choice if the product accepts a repo-write token becoming portable for up to its remaining one-hour lifetime.** Decide that exception before funding A. Do not ship both implementations by profile. **C: keep OneCLI** remains the default rollback when either the new custody implementation or provider migration fails its gates.

The biggest simplification is outside the Go proxy: no model secrets, MCP secrets, OAuth refresh, secret-management dashboard, or generic header templates belong there. Amend ADR 0040 explicitly: orchestrator model/MCP calls become direct, authenticated in process, through a mandatory TypeScript destination guard and judged-IP transport. They do **not** become sandbox proxy principals. NetworkPolicy permits external HTTPS from this trusted process, with explicit private-provider exceptions; application enforcement becomes the hostname/SSRF boundary. This deliberately changes the old OneCLI chokepoint and must be accepted as such.

Budget **30–45 engineer-days (6–9 weeks), plus independent security review**, for A including TCP, UI/API, migration, tests and removal. B is **22–35 days** on the same scope. These are planning estimates, not measurements. A’s performance, client CA compatibility, complete persistence safety, and Codex operational/legal suitability remain **UNVERIFIED** release gates. Start with API keys and MCP; isolate Codex as a later provider-specific cutover. OneCLI can temporarily serve GitHub or Codex alone without being a permanent second implementation.

## Evidence standard

“Verified” below means source inspection, not a successful integration test. Repo paths refer to this worktree. Running `go env GOMODCACHE` from `packages/egress-proxy` returned `$GOMODCACHE`. The exact inspected module roots are:

- **G**: `$GOMODCACHE/github.com/stripe/goproxy@v0.0.0-20260922184237-948457f542a3`.
- **S**: `$GOMODCACHE/github.com/stripe/smokescreen/v2@v2.0.0-20261112132816-8ba9b4e488a8`.

G/S references below mean files under those exact roots, not current upstream HEAD. The installed Go module versions and the survey are not interchangeable with newer `elazarl/goproxy` releases. No cluster tests, clone benchmarks, or credential imports were performed for this proposal. Claims taken only from the library survey are explicitly labeled **UNVERIFIED independently**.

## Changes from round 1

Each row addresses the corresponding numbered required change in `11-opus-critique-r1.md`.

| # | Disposition | Revision and reason |
|---|---|---|
| 1 | Accepted | Choose guarded, direct orchestrator egress; specify ADR 0040 amendment, chart changes and shared TS/Go address vectors below. No FQDN-policy controller or orchestrator policy-write privileges. |
| 2 | Accepted | Distinguish authorization epoch from token generation. Read current token per request; routine remint never closes an active transfer. Removal/revocation still closes connections. |
| 3 | Accepted with qualification | Operator-created constrained CA Secret; independent ECDSA leaf keys, short validity, issuance audit. DNS constraints for `github.com` permit its descendants, not just two exact names. Exact-host enforcement remains mandatory; client constraint enforcement is a test gate. |
| 4 | Accepted | Cite actual stock transport, hook ordering, inner-header and connection-close behavior. Do not use stock `ConnectMitm` or `signHost`. These are hazards of enabling that path, not proof the current CONNECT-only proxy leaks secrets. |
| 5 | Accepted | Cost B fairly, quantify token portability, and reject the “hostile sandbox can invoke the helper” dismissal. It can already invoke authenticated GitHub operations through A. |
| 6 | Accepted | Custody decision first; API-key/MCP migration before MITM; Codex independent. No simultaneous fallback between two stores for one operation. |
| 7 | Accepted, corrected scope | Budget 6–9 weeks and 4–6 removal days. Include admin-ui/ingest/e2e/schema/docs. The verified 297 tracked OneCLI-reference files are a search inventory, not 297 mandatory edits. Profiles reference MCP names, not a per-profile `onecliSecret` field. |
| 8 | Accepted intent; reject redundant lease | Specify a checked-out `pg.Pool` client and bounded transaction lock around refresh, reread/CAS, invalidation, import margin and login retirement. A separate expiring lease is unnecessary for this lock-held design and would add another ownership clock. SDK-initiated refresh is allowed only through the coordinated store. |
| 9 | Accepted | Add sentinel persistence/API/log checks, GitHub permission regression tests, actual CA-client constraints tests and direct TCP half-close tests. Source inspection alone does not establish these invariants. |
| 10 | Accepted | `ConnectCopyHandler` with wrapper-aware half-close, documented one-hour/ten-minute limits, separate SSH image slice; `publicPorts` is install-wide. |
| 11 | Accepted | Import CLI runs inside orchestrator via `kubectl exec -i`; list-only metadata replaces hints/pickers. No encryption-key export to operator laptops and no new secret-write HTTP API. |

### Where the critique is right, and where it overstates the facts

1. **Stock MITM is not a safe switch to turn on.** G `proxy.go:253` creates `http.Transport{TLSClientConfig: tlsClientSkipVerify, Proxy: http.ProxyFromEnvironment}`; G `certs.go:18` sets `InsecureSkipVerify: true`. S `pkg/smokescreen/smokescreen.go:724–735` only tunes pooling; it does not correct those defaults. G `https.go:306` runs `MitmMutateRequest` before the request filter at `:318`, where Smokescreen rechecks the inner destination. S `pkg/smokescreen/smokescreen.go:1380` reads `X-Upstream-Https-Proxy` on that inner request. G `https.go:350` writes `Connection: close`; the loop is not a usable WebSocket upgrade relay. The current outer-header stripping in `packages/egress-proxy/internal/egress/proxy.go` would not sanitize future decrypted requests. The current decider rejects MITM (`a.ConnectReq != nil || a.Req == nil`), so these are integration constraints, not an exploit demonstration against today’s direct tunnels.
2. **Do not reuse the signer, but describe it accurately.** G `signer.go:14–72` generates a fresh RSA-2048 leaf key using `crypto/rand`, not the CA private key. Its validity is Unix epoch through `2049-12-31`. G `https.go:31` already has a 4096-entry cache bound. Round 2 rejects the long-lived signer, not a fictional unbounded cache or deterministic key defect in this fork.
3. **Half-close concern is real.** G `https.go:187–223` exposes `ConnectCopyHandler`, then uses a concrete `*net.TCPConn` fast path; wrapped connections fall into the less capable copy path. S `pkg/smokescreen/smokescreen.go:797` wraps the client in `TimeoutConn`; cela also has `trackedConn` and `handshakeConn` wrappers. A structural `CloseWrite` check alone is insufficient unless wrappers delegate it.
4. **Remint is not a periodic timer.** `packages/orchestrator/src/repo-access.ts:29` sets a ten-minute before-use margin; `beforeUse` remints on use when needed. It does not guarantee rotation every fifty minutes. Updating the OneCLI secret preserves the agent token; proxy authorization currently judges that agent-token hash, not each GitHub token generation. Round 1’s close-on-every-generation rule was a regression. The existing one-hour tunnel cap can still end a long transfer independently of remint.
5. **Orchestrator network access is not exclusively OneCLI plus GitHub.** ADR 0056 and `charts/cela/templates/networkpolicy/orchestrator.yaml:62` already allow configured direct keyless providers. Standard policy also has a broad 443/6443 fallback without `kubeApiCidrs` at `:73`. Cilium and standard policy must both be reviewed; neither existing policy is evidence for a universal hostname boundary.
6. **B removes repository-token/CA custody from the proxy, not literally every secret.** The proxy still has a database reader credential. B also needs an authenticated transport over the sandbox bridge; an unexamined plaintext token endpoint is not free security.
7. **GitHub permissions reduce risk, not prove absence of echo.** `packages/orchestrator/src/github-app.ts:16–20` asks for `contents:write`, `pull_requests:write`, `metadata:read`; minting scopes `repositories: [name]` and checks the returned repository list. Lack of `workflows` permission is useful but does not prove that every reachable GitHub endpoint or existing workflow cannot disclose useful data or credentials.

## Q1 — Inventory and minimum ownership

| Current OneCLI function | Needed? | Replacement owner and minimum behavior |
|---|---|---|
| (a) Sandbox GitHub injection | Repo operations need authentication; MITM is a custody choice | A: Go proxy owns only fixed GitHub HTTPS injection; orchestrator mints one-repository installation tokens. B instead delivers those tokens to the session helper. |
| (b) Model keys and Codex OAuth | Yes where configured | Orchestrator credential store plus pi-ai auth integration. API keys first; serialized Codex refresh later. No model credentials in sandbox or proxy. |
| (c) Credentialed MCP | Yes | Orchestrator attaches configured bearer/API-key headers to the exact catalog origin, preserving per-session profile selection and discovery authorization. |
| (d) Custom OpenAI-compatible providers | Yes | Orchestrator; keyed HTTPS exact origins and chart-only keyless LAN exceptions from ADR 0056. No accidental removal of the latter. |
| (e) OneCLI host-rule reconciler | Its authorization purpose is needed; its OneCLI implementation is not | Catalog/profile checks and guarded fetch in orchestrator replace the reconciler. Sandbox egress rules remain separate and never inherit MCP grants. |
| (f) Encrypted storage, dashboard, CA | Storage/import yes; full dashboard no; CA only for A | Session-core owns credential schema, orchestrator reads/decrypts/writes; in-cluster import CLI and metadata-only UI. CA signer only in A’s proxy pods. |

Resolve the plan/AGENT tension in favor of the actual trust boundary: model credentials may live in the trusted orchestrator and must never reach sandboxes. Update `plan.md`’s “everything through OneCLI” statement when implemented. A retains the stronger GitHub no-portable-token promise; B requires an explicit documented GitHub-only exception. Neither moves provider secrets into the Go proxy.

## Orchestrator egress decision — explicit amendment to ADR 0040

**Replace ADR 0040’s orchestrator → OneCLI credentialed path with orchestrator → approved origin using guarded direct transport. Retain its sandbox-only proxy boundary.** This is the selected design, not an unresolved menu.

- Use existing `undici` **8.12.4** (`packages/orchestrator/package.json`) with an application-owned dispatcher/connector and fetch, replacing the `ProxyAgent` path in `packages/orchestrator/src/onecli.ts`. Provider registration already supplies fetch overrides; MCP transport already accepts fetch (`packages/orchestrator/src/mcp.ts`). Confirm every supported provider and OAuth refresh transport uses the guard; any unhookable SDK path blocks that provider’s migration.
- For each request, validate scheme, exact normalized origin and port, and credential selection before adding auth. No userinfo, ambiguous authorities, arbitrary URL overrides, or automatic redirect following. A redirect is an error, not a chance to forward the credential. Built-in model/auth endpoints are operator-approved constants; custom endpoints remain chart-owned. MCP access remains the intersection of the session’s profile snapshot and the live catalog. Server discovery grants only the selected catalog server, not arbitrary URLs.
- Resolve **all** A/AAAA results and apply the ADR 0034 address-tier rules. Reject mixed public/blocked answers, loopback, link-local/metadata, platform service addresses, kube API and Postgres. Private exceptions require an exact configured origin plus allowed CIDR and port; they never override immutable platform blocks. Normalize IPv4-mapped IPv6 and reject alternate IP spellings consistently.
- Dial an address from that judged set without a second DNS lookup. Preserve hostname for SNI and certificate verification. A pre-fetch DNS check followed by ordinary global `fetch` is not sufficient. Pool connections by authorized origin/config generation; close idle pools on catalog removal or guard changes, cancel affected active requests on authorization revocation, and rejudge new requests rather than allowing an old pool to bypass policy. OAuth token endpoints use this same path.
- Reuse the existing TS evaluator/address classification where possible, extending shared TS/Go vectors for these address cases. Share address semantics, not sandbox grants: the orchestrator is not allowed to impersonate an arbitrary session principal.
- Helm permits public TCP/443 for external model/MCP calls from orchestrator, plus explicit chart-defined private/custom ports. Preserve required DB, DNS and kube API routes as separate platform dependencies; tighten the avoidable standard-policy kube API fallback when addresses are configured. Update both standard NetworkPolicy and Cilium templates. No catalog-driven Cilium reconciler and no new policy-write RBAC.

**Security trade:** broad external HTTPS means a fully compromised orchestrator can bypass the in-process guard. This was already a highly trusted process with GitHub App/admin keys, but losing an external destination chokepoint is a real delta. The guard protects normal code against hostile catalog/DNS/redirect inputs, not arbitrary code execution. If an independently enforced hostname boundary for orchestrator RCE is required, reject this choice and retain OneCLI pending a separately costed no-MITM orchestrator-proxy principal. Do not quietly add that second identity system here.

## Q2 — Narrow GitHub injection for option A

### Route and authorization

Add `route=inject` with **only** `github.com:443` and `api.github.com:443`, exact names, no wildcards, no IP literals, no operator-defined header templates. The schema validator rejects any other inject destination. Existing `route=direct` remains opaque CONNECT, including other GitHub download/CDN origins when separately authorized.

Keep the present principal token + pod-IP binding, fail-closed snapshots, evaluator, all-IP classification, judged-IP dialing and registry revocation. A session’s allowed hostname is not enough: `inject` also requires its live repository binding and authorization epoch. Missing/expired credential fails closed; never silently turn inject into direct.

Use the fork’s authorized CONNECT hijack hook, not `ConnectMitm`. G’s hijack path sends the 200 before the callback, so rejection requiring an HTTP error must happen before that point. Preserve already-buffered bytes when handing the accepted connection to TLS. The adapter must integrate with registry ownership and cancellation, not create untracked sockets. `packages/egress-proxy/internal/egress/proxy.go:95–139` currently saves Smokescreen’s transport dialer and installs `p.dial` for CONNECT; a new plain `http.Transport` would bypass that composition unless deliberately wired back into the same judged-address and tracking logic.

### HTTP boundary

Terminate sandbox TLS using `crypto/tls`; serve HTTP/1.1 with `net/http` rather than a handwritten framing parser. Only ALPN `http/1.1`; no h2/h2c or WebSocket/101 support on inject. Direct tunnels are unaffected and may carry h2 or arbitrary end-to-end TLS.

On **every** inner request:

1. Require SNI, CONNECT authority, URL authority (if present) and Host to agree with the single authorized exact hostname/port. Reject nested CONNECT, upgrades, ambiguous/duplicate authority, invalid framing and cross-authority absolute-form requests. Enforce header limits, timeouts and cancellation.
2. Recheck current principal/rule/route/binding authorization. Use the current token generation for this request, not the token captured when CONNECT opened. Recheck the destination/IP judgment when dialing; no client-selected upstream proxy, environment proxy, or hidden DNS retry.
3. Remove `X-Upstream-Https-Proxy`, `Proxy-Authorization`, forwarding controls and hop-by-hop headers, including headers named by `Connection`. Strip the client `Authorization` and set exactly one outbound value **after** authorization: `Basic base64("x-access-token:" + token)` for `github.com`; `Bearer <token>` for `api.github.com`. Always-set is intentional: `GH_TOKEN` remains a dummy value; a user-supplied PAT is overwritten, not honored. Document that behavior prominently.
4. Stream bodies unchanged with bounded buffers. Do not log request/response headers, payloads, auth errors containing raw upstream bodies, or Git URLs with credentials. Do not follow redirects server-side; a returned redirect must undergo a fresh authorization/injection decision if the client follows it. Injection never broadens to the redirect target.

Use an explicit upstream `http.Transport`: `Proxy: nil`, verification enabled with system public roots, original hostname as `ServerName`, HTTP/1.1, a dialer restricted to the judged address set, and no sandbox CA in upstream roots. Retain keep-alive on both legs. Scope reusable transports/connections to the authorized tunnel/session and origin to avoid cross-session context reuse; close them on revocation and bounded shutdown. Response handling strips hop-by-hop headers and rejects 101 instead of accidentally treating it as an ordinary body. The prototype must prove request smuggling resistance and keep-alive behavior; source design is not proof.

### CA and leaves

An operator creates a Kubernetes Secret holding a dedicated, name-constrained injection CA and key. Mount the private key **only in proxy pods**; distribute only public trust to sandboxes. No chart-embedded key, automatic fallback CA, shared OneCLI key, or signer in orchestrator/ingest. Validate CA constraints and expiry at startup; fail closed if invalid.

Use Go `crypto/x509`, `crypto/ecdsa`, `crypto/rand`: fresh P-256 leaf keys, random positive serials, ServerAuth only, non-CA leaves, one exact DNS SAN, five-minute clock-skew allowance, at most 24-hour lifetime bounded by issuer expiry. Cache at most the two supported host leaves per active CA generation and replace before expiry. Log issuance serial, host, generation and expiry, never key material or request payload.

The CA has critical permitted DNS constraints for `github.com` and `api.github.com`. **These encode DNS subtrees, not an exact two-name ACL; `github.com` already encompasses the second entry.** Reject all other names in signer and route code regardless. Do not assume every TLS implementation enforces a root’s constraints identically. Test Go, actual sandbox git/curl/OpenSSL and Node trust paths with an unrelated-name leaf and allowed-name leaves. If the trust-anchor approach fails client enforcement, A fails its CA gate pending a reviewed PKI redesign; do not claim a merely decorative extension is a security control. A compromised signer still has greater authority than the intended route set.

## Q3 — Custody, storage, imports and refresh

### Data ownership

Use session-core migrations and validation, matching ADR 0037’s ownership pattern:

- An orchestrator-only encrypted credential store records `id`, kind, exact allowed origins/provider identity, sealed secret, key version, credential version, expiry/status and timestamps. The proxy DB role cannot select it; ingest can expose a metadata-only view, not ciphertext/plaintext. Model/MCP encryption key is separate from repository-binding encryption and is mounted only in orchestrator.
- For A, a repository-binding row records session/principal association, repository identity, authorization epoch, token generation, expiry, key version and sealed installation token. Orchestrator is the only writer. Proxy can read/decrypt these rows and remains read-only except existing `proxy_status` writes. Use AES-256-GCM with fresh nonces and versioned AAD binding session, repository and record purpose; do not reuse ADR 0037’s old OneCLI-agent-token payload without migration.
- Authorization changes bump the policy/revocation revision; token replacement bumps credential generation only. The existing `027_egress_bindings.sql` trigger does not supply this distinction automatically. Notify replicas, reread as necessary, and retain fail-closed snapshot-age limits; notifications are hints, not sole correctness mechanisms.
- For B, no proxy-readable repository-token table/key is needed. Orchestrator still needs token state for minting and revocation. Remove the old OneCLI seal-key mount from proxy after migration, not before old sessions drain.

Plaintext exists transiently in the orchestrator and, for A, proxy memory/outbound auth headers; Go/JS cannot promise perfect heap erasure. No secret in session config, model descriptors, durable stream settings, UI metadata, proxy status or logs. A proxy RCE exposes mounted CA/key and all repository bindings its DB role can read, not just one session; it must not expose model/MCP credentials.

### Operator entry and metadata UX

Import with an in-cluster command, for example:

```sh
kubectl exec -i deploy/pi-orchestrator -- cela-credentials import --kind api-key < key.json
```

The CLI validates a bounded schema, origin/provider pairing and secret kind, seals inside the cluster, and writes through the schema owner’s code. Input is stdin, not argv or shell history; no payload echo on error. `pods/exec` is privileged RBAC, not a general end-user credential API. Do not export the credential encryption key to a laptop or mount it in ingest.

Replace `packages/orchestrator/src/capabilities.ts` secret discovery and ingest capability routes with ID/display-name/kind/allowed-origin/configured-or-expired metadata. Admin-ui MCP pickers choose `credentialId`; console hints show only compatible configured providers. No secret-length suffixes, ciphertext, refresh tokens or access tokens in these responses. Full secret editing dashboard is intentionally omitted.

### Codex refresh: concrete coordination, no SDK fork assumed

`packages/orchestrator/package.json` pins pi-ai **1.6.0**. I inspected its published version-specific sources:

- `https://unpkg.com/@earendil-works/pi-ai@1.6.0/dist/auth/types.d.ts`: `CredentialStore.modify(providerId, fn, options)` is the async serialized read-modify-write seam.
- `https://unpkg.com/@earendil-works/pi-ai@1.6.0/dist/auth/resolve.js`: `refreshStoredOAuthCredential` calls `credentials.modify`, rereads/checks freshness inside it, calls provider OAuth refresh with a 15-second timeout, then returns the updated credential to store. The default margin is five minutes. Cancellation can stop waiting; once refresh starts it completes the protected operation.

**Correction to round 1:** pi-ai may initiate refresh; it must not refresh outside our store’s coordination. There is no need to forbid the SDK’s existing refresh code or fork it merely to get a hook.

Implement the store’s `modify` using one dedicated checked-out `pg.Pool` client for `BEGIN`, a transaction-scoped advisory lock keyed by stable credential ID, decrypt/reread, callback, version-checked update and `COMMIT`; rollback/release in `finally`. Never acquire a session lock with one `pool.query` and unlock on another pooled connection. All import, delete, manual refresh and resolver writes use the same lock. Keep provider timeout at 15 seconds and bound the overall operation (proposed 30 seconds); constrain refresh concurrency so waiting refreshes cannot exhaust the general DB pool. The transaction intentionally spans the provider request; that is the modest cost of simple cross-replica ownership.

**No lease column** in this design: the DB lock is held until commit/rollback or connection death. CAS protects against accidental stale writers; it does not replace the lock. If we later release the DB connection during refresh, then a fenced owner/lease is required, with an expiry exceeding refresh timeout and a CAS-protected commit. Do not implement both ownership mechanisms now.

Do not cache reusable refresh tokens outside the store. Read current version on resolve; invalidation notifications evict any access-token cache across shards, and every `modify` rereads under lock even if notifications were lost. Only the current committed version is handed to a new request. Already-started API calls may finish with their previous access token.

There is an unavoidable **provider-rotated-token / DB-commit crash window**. A Postgres lock cannot make an external refresh atomic. Do not blindly retry a spent refresh token; mark the credential `reauth_required` on unrecoverable `invalid_grant`, cancel new usage, and show a metadata-only operator alert. Provider grace/reuse behavior is **UNVERIFIED**; test it, do not promise recovery.

Import OAuth only from a dedicated login that will no longer be used by the local CLI. Reject access-token expiry within **ten minutes** (greater than pi-ai’s default five-minute refresh margin). Pause consumers, import securely, archive/delete the local credential file and stop all local background users without invoking a logout that could revoke the imported grant. Treat reuse of that login elsewhere as unsupported; it recreates a refresh race outside our lock.

## Q4 — Security delta and mandatory tests

Removing OneCLI removes its management sign-up surface, account-admin agent-token listing and separate service/DB/bootstrap deployment from the final topology. Those gains arrive fully only when its last workload and credentials are removed. Source status of the survey’s OneCLI HEAD distributed-refresh fix versus bundled **v2.20.0** is **UNVERIFIED independently**; do not justify replacement by assuming an upstream bug remains unfixed everywhere.

A adds a CA signer and HTTP/TLS parser to a process facing hostile sandbox traffic. B avoids that but makes repo credentials portable. Both centralize model/MCP custody in an already trusted orchestrator and require new persistence/SSRF tests. Neither stops allowed repository writes, destructive API operations within scope, or credential echo by an authorized service. Do not log arbitrary provider exception objects and call that redaction.

Release-blocking invariants:

- Principal token plus pod IP; unknown/stale/deleted sessions deny. Wrong-session repository binding never injects; binding substitution fails AEAD. Rule, route and principal revocation close active tunnels; ordinary remint does not. Push crossing remint completes, subject to independent age limits.
- Mixed A/AAAA answers, rebinding, mapped IPs, metadata, kube API and DB destinations deny in Go and TS vectors. Direct and injected connections dial only judged IPs; environment proxy variables and inner `X-Upstream-Https-Proxy` cannot change the path.
- CONNECT/Host/SNI/absolute URL mismatch; duplicate authority/auth; `Connection: Authorization`; CL/TE ambiguity; malformed chunking; nested CONNECT; 101/h2c; slow headers; disconnect during upload; upstream TLS wrong-name/untrusted/expired certificates; redirect to a forbidden origin. No credential forwarded on any rejection.
- Sentinel secrets absent from **all `pi.*` storage**, orchestrator/proxy/ingest logs, telemetry, status and API/UI responses on success, provider error, retry, crash/restart, compaction, MCP failure, import failure and cancellation. Include plaintext, Basic/base64 encoding and known structured error forms. Authenticated HTTP wire observation is the intentional exception, not durable storage.
- Two replicas refresh concurrently: exactly one provider refresh, second rereads current row; pool connection churn cannot escape the lock; dropped invalidation still gives correct refresh state. Crash after provider rotation exercises `reauth_required`, not silent looping.
- Mint request/returned permissions remain repo-scoped and never add `workflows`, `administration` or `secrets`; no wildcard repositories. This is regression protection, not proof of no credential echo.
- CA constraint enforcement in real clients, fresh independent leaf keys, issuer expiry, cache invalidation and rotation. Sandbox has public trust only; no provider keys or CA private key.
- Direct TCP FIN in each direction preserves the opposite stream; half-close survives every wrapper. Revocation/idle/max-age still interrupts both directions. NetworkPolicy default ports still deny undeclared ports.

### What Pi Durable persistence inspection actually established

Pinned `pi-durable@1.6.0/dist/harness/generation.js` checkpoints `streamOptions: settings.stream` and persists assistant messages/error text (`appendAssistant`, `message.errorMessage`); `dist/harness/provider.js` persists a provider session ID, not a credential. The inspected path does not explicitly serialize a runtime auth-store object or HTTP request headers. **That is not a full non-persistence guarantee**: placing auth in stream settings or allowing raw provider errors into messages can persist it.

The pinned adapter `@gscode1/pi-durable-postgres@0.4.0/dist/migrations.js` defines generic JSON-text storage in `conversations.record`, `entries.record`, `tasks.record`, `submissions.record`, `documents.record` and `document_revisions.content` (under the app’s `pi` schema). Therefore scan all these, not a mythical dedicated request-header table. Source URLs are `https://unpkg.com/@earendil-works/pi-durable@1.6.0/dist/harness/generation.js`, `https://unpkg.com/@earendil-works/pi-durable@1.6.0/dist/harness/provider.js`, and `https://unpkg.com/@gscode1/pi-durable-postgres@0.4.0/dist/migrations.js`. Complete provider, compaction and telemetry persistence safety remains **UNVERIFIED** until sentinel tests pass.

## Q5 — TCP decision

**Ship CONNECT TCP with explicit ports; do not ship SOCKS5, UDP, transparent capture or raw-TCP credential injection.** Remote DNS already occurs at the proxy for CONNECT. Clients ignoring proxy environment variables need a CONNECT-aware adapter, not necessarily another listener.

- Keep rule `ports`; no new arbitrary TCP rule language. An operator may widen `egressProxy.publicPorts` beyond `[80,443]`, for example to 22. This expands the **install-wide network-layer ceiling**, not any session’s allowlist. The evaluator still gates each session/destination/port. Private destinations also need existing private-egress network settings and explicit permitted CIDRs; platform blocks remain immutable.
- Install a `ConnectCopyHandler` that preserves bidirectional half-close. Add forwarding `CloseWrite` behavior through our wrappers and address Smokescreen’s timeout wrapper deliberately; do not downcast a wrapped `net.Conn` to `*net.TCPConn`. Track cancellation and drain the surviving direction without leaking goroutines.
- Current defaults are `EGRESS_MAX_TUNNEL_AGE=1h` and `EGRESS_IDLE_TIMEOUT=10m` (`packages/egress-proxy/cmd/egress-proxy/main.go:44–48`). Keep them install-wide in this revision. SSH keepalives below ten minutes prevent idle closure, not the age cutoff; DB/SSH clients must reconnect at one hour. No per-rule max-age schema until a real workload requires it.
- A separate image slice explicitly installs `openssh-client` and a small reviewed CONNECT helper reading credentials from environment/file, never argv. `images/sandbox/Dockerfile` does not explicitly install SSH/socat/nc; actual transitive binary presence is **UNVERIFIED**, so do not rely on it. Test `ProxyCommand`, signal handling and no token in `ps`/logs.
- A DB local forwarder must preserve TLS hostname verification: libpq can use `host=db.example` with `hostaddr=127.0.0.1` and the forwarded port. Do not recommend disabling `verify-full`. Other clients need equivalent hostname control or are unsupported through that forwarder.

Unsupported opaque protocols remain operator-managed direct-mode workloads where appropriate; direct mode is not a new guarantee of UDP policy enforcement. No SOCKS credentials or secondary auth listener now.

## Q6 — Fair costs, rollout, deletion and kill criteria

### A / B / C comparison

All effort includes the same API-key/MCP/Codex/UI/migration work for A/B. Costs assume one experienced engineer, existing Postgres/undici, no new external PKI platform; independent security review and waiting for an OAuth soak are additional elapsed time.

| Dimension | A: GitHub MITM | B: no-MITM helper | C: keep OneCLI |
|---|---|---|---|
| Estimated implementation | **30–45 days** total; GitHub/CA portion 10–14 | **22–35 days** total; GitHub helper portion 2–4 | 0 days to leave unchanged; TCP/SSH still 3–4 days; roughly 3–5 days to recheck/harden deployment/refresh release is an estimate, not feature parity |
| Sandbox GitHub token | No intentional plaintext delivery; echo remains possible | Intentionally readable/portable by sandbox | Existing injection custody, with known observed echo limitation |
| Proxy custody | CA, repo-binding key and repo tokens; no model/MCP keys | No CA/repo-token key; still DB credentials | Existing sealed OneCLI binding/agent credentials; OneCLI holds provider/repo secrets |
| Orchestrator custody | Direct provider credentials + GitHub App key | Same | Existing OneCLI admin/agent credentials + GitHub App key; credential blast radius is already substantial |
| Operational removal | OneCLI service, DB, three releases/bootstrap; add CA rotation | Same removal; no replacement CA | No migration; retain service/DB/bootstrap/admin API and operational coupling |
| Protocols | GitHub injection HTTP/1.1; opaque CONNECT unrestricted by that limit | End-to-end GitHub TLS/h2 where client/server support | Existing MITM HTTP/1.1 behavior from repository bakeoff; current internals not independently re-audited |
| Ongoing cost | Own parser integration, CA, revocation, store and SDK upgrades | Own helper lifecycle, revocation, store and SDK upgrades | Upstream upgrades/verification and account/agent reconciliation; no new custom injector |

B uses a session-authenticated orchestrator endpoint behind the existing sandboxd bridge. Bind the request to the session’s pod/capability, not a caller-supplied session ID; authenticate/encrypt token delivery across pods and verify bridge authorization before implementation. Do not add a general token-exchange endpoint on public ingest. Git’s credential helper obtains the current installation token on demand; `gh` needs a wrapper or environment handoff because it does not use git’s helper. Keep tokens out of git config/URLs/durable tool definitions and revoke all issued session tokens on teardown where possible. A file implementation is smaller but makes disk persistence and cleanup explicit; it is not stronger custody.

**Quantified portability:** while alive, both A and B let the hostile sandbox perform every permitted operation through its session. If a B token is stolen just after mint, an external attacker can use it for up to **3,600 seconds**, bounded by expiry or successful GitHub revocation, even after network isolation of the pod. At a proposed 60-second teardown-revocation target, normal residual use is at most about a minute after detected teardown; that is a target, not a guarantee during outages, and detection itself is unbounded. Routine remint must not revoke an old token that an in-flight client still uses; retain its revocation handle until expiry. A denies this portable-token channel absent echo or proxy compromise and lets our proxy revoke the session path without depending on GitHub. It does not reduce the permissions of requests made before revocation. That narrower custody benefit is what must justify A’s extra cost and CA exposure.

GitHub token expiry/revocation semantics are established in the critique/research, not independently exercised here; reliable teardown revocation and the actual residual-use bounds are **UNVERIFIED operationally**.

### Reviewable slices

Each row is a separate tested PR; split a row only if review size demands it. Ranges total 30–45 days for A. Decision/benchmark work is included, not hidden as free research.

| Slice | Days | Deliverable and acceptance / kill criterion |
|---|---:|---|
| 0. Custody and architecture decision | 1 | Record A versus B and ADR 0040 amendment; accept direct-egress/RCE boundary. If portable GitHub tokens are acceptable, choose B before writing a signer. If neither boundary is acceptable, keep C. |
| 1. TCP core | 2–3 | Wrapper-aware half-close, tests, port/network examples, age/idle docs. Keep default public ports unchanged. |
| 2. SSH image/client | 1 | Explicit SSH package + CONNECT helper and integration tests. No argv token. Independently useful with C. |
| 3. Credential schema/import | 2–3 | Encrypted store, DB roles, metadata view, stdin CLI, migration tests and key-rotation support. No HTTP secret-write endpoint. |
| 4. Guarded orchestrator egress | 3–4 | TS judged-IP connector, shared vectors, NetworkPolicy/Cilium changes and redirect tests. Kill direct migration if supported provider transports bypass it, or if the only solution requires an orchestrator Cilium-policy writer. |
| 5. API keys + MCP + metadata UI/API | 4–6 | Model/MCP/custom providers, catalog authorization, credential pickers/hints, ingest compatibility, sentinels. No new credential leaves orchestrator. |
| 6. Codex separately | 3–4 | pi-ai coordinated store, concurrency/crash tests, dedicated-login import and reauth UX. Gate on transport hook, permitted usage and operational recovery; retain Codex on OneCLI if technical gate fails, disable if policy requires it. |
| 7. A feasibility spike | 3–4 | Narrow HTTP/1.1 adapter, CA constraints/client matrix, kept-alive push across remint, git/LFS/gh and hostile request tests, benchmark. Stop A rather than grow a general proxy if it needs h2/WS/general templates. |
| 8. A production binding/rotation | 4–6 | Revocation epochs, live token lookup, key/CA rollover, trust delivery, tracking and stale-state failures. No routine-remint disconnect. |
| 9. A end-to-end gate | 3–4 | Real repository transfers, persistence/log/API sentinel sweeps, outages and rollback rehearsal, compatibility matrix. Independent security review before cutover. |
| 10. Drain/remove/document | 4–6 | Session/catalog migration, replace phase scripts/e2e, remove deployments/admin client/reconciler, restore tests/docs and rollback runbook. |

B replaces slices 7–9 (10–14 days) with a 2–4 day authenticated bridge/helper/gh/revocation slice, giving 22–35 days. That estimate is contingent on the existing bridge supporting authenticated token delivery; if not, recost it rather than pretending a new secure channel is free. Codex’s soak adds elapsed time: require **four weeks** of multi-replica use with no unexplained rotation-induced manual relogin. Fault-injection of the unavoidable crash window may require relogin and is evaluated for correct fail-closed recovery, not counted as an unexplained incident. More than one unexplained rotation loss in that four-week window blocks cutover.

### Performance gate, not fabricated results

Current proxy limits are **500m CPU / 256Mi memory** (`charts/cela/values.yaml:334`). CPU-seconds per GiB, peak RSS, handshake count, p95 latency and throughput are **UNVERIFIED**. Benchmark a reproducible private test repository whose clone transfers **1 GiB of measured pack bytes**, plus a 1 GiB LFS object and pushes spanning a forced remint. Record commit/object identifiers and actual bytes in the benchmark artifact; “1 GiB working tree” is not a transfer-size definition.

Compare direct CONNECT, current OneCLI and A at the same limits, warm/cold CA and upstream pools, one and four concurrent transfers. Record total proxy CPU-seconds divided by transferred GiB, peak RSS, throttling, both-leg handshakes and elapsed time. Proposed A gate: on the single-stream 1 GiB case, mean CPU ≤ **400m** (80% of limit), RSS ≤ **192Mi**, and transfer time ≤ **1.25×** direct CONNECT on the same network. At four streams require no OOM, bounded buffering and no correctness failure; report throughput rather than hiding overload. A cannot meet its gate by raising limits without a new cost decision. Measure handshake counts and require actual reuse across repeated same-origin requests. Reject A if keep-alive/remint fails, constraints fail, or performance exceeds the budget; choose B only with its explicit custody exception, otherwise C.

### Migration and proxy-disabled installs

1. Add credential metadata/schema and import command without changing traffic. Operators re-enter API keys and establish dedicated OAuth logins; do not claim OneCLI can export plaintext secrets. Operator supplies an explicit old-secret-name → new-credential-ID mapping. Validate kind and exact origins; unresolved entries block that catalog/provider cutover.
2. Migrate MCP catalog `onecliSecret` to `credentialId`. Profiles’ `mcpServers: string[]` remain catalog names (`packages/session-core/src/profiles.ts:93`); validate referenced names and preserve profile snapshots, rather than inventing profile secret columns. Migrate derived MCP route/explain output and capability `onecliSecretNames` metadata. Admin API exposes both reference fields during the window with a backend/status discriminator, never secrets; contradictory dual-field writes fail. Do not silently switch unresolved references to unauthenticated direct access.
3. Pin each provider/catalog entry/session to one backend. API keys/MCP move first, Codex independently. A failed auth attempt does not automatically retry through the other credential store. New GitHub sessions use A (or approved B); existing `session.onecli` sessions drain on C. Do not mass-rewrite live sessions or destroy rollback secrets.
4. **For A, proxy becomes mandatory for repo sessions after the migration window.** Keep legacy OneCLI repo mode for **two minor releases and at least 60 days**, then reject new repo-session creation when `egressProxy.enabled: false` with a clear validation error. Non-repo direct installs are not forced to enable it. Existing installs may remain on the prior supported release while enabling the proxy; do not silently remove their functionality on upgrade. B would not intrinsically require MITM/proxy for repo auth, though network policy remains an independent setting.
5. Drain old sessions and validate rollback before deleting OneCLI credentials, releases, DB, CA mounts, bootstrap scripts, `onecli.ts`/admin clients and host reconciler. Replace `run-phase4b.sh`, `run-phase4c.sh` and OneCLI-dependent e2e expectations. Update live README/plan/model-credentials/repo-workspace/Helm/UI docs. Preserve historical ADRs with supersession notes; mark `load-50`/`bug-hunt` artifacts historical instead of rewriting recorded experiments. Current runnable examples must be updated or clearly retired.

Rollback before deletion switches **new** sessions/provider selections back to C; do not export an actively rotated Codex refresh token into two independent stores. After deletion, rollback requires restore/reimport, so maintain a tested backup window and do not imply instant reversibility. Permanent external OneCLI mode is not included; if gates fail, pause deletion rather than fund indefinite duplicate architectures.

## Q7 — Concrete library choices and other alternatives

- **Keep OneCLI:** least implementation risk and best immediate fallback; its current functions are known. Keep it if the custody choice is unresolved, guarded SDK egress cannot be enforced, CA/client/performance tests fail, refresh recovery is unacceptable or the full 6–9 week effort is not funded. An upstream refresh fix may remove one pain point but not the deployment/admin/custody trade-offs. Survey claims about current upstream internals are **UNVERIFIED independently** for bundled v2.20.0.
- **Selected library stack:** retain the pinned Stripe Smokescreen/goproxy pair for policy-aware CONNECT, hooks and dialing; do not swap forks mid-migration. Use Go standard `net/http`, `crypto/tls`, `crypto/x509`, `crypto/ecdsa`, `crypto/rand` for the fixed A adapter/leaf template; reject stock `signHost` even though the survey suggests tightening it. With two exact hosts, a two-entry generation-aware cache is enough. Reuse installed TS `undici`, `pg` and pinned pi-ai `CredentialStore`; no Go OAuth manager is needed.
- **Modern Go MITM alternatives:** `elazarl/goproxy >=1.9.4` is the survey’s credible future h2/WebSocket candidate, not an API-compatible replacement for this Stripe fork. Reject migration now because it widens both protocol and policy integration scope. Iron’s fresh P-256/bounded-cache pattern is useful reading, but its `internal` packages are not a public importable SDK. Martian, Adguard/gomitmproxy and lqqyt2423/go-mitmproxy are not selected: survey flags archival, deprecated/GPL posture and CA-key/leaf concerns respectively; those maintenance/license/internal claims are **UNVERIFIED independently** here, so none is asserted as a freshly audited security verdict.
- **Off-the-shelf gateway:** Envoy with `ext_proc`, mitmproxy and agent-substrate/atenet-style deployments replace or duplicate our policy/data plane and need secret identity, revocation and lifecycle integration anyway. mitmproxy is valuable as an external interoperability oracle, not a Python runtime embedded in this Go proxy. Fly Tokenizer’s private plaintext transport pattern is not a drop-in CONNECT injector. Infisical Agent Vault, OpenShell, Pomerium, Teleport and Tailscale Aperture from the survey are broader products or different reverse-proxy models, not a few missing header lines. Detailed internals of these alternatives are **UNVERIFIED independently**; reject on architectural scope, not unsupported claims of insecurity.
- **No-MITM helper:** B is the smallest complete GitHub replacement if portable tokens are acceptable; it preserves end-to-end TLS and avoids owning a signer/parser. Its remaining job is authenticated session-bound delivery plus git/gh lifecycle and revocation. Do not reject it merely because sandbox code can invoke it. Reject a helper-default/MITM-high-custody hybrid because two GitHub implementations would erase much of the simplification.
- **No extra PKI/refresh/SOCKS platform:** do not add `step-ca`, `go.step.sm/crypto/x509util`, CertMagic or a vault for two leaf names and one existing DB store. `golang.org/x/oauth2` cannot solve the distributed TS-owned refresh problem; `singleflight` only coalesces within one process. If real SOCKS demand appears, survey candidate `things-go/go-socks5` is preferable to immediately adopting `armon/go-socks5` or `txthinking/socks5`, but its default resolution/auth/UDP behavior must be replaced with our identity and all-IP judged dial. No SOCKS library is added now. These candidate API/maintenance assessments beyond the installed sources remain **UNVERIFIED independently**.

## Explicit answers to the critic’s ten open questions

1. **pi-ai hook?** Yes: pinned 1.6.0 `dist/auth/types.d.ts` and `dist/auth/resolve.js` expose/use `CredentialStore.modify`. SDK initiation is fine; store-owned serialization is mandatory. No fork needed on inspected evidence; refresh-network transport coverage remains a gate.
2. **Durable auth persistence?** No explicit runtime-auth serialization found in the inspected generation/provider path; stream settings and errors do persist. Generic `pi` records/revisions listed above can carry leaked values. Complete absence of credentials is **UNVERIFIED** until sentinel tests; keep auth out of persisted configuration.
3. **Who filters orchestrator egress?** The mandatory TS guard and judged-IP undici transport, with shared Go/TS address vectors, exact-origin authorization, private exceptions and immutable platform blocks. NetworkPolicy is a port/CIDR backstop, not a hostname filter. Orchestrator RCE can bypass the in-process control; this is the explicit ADR 0040 trade-off.
4. **Why a CA?** To avoid intentionally handing the sandbox a portable repo-write token, not to prevent authenticated misuse. B adds up to 3,600 seconds of off-cluster use after theft, reduced only by expiry/successful revocation. A costs approximately 8–10 additional days at corresponding estimate endpoints and adds signer/parser risk. Product custody preference, not a universal security ranking, selects A.
5. **Connection timelines?** (a) Remint at T0 writes token generation N+1 and notifies; an already-started upload with N finishes; the next request uses N+1, same authorized connection. No epoch change. (b) Binding-key rotation first distributes a reader key ring with old+new IDs, then re-seals rows under the new key without changing authorization; readers reload/decrypt, existing requests continue. Remove old key only after all rows/replicas are confirmed migrated. Emergency compromised-key rotation revokes epochs and closes sessions instead. (c) Routine CA change distributes old+new public trust to existing sandboxes first, confirms rollout, then switches signer generation and clears leaf cache. Existing TLS sessions continue to their normal cap; new handshakes use the new issuer. Retire old public trust only after old sessions drain or sandboxes roll. Emergency CA compromise closes tunnels and rolls sandbox trust immediately; graceful continuity is not promised. Unsupported/missing key generations fail closed.
6. **CPU/memory per GiB?** **UNVERIFIED**, not invented. The 1 GiB pack/LFS benchmark and 400m/192Mi/1.25× gates above define exactly what must be measured before A ships against 500m/256Mi limits.
7. **Proxy disabled?** For A, legacy OneCLI repo sessions remain for two minor releases and at least 60 days; afterward proxy is mandatory for new repo sessions, with explicit validation. No permanent legacy mode is budgeted.
8. **Catalog/profile mapping?** Operator supplies old-name → credential-ID mapping after fresh imports; migrate catalog references and metadata, preserve profile MCP names/snapshots, validate unresolved entries and expose backend/status plus compatibility reference fields during the window. No secret export assumption and no fictitious per-profile secret column.
9. **ChatGPT subscription terms?** **UNVERIFIED.** Moving token custody does not establish permission or change the provider’s contract. Require explicit operator/legal confirmation for server-side usage. Pending that, do not enable the new Codex path; keeping an already-authorized existing deployment temporarily is an operational rollback, not a terms workaround. Disable Codex if usage is not permitted; API-key providers remain usable.
10. **Per-rule tunnel age?** Not now. One-hour age and ten-minute idle are acceptable documented reconnecting-client limits for this slice; keepalives solve idle only. Revisit schema only with a demonstrated long-lived workload, not as speculative flexibility.

## Final decision boundaries

Approve the orchestrator API-key/MCP and TCP work independently. Approve A only with an explicit no-portable-GitHub-token requirement and successful CA, transport, revocation, persistence and performance gates. If that custody requirement is relaxed, select B once, amend the GitHub promise and delete the injector plan. If neither can be validated within budget, retain C rather than ship an unaudited proxy framework.

Skipped deliberately: general secret dashboard, programmable injection templates, h2/WebSocket interception, SOCKS/UDP, PKI service, per-rule tunnel lifetimes and permanent dual backends. Not checked experimentally: real-client CA enforcement, CPU/RSS per GiB, complete SDK/persistence behavior, live GitHub revocation and Codex terms/soak; these remain release-blocking risks, not completed work.
