# Astra proposal, round 1: retire OneCLI without building another OneCLI

## Executive summary and recommendation

**Recommend a gated replacement: GitHub-only injection in the sandbox egress proxy; model, Codex and MCP authentication in the trusted orchestrator; arbitrary permitted TCP through the existing CONNECT listener. Do not add SOCKS5 yet.** Keep OneCLI running until the replacement passes the security and migration gates below. Do not promise HTTP/2 or WebSocket interception as part of this change.

The minimum proxy is not a general secret gateway. It needs two fixed GitHub header transformations, a private CA, per-session sealed installation-token bindings, and correct lifecycle control over intercepted connections. It does not need OAuth, model credentials, MCP credentials, a secret-entry API, an agent catalog, or a dashboard. Removing those concerns from the proxy is the principal security decision.

There is a material implementation trap: **turning on the pinned goproxy MITM flag does not preserve our existing dial/revocation protections.** Its intercepted HTTP requests use a RoundTripper rather than our CONNECT dial hook. Its HTTP/1.1 response loop also does not implement an upgrade relay. Budget an initial go/no-go spike, not a one-line configuration change.

Status: proposal, not an accepted ADR. Statements labeled **Proposed** describe new behavior, not existing guarantees. Repository facts below come from the brief's named ADRs and code. Module-source findings identify the versions inspected. **UNVERIFIED:** production compatibility, estimates and performance targets have not been tested in this review. OneCLI behavior established by the brief is accepted as given; historical internal findings in `docs/research/onecli-v2-recheck.md` are not an independent OneCLI source audit here.

## Q1. Inventory and minimum

| Existing OneCLI function | Still needed? | Proposed owner and scope |
|---|---|---|
| (a) Sandbox GitHub TLS interception and repo-token injection | Yes, if raw GitHub tokens must remain outside sandboxes | Go proxy performs interception and injection only. Orchestrator keeps `github-app.ts` minting and scope verification, and writes the sealed session token. |
| (b) Model placeholders, Codex JWT substitution and refresh | Real authentication and refresh: yes. Placeholder substitution: no | Orchestrator supplies actual provider credentials in-process. Codex uses its real OAuth record and account identity. No model traffic through the sandbox proxy. |
| (c) Per-session credentialed MCP agents | Session authorization: yes. Remote agent objects: no | Orchestrator checks session profile snapshot against the live enabled catalog, selects that server's credential, and creates a scoped transport. Discovery gets only the selected server credential. |
| (d) Custom OpenAI-compatible generic secrets | Yes | Orchestrator's configured provider transport binds a credential to an exact origin and fixed header format. Preserve operator-only model/provider configuration; do not turn prompts into destination selectors. |
| (e) Reconciled OneCLI host rules | No, as a second enforcement plane | Delete the OneCLI reconciler. Retain sandbox egress policy and MCP catalog authorization. Orchestrator transports independently enforce their configured origin; neither a catalog entry nor a credential reference grants sandbox access. |
| (f) Encrypted storage, secret-entry dashboard and CA | Storage and CA: yes. Another dashboard: no | Session-core owns schema/migrations and write helpers; orchestrator owns runtime credential use and refresh. Operator CLI imports sealed secrets. Only injection-enabled proxy pods hold the new CA private key. |

**Minimal proxy-owned set:** authenticated CONNECT; existing policy/DNS/IP enforcement; direct raw TCP; a GitHub-only `inject` route; bounded leaf issuance; header replacement; sealed binding reads; and revocation of both legs. No generic host-pattern/header-expression language.

This explicitly changes `plan.md` Phase 4b's “every credential through OneCLI” design. Adopt an ADR superseding that custody choice and the relevant parts of ADRs 0022, 0037, 0040, 0042, 0043 and 0056. The new rule is: model/MCP credentials stay in the orchestrator, repo installation tokens can additionally enter the proxy, and neither enters a sandbox. This satisfies `AGENT.md`'s model-secret invariant. ADR 0042 already treats the orchestrator as trusted with the GitHub App key, master key and binding key; pretending it is an untrusted token-only component is not a useful boundary.

Code evidence: `packages/orchestrator/src/github-app.ts` already requests one repository and `contents:write`, `pull_requests:write`, `metadata:read`, then checks the returned repository list. `repo-access.ts` already mints before provisioning OneCLI and refreshes before tool use when less than ten minutes remain. `mcp-access.ts` already distinguishes session and discovery identities and intersects profile names with enabled catalog entries. Preserve those controls, delete the remote object choreography.

## Q2. Injection design in the proxy

### Route and request contract

**Proposed:** add `route=inject` to Go and TS validation/evaluation, schema constraints, explain output and shared vectors. Keep `direct` unchanged. During migration only, retain explicit `onecli`; an unknown route or missing binding always denies, never falls back.

Initially allow `inject` only for orchestrator-written session rules naming exactly `github.com:443` or `api.github.com:443`, with a live GitHub binding. No suffixes, wildcard, private destination, arbitrary port, anonymous principal or profile-wide injection. A matching rule is necessary but insufficient: the authenticated session must also own an unexpired binding. An administrator's broad allow rule cannot manufacture a credential grant. Keep `codeload.github.com` direct as today.

Fixed transformations, derived from `repo-access.ts` rather than supplied by a sandbox:

| Exact authority | Header | Wire value |
|---|---|---|
| `github.com:443` | `Authorization` | `Basic base64("x-access-token:" + installationToken)` |
| `api.github.com:443` | `Authorization` | `Bearer installationToken` |

Always replace the client value, even if absent or not a placeholder. Delete all client Authorization values before setting exactly one. Placeholder-only replacement invites accidental alternate identities and buys no isolation. Reject credential-bearing trailers and ambiguous duplicate authorization; strip proxy-auth and upstream-selection headers on inner requests too. Never inject on direct tunnels, cleartext HTTP or raw TCP. The token's repository scope is the authorization boundary; URL path prefixes are not repository isolation.

Bind each intercepted connection to an immutable `{session, normalized CONNECT authority, binding generation, judged IP}` context. Require TLS SNI, HTTP Host and any absolute-form URL authority to agree with CONNECT, after one canonicalization; reject userinfo, invalid ports, nested CONNECT, alternate origins and non-HTTPS absolute URLs. Accept absent SNI only if the certificate is still selected solely from the authenticated CONNECT authority. Never derive session identity from inner headers. Every HTTP request rechecks the current principal, rule, binding generation and expiry before credential insertion.

Return redirects to the client; do not follow them in the proxy. The next connection is authorized separately and gets credentials only for its own permitted authority. Request and response payloads remain streaming and untouched; HTTP transfer framing may change. Do not buffer git packfiles or scrub bodies.

### CA custody

**Proposed:** operator-generated, installation-specific CA in a Kubernetes Secret, mounted read-only only in injection-enabled egress pods. No generated default CA and no CA key in Postgres, ingest, orchestrator or sandbox. Orchestrator may read the public bundle to prepare workspaces. Use existing external-secret/operator provisioning mechanisms, not a new certificate service.

Use Go `crypto/x509` to issue exact DNS-SAN, server-auth leaves after authorization, with random serials and at most 24-hour validity bounded by CA expiry. Cache only the two permitted hosts, keyed by CA generation. TLS minimum 1.2, downstream ALPN `http/1.1` only. Public CA is installed in the sandbox's git/curl/runtime trust locations, not as an upstream trust anchor in the proxy or model client.

Rotation is deliberately operational: distribute old+new public trust first, refresh/recreate sandboxes that copied the bundle, roll proxy pods to the new signing key, close old intercepted connections, then remove old trust after no old signer/session remains. A compromised key requires immediate signer shutdown and sandbox trust replacement, not merely waiting for leaf expiry. CA expiry or unavailable key fails injection readiness/requests closed; direct-mode availability is not permission to bypass injection.

### Smokescreen/goproxy integration: reuse policy, not the unchecked MITM loop

Inspected module sources:

- `github.com/stripe/goproxy@v0.0.0-20260922184237-948457f542a3/https.go`, particularly `ConnectMitm` and `TLSConfigFromCAWithCache`.
- The same module's `certs.go` defaults.
- `github.com/stripe/smokescreen/v2@v2.0.0-20261112132816-8ba9b4e488a8/pkg/smokescreen/smokescreen.go`, `BuildProxy` and `handleConnect`.

Verified findings: Smokescreen can select MITM from an ACL result, reuses the CONNECT role for inner requests and rechecks destinations. goproxy's MITM branch constructs new request contexts, calls request filters and `ctx.RoundTrip`, parses HTTP/1.1 with `http.ReadRequest`, and rewrites responses as chunked with `Connection: close`. That branch contains no bidirectional 101 upgrade relay. Smokescreen installs its own RoundTripper over `proxy.Tr`. Our current `proxy.go` sets `gp.ConnectDialContext = p.dial`, not a corresponding interception transport. Our `decider.Decide` explicitly rejects `a.ConnectReq != nil`, so its current policy adapter rejects intercepted inner requests rather than handling them correctly. goproxy includes a built-in CA and skip-verification defaults; these must not be adopted. A server-side TLS config's `InsecureSkipVerify` is not itself evidence of upstream verification being disabled, but it is no safe client configuration to reuse.

**Decision: do not enable stock `ConnectMitm` in production.** For `inject`, use an authorized CONNECT hijack and a bounded standard-library HTTP/1.1 TLS server/forwarder, leaving direct CONNECT on the current path. A small pinned Smokescreen extension should expose action selection *after* its CONNECT checks, so it can return `ConnectHijack` for this route. No copy of its ACL engine and no second proxy service. **UNVERIFIED integration work:** the exact extension and lifecycle adapter are not implemented; the first spike must prove this seam remains small. Reject a broad maintained protocol fork.

The custom handler owns the downstream connection from hijack through TLS handshake, idle waiting and request completion. Use `net/http` parsing/serving, not a handwritten HTTP parser. Bound TLS/header time, header size, per-session active connections and total connections. Reject Upgrade requests on `inject` before forwarding; unexpected upstream 101 also fails. Direct tunnels still carry end-to-end HTTP/2 and WebSockets without parsing. Intercepted HTTP/2 is deferred, not claimed as an improvement over OneCLI. Models/MCP no longer cross this interception leg; keep Codex SSE during migration.

Extract the existing direct dial safety check in `packages/egress-proxy/internal/egress/proxy.go` for reuse by the injection transport: choose the IP Smokescreen approved only if it is in the evaluator's judged addresses; connect to that literal IP, with TLS `ServerName` set to the original hostname and normal public-root chain/hostname verification. No DNS in the HTTP transport, no environment proxy, no upstream selector and no redirect-following HTTP client. If reconnecting, repeat decision/resolve/check rather than resolving the name behind the policy layer. For the first implementation, keep upstream transport state per intercepted connection; never share authenticated connection pools across sessions. Disable automatic decompression to preserve payload semantics.

The registry must track the downstream lifecycle as well as upstream sockets; otherwise a client that has not sent a request can outlive revocation, and a pooled upstream can outlive its policy. Register then rejudge as today, and close both sides on principal/rule/route/binding changes, binding expiry, stale snapshot or maximum age. Do not hold one mutable Smokescreen decision across concurrent requests. No credentials inserted until this connection's generation passes the recheck.

## Q3. Secret custody and data model

### GitHub binding

**Proposed:** add a separate `egress.repo_bindings` table during migration, rather than interpreting an old encrypted OneCLI agent token as a GitHub token. One row per session: `session_id`, `generation`, `key_id`, `nonce`, `ciphertext`, `expires_at`. Encrypted payload contains a version, session ID, generation, expiry and raw installation token; the two header forms are derived in code. Authenticate a canonical encoding of table purpose/version, session ID, generation and expiry as AES-256-GCM AAD. Generate a fresh 12-byte nonce for every write. Row movement, expiry edits and generation edits must fail authentication. This evolves the existing `egress-binding:v1:<session id>` scheme in `binding.go`, not the old wire format in place.

Orchestrator writes/replaces bindings, rules and revision in one transaction through session-core, then waits for serving proxies to acknowledge that revision before preparing the workspace. Include these rows in `pg.go`'s single-statement consistent snapshot; retain encrypted payloads until use. A generation update must advance revision, unlike relying only on the existing rule revision. Proxies remain SELECT-only except `egress.proxy_status`. No proxy OAuth, mint API, writes or Kubernetes API permission.

Keep the binding seal key shared by orchestrator and proxy only; use a separate model/MCP credential key never mounted in proxies. Rotate repo seal keys by distributing old+new readers, switching writes, resealing/reminting live bindings, waiting for proxy acknowledgement, then removing old key. Do not cache plaintext globally. Go/JS cannot promise complete zeroization of copied strings: minimize lifetime, redact errors/logs and disable sensitive dumps instead of claiming memory secrecy.

Deletion revokes the principal and removes bindings/rules transactionally, then confirms enforcement. Token rotation closes old-generation connections even if the token's value happens to be identical. Expiry must be checked on every request and scheduled against open connections, not only on DB refresh. A long-running command may lose its tunnel at token expiry; document retry rather than silently continuing expired authorization. Preserve the repo allowlist check before reminting and GitHub's returned-scope check.

### Models, MCP and operator input

**Proposed:** a session-core-owned credential table, separate from egress-readable tables, stores opaque credential ID, kind, exact origin, version and sealed payload. API-key payloads use a small allowlist of supported header formats; OAuth payloads store access, refresh, expiry and provider account metadata together. AES-256-GCM under a distinct orchestrator credential key; authenticated metadata includes credential ID, version, kind and origin. Proxy DB role has no SELECT grant here. References in MCP catalog/custom provider configuration are IDs, not secret values.

Start with an operator CLI reading JSON from stdin or a mode-0600 file in a trusted administrative environment, using session-core write helpers and the credential key. It validates exact origins, permitted headers and payload kind, writes ciphertext, prints only ID/version, and audits metadata. No secrets in CLI arguments, Helm values, shell history, GET responses or ordinary logs. Mounted static Kubernetes Secrets are acceptable seeds for fixed API keys; mutable OAuth state is authoritative in Postgres and must not be overwritten on every restart. Bootstrap/import is create-only unless the operator explicitly requests rotation.

**Do not add a plaintext secret-entry endpoint to ingest in the first version.** Ingest is public-facing and currently need not hold the decrypting key. A later UI would need an explicit authenticated, authorized, write-only import design; it is not a prerequisite for removing OneCLI. CLI key access is a privileged operator action, not available to ordinary users.

Model transports look up only the configured provider credential and constrain every request to that origin. Supply real credentials through the provider auth context/store, replacing `placeholderAuthContext`, `placeholderCredentials` and the Codex dummy JWT in `onecli.ts`. Check the final URL before dispatch, set `redirect: error` for credentialed transports, and do not let `NO_PROXY` bypass origin checks. Retain chart-only custom provider selection from ADR 0056, explicit private/IP restrictions for keyless direct providers, and HTTPS for credentialed providers. Amend ADR 0056's “keyed providers must use OneCLI” rule explicitly.

MCP uses one scoped credential-bearing transport per session/server, with no shared mutable default Authorization. Each use validates the live session, profile snapshot membership, enabled catalog entry, configured URL and credential origin/version; a cached fetch must not retain grants after catalog changes. Discovery is scoped to one server and never reused for conversation calls. Close/abort transports on teardown or credential removal; already dispatched upstream work cannot be recalled. Keep redirects disabled and do not grant the sandbox MCP credentials through its repo binding. Private MCP destinations remain an explicit operator capability; pin their validated DNS addresses at dial time and retain network blocks on platform/metadata destinations rather than recreating the name-check/dial gap noted in ADR 0043.

### Codex refresh without race #265

Only the orchestrator refreshes. Use a dedicated PostgreSQL connection with an advisory lock keyed by credential ID, shared by all shards/processes, then **reread the current row after acquiring the lock**. If access is still usable, return it. Otherwise refresh with a bounded timeout, seal the entire updated OAuth record, and update with `WHERE version = old_version`; require exactly one updated row. Increment version and invalidate caches. Never publish the new access token before persistence succeeds. Keep the lock until completion; release in `finally`. Operator rotations must use the same lock/version discipline. An in-process promise cache alone is insufficient. Do not also let an SDK silently run an unlocked refresh.

CAS prevents a stale writer overwriting newer state; it cannot make provider refresh and DB commit atomic. If the provider rotates a refresh token and the process dies before persisting it, recovery may require reauthentication. On ambiguous timeout, lock loss or invalid-grant, reread persisted state and fail closed/alert; do not repeatedly spend a possibly consumed refresh token. Test that window and document the recovery. Keep provider authentication failures terminal rather than starting paid retry loops (`docs/model-credentials.md`).

## Q4. Security deltas and required evidence

**Better:** remove the management sign-up surface, account-wide agent-token listing key, two credential-bearing proxy hops for GitHub, the secondary host-rule plane, and OneCLI's separate database/three-release/bootstrap lifecycle. Orchestrator model/MCP calls stop depending on MITM trust and placeholders. Our injector can dial the address we judged rather than delegating final resolution to a gateway.

**Worse:** the sandbox-facing proxy now parses attacker-controlled TLS and HTTP, owns a CA signing key and can decrypt all active repo bindings visible to its DB role. A proxy RCE can steal repo tokens, act against their scoped repositories until expiry/revocation, and impersonate names to clients trusting that CA. Encryption at rest does not constrain a compromised decryptor. Existing OneCLI-token custody already had a blast radius, but TLS parsing and direct credential possession enlarge it. Model/MCP credentials and GitHub App private key must remain absent from this component. Keep no service-account token, read-only root filesystem, non-root execution, resource limits and restricted network egress; do not claim those make RCE harmless.

Credential echo remains possible: an allowed origin can return an injected credential in its response. A non-scrubbing proxy cannot promise that the sandbox never learns it. Restrict injection to trusted GitHub origins, retain repository-scoped short-lived tokens, and describe this as custody reduction, not non-exfiltration proof. Generic sandbox injection would widen this trust assumption and is out of scope.

Required new/extended tests, with origin-side assertions rather than “injection happened” logs:

1. **`InjectRequiresExactSessionBinding`**: wrong session, no binding, malformed ciphertext, expired binding, wrong key, wildcard/private/alternate port, anonymous request and deleted principal all deny without upstream traffic. Shared TS/Go vectors cover `inject`, route conflicts and invalid persisted rows.
2. **`InjectAuthorityCannotEscapeConnect`**: SNI/Host/absolute-URL disagreement, trailing-dot/case normalization, URL userinfo, nested CONNECT and redirects cannot move a credential to a different authority.
3. **`InjectHeaderBoundary`**: duplicate/mixed-case Authorization, CR/LF, conflicting framing, Connection-nominated credential headers, trailers, proxy-auth and upstream headers do not cause smuggling, forwarding of client credentials or removal of the intended single replacement. Fuzz parsing boundaries using the actual server/transport pair.
4. **`InjectDialsOnlyJudgedIP`**: changing DNS answers, mixed public/private answers, IPv4-in-IPv6 and metadata/platform destinations retain current denials. TLS wrong-name, expired, untrusted and self-signed origin certs fail. No proxy-env fallback.
5. **`InjectSessionIsolation`**: at least 100 parallel sessions with distinct fixture tokens; origin captures exact host/header/session mapping through keepalive, cancellation and rotation. No cross-session transport reuse or secret in logs/errors.
6. **`InjectLifecycleRevocation`**: extend `revoke_test.go` and `registry_test.go` to idle pre-request TLS clients, active uploads/downloads, registration races, generation change, expiry, stale DB, max age and rollout. Close both legs; no orphan transport goroutines. Preserve ≤10-second healthy-DB revocation and stale shutdown at the existing two-minute threshold plus watcher delay.
7. **`CredentialStoreIsolationAndRefreshCAS`**: TS/Go sealing vectors, copied-row/metadata tampering, denied proxy DB access to model/MCP rows, create-only imports, concurrent cross-process OAuth refresh, admin rotation, lock loss and crash-after-provider-rotation recovery.
8. **`McpProfileNotCatalogGrant`** and **`ModelCredentialOriginBound`**: revoked/deleted session, changed URL/secret, disabled catalog row, discovery confusion, redirect and `NO_PROXY` cannot leak credentials or retain authorization.
9. **`RealGitHubRepoIsolation`**: actual installation token, clone/fetch/push/API PR against repo A; repo B denied; private-submodule failures explicit. Bakeoff dummy credentials are not this proof. Include large packfile streaming, client disconnect and resource-bound tests.
10. **`TcpPolicyAndHalfClose`**: non-443 CONNECT, SSH fixture, database fixture, remote DNS, deny/private/platform cases, half-close, idle/max-age and revocation. Cluster NetworkPolicy tests must show a permitted proxy port does not grant direct sandbox egress.

Existing test names and structure in `packages/egress-proxy/internal/egress/*_test.go` provide the regression base, especially `TestProxyRefusesWhenTheTwoLookupsDisagree`, `TestSnapshotBetweenDecisionAndTrackRefusesTheTunnel` and `TestConcurrentSessionsNeverSwapUpstreamTokens`. Those are not evidence that new MITM behavior already works.

## Q5. TCP: ship CONNECT first

`proxy.go` does not require TLS on a direct tunnel; `rules.go` accepts ports 1–65535, and `snapshot.go` limits a rule to 32 ports. The missing general-TCP feature is principally deployment policy and client plumbing, not a new wire protocol. The evaluator currently requires DNS hostnames, not IP-literal CONNECT targets; keep that restriction initially. A private CIDR rule constrains resolved addresses and does not eliminate the initial hostname authorization requirement.

**Proposed first slice:** document and test `CONNECT host:port` for explicitly allowed TCP destinations. Extend `egressProxy.publicPorts` only with operator-selected ports in `charts/cela/values.yaml` and `charts/cela/templates/networkpolicy/egress-proxy.yaml`; keep defaults `[80,443]`. Private endpoints also need explicit chart/network permissions and private exact-host/CIDR policy. Never widen to all ports by default. Example public rule: exact `ssh.example.org`, `ports:[22]`, `route:direct`; example private DB: exact `db.example.org`, `ports:[5432]`, `private:true`, `route:direct`, plus the deployment's private network allowance. Platform Postgres remains unconditionally blocked.

SSH/git needs an explicit CONNECT-capable `ProxyCommand`, not `HTTPS_PROXY`. Offer a documented tested client invocation using installed tooling; if an auth-safe tool is absent, choose one small packaged CONNECT client rather than a SOCKS service. Resolve the target at the proxy, preserve SSH host-key checking and never put a token in process arguments. GitHub installation tokens are HTTPS credentials, not SSH keys: keep managed repo workspaces on HTTPS; SSH requires separately authorized user key/agent handling and is not provided by this change.

Database clients that lack proxy support can connect through an explicit local CONNECT forwarder in the sandbox; they still supply database authentication themselves and must verify the real server's TLS identity. An uncooperative client fails in proxied mode. Do not secretly switch its session to direct.

**Defer SOCKS5.** If actual client demand justifies it, implement only authenticated CONNECT, `socks5h` domain-name/remote DNS, username `egress` and password equal to the existing egress token. Apply the same source-pod binding, policy, judged-IP dial and registry. Refuse no-auth, BIND and UDP ASSOCIATE; do not open a parallel policy language. SOCKS username/password is not encrypted, so its exposure on the cluster network needs the same explicit assessment as current HTTP proxy Basic auth. No new SOCKS listener until that compatibility benefit is demonstrated.

No credential injection on raw TCP. UDP/QUIC and applications needing unrestricted networking remain explicit, operator-enabled `networkMode=direct` cases, subject to that mode's existing restrictions. Transparent capture remains unsupported, not a new option hidden inside direct mode (ADR 0038).

## Q6. Cost, phasing and kill criteria

Planning estimate **UNVERIFIED:** roughly 4–6 engineer-weeks plus independent security review and rollout time, not a weekend deletion. Each slice below should be separately reviewable with its named tests; split any slice that becomes a framework. TCP can ship independently even if injector replacement is killed.

| Slice | Deliverable and gate |
|---|---|
| 1: decision + TCP (2–3 days) | Custody ADR, configuration/client documentation, CONNECT/nonstandard-port and NetworkPolicy tests. No credential migration. |
| 2: MITM feasibility (3–5 days, hard timebox) | Checked-CONNECT action hook, single-origin HTTP/1.1 handler, judged-IP TLS transport and lifecycle registry with fake origins. Must pass authority, TLS verification, streaming and idle-client revocation tests before production design is accepted. |
| 3: bindings + repo route (3–5 days) | Additive session-core migration, sealing vectors, route parity, consistent snapshot and revision acknowledgement; repo mint writes new bindings; test real GitHub scope and two-replica revocation. |
| 4: credential store + model migration (3–5 days) | Operator importer, DB grants, real provider auth and Codex lock/CAS persistence. Test streaming and cross-process refresh. No fake JWT after cutover. |
| 5: MCP/custom providers (3–4 days) | Scoped transports and origin checks, session/discovery revocation and catalog tests; delete remote agent dependency for those paths. |
| 6: migration/CA operations (3–5 days) | Canary deployment, trust rollout, fixture and real workloads, interruption/recovery and rollback rehearsal. |
| 7: deletion (1–2 days) | Remove retired code/config/release wiring, update docs/tests, prove clean install and upgrade. |

### Migration and rollback

Use one explicit installation migration state, not a pluggable gateway abstraction or per-request automatic fallback. Expand schema/readers first. Old binaries must never consume `inject` rules or new ciphertext; drain old proxy replicas before switching routes. Keep `onecli` and its binding table only during the migration window.

Inventory existing model/MCP/custom credentials by operator-owned reference. **UNVERIFIED:** OneCLI offers a safe/exportable representation for every secret, particularly OAuth refresh state. Do not depend on that. Support deliberate re-entry/re-login; never decrypt its database by guessing internal formats. Pause Codex calls and its old refresher before importing a current login; only one system may rotate it. Preserve expiry/account metadata and make the new DB row authoritative. A rollback after refresh cannot simply restore an old refresh token: pause and transfer current state safely or reauthenticate.

Remint GitHub tokens ourselves; no export needed. Provision the new CA trust into canary sandboxes, new bindings and matching session rules, then wait for every serving proxy's new revision before enabling their workspace. Move remaining sessions in controlled batches or recreate them. Revoke obsolete OneCLI agents only once the batch is committed. Any repository session with the egress proxy disabled must first move to proxied mode, or remain on the old deployment until ended; the replacement does not reproduce the legacy sandbox-to-OneCLI bypass.

Canary model/MCP transport cutover independently of sandbox repo routes. Keep old service and configuration available for one bounded rollback release, but never invoke both credential systems for one operation. Roll back only with a valid old agent binding, trusted old CA and explicit route switch, not by direct dialing. Final deletion waits for no old routes, no legacy sessions and a completed rollback drill. Retain encrypted backups according to retention policy, then revoke obsolete keys and remove OneCLI data/services explicitly rather than dropping its database during an ordinary upgrade.

Delete `charts/pi-onecli` and release wiring for its API/web, gateway and database; `hack/onecli-bootstrap.sh`, `hack/fetch-onecli-ca.sh`, obsolete `hack/onecli-host-rules.sh` and OneCLI-specific smoke/config scripts after replacing their useful assertions. Remove orchestrator OneCLI admin/grant/naming/orphan/reconciler paths, gateway `ProxyAgent` and placeholder auth paths in `onecli.ts`, and OneCLI fields in session/catalog/provider configuration after the compatibility window. Keep `Redacted` and useful model-fetch wiring in ordinary modules rather than deleting safety helpers because of their filename. Remove derived `mcp-catalog` egress rule machinery only where it served the OneCLI reconciler/explain, not actual MCP profile enforcement. Historical migrations remain historical; use new cleanup migrations. Replace tests with equivalent custody, authorization, bootstrap and lifecycle tests, not fewer tests.

### Keep OneCLI if these gates fail

- Stop slice 2 after five working days if integration requires a broad Smokescreen/goproxy fork, handwritten HTTP framing, or cannot preserve checked-IP dialing and complete revocation. Do not proceed on “the library probably does it.”
- Do not cut over with any cross-session credential leakage, origin mismatch, TLS verification bypass, stale-client survival or secret-bearing logs. A single deterministic failure blocks release.
- Keep the current deployment if real GitHub clone/push/PR flows fail, if required sandbox workloads actually need authenticated WebSocket/HTTP2 interception, or if pinning/mTLS requires a larger interception platform.
- Keep OneCLI until every required credential has a proven import/re-login and rollback path, and Codex multi-process refresh plus the crash window have an operational recovery procedure.
- Require two-replica revocation ≤10 seconds with healthy DB, stale closure at roughly 121 seconds, and a 24-hour streaming/concurrency soak without growing goroutines or memory. Proposed performance gate: no more than 10% regression in git-transfer wall time at the same resource budget versus current OneCLI, measured on repeated comparable runs; this target is not a measured result.
- If operators require a secret dashboard, broad integrations or persistent external gateway support enough to erase the simplicity gain, retain OneCLI as an explicitly managed external deployment instead. Do not maintain both implementations indefinitely merely for optionality. Decide that product requirement before deleting the legacy integration.

## Q7. Alternatives considered briefly

**Keep OneCLI as is.** Lowest immediate engineering risk and preserves existing workflows, especially the dashboard and non-GitHub integrations. Keep management access network-restricted and preserve our own GitHub minting. It retains the brief's sign-up/admin-key, release/bootstrap, protocol and refresh problems. It is the right fallback if the narrow injector's security proof or migration fails, but not my preferred steady state for this deployment. Removing bundled installation while retaining an external OneCLI dependency changes operations, not the trust model.

**Different off-the-shelf injector: Envoy/ext_proc, mitmproxy, or an atenet-egress-style component.** These are candidates for a separate bakeoff, not drop-in solutions proven by this review. **UNVERIFIED:** their exact versions, CONNECT interception, protocol support, secret handling and checked-IP/revocation integration were not inspected. A general L7 engine might be worthwhile for mandatory HTTP/2, upgrades and many injection types, but adds another runtime/control boundary while session grants, repo minting and refresh still belong to us. Do not replace three operational releases with an unmeasured sidecar/plugin system for two headers. Reconsider if slice 2 proves the existing Go stack unsuitable and the broader feature set is actually required.

**Orchestrator-only injection; sandbox Git helper/token exchange.** A helper returning a GitHub token to git puts that token in sandbox process memory and lets a hostile sandbox invoke the helper itself; short TTL does not preserve outside-sandbox custody. A proxy-side exchange that returns only an opaque capability must still perform authenticated GitHub HTTP on the sandbox's behalf: that becomes either this injector, a separate Git smart-HTTP relay, or an orchestrator-owned clone/push service. The last option can avoid MITM entirely and is attractive if we intentionally remove arbitrary sandbox git/API access, but changes the workspace/tool contract and does not transparently replace today's GitHub API commands. Prefer it only with that explicit product change, not as a supposedly equivalent credential helper.

---

Not performed: implementation, live cluster/protocol tests, provider refresh tests or benchmarking. Principal unresolved risk: a small, auditable checked-CONNECT interception seam must be demonstrated before accepting this design for production.
