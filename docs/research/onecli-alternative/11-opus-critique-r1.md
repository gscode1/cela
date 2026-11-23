# Opus critique, round 1: Astra's "retire OneCLI without building another OneCLI"

Critique of `10-astra-proposal-r1.md` against `00-brief.md`, 2026-11-23. Not a decision.

Module sources read: `github.com/stripe/goproxy@v0.0.0-20260922184237-948457f542a3` (`https.go`, `proxy.go`, `ctx.go`,
`certs.go`, `signer.go`) and `github.com/stripe/smokescreen/v2@v2.0.0-20261112132816-8ba9b4e488a8`
(`pkg/smokescreen/smokescreen.go`, `acl/v2/{engine,policy}.go`, `hostport/hostport.go`), from `go env GOMODCACHE`
(`$GOMODCACHE`). Paths below without a prefix are repo paths. `goproxy/` and `smokescreen/` mean those module
roots.

## Summary

The proposal gets the big calls right. Keep the proxy a narrow GitHub-only injector. Move model and MCP auth into the
trusted orchestrator. Do not enable stock goproxy MITM. Defer SOCKS5. Its source claims about goproxy and Smokescreen are
mostly correct, and two of them are understated (see C1 and C2).

It has four gaps:

1. It never re-decides the **orchestrator's network egress**. Today the orchestrator reaches the internet only through
   the OneCLI gateway, plus `api.github.com`. Removing OneCLI means the orchestrator dials model providers and every
   catalog MCP host itself. ADR 0040's main reason for keeping the orchestrator off the proxy was "one more hop in front
   of the gateway the orchestrator already reaches", and that reason goes away with the gateway.
2. Its rotation semantics would **cut every intercepted git transfer about every 50 minutes**. Today they do not.
3. It dismisses the **no-MITM alternative** (a git credential helper with a short-lived, revocable, repo-scoped token in
   the sandbox) with a weak argument. That option should be costed properly, because it removes the CA, TLS termination
   and plaintext tokens from the proxy altogether.
4. Its **cost model misses most of the blast radius**. 297 files mention OneCLI, including 31 in `packages/admin-ui`, 8 in
   `packages/ingest` and the MCP catalog's `onecliSecret` field. Slice 7 at "1–2 days" is not credible.

Verdict: **adopt with changes**. The details are at the end.

---

## 1. Verification of factual claims

### 1.1 Confirmed

| Claim | Evidence |
|---|---|
| Stock MITM inner requests go through a RoundTripper, not our `ConnectDialContext`, so they bypass the judged-IP check and the revocation registry. | `goproxy/https.go:325` `ctx.RoundTrip(req)`; `goproxy/ctx.go:43-47` (`ctx.RoundTripper` or `proxy.Tr`); Smokescreen sets `pctx.RoundTripper = rtFn` (`smokescreen.go:812`), which calls `proxy.Tr.RoundTrip` with `proxy.Tr.DialContext = dialContext` (`smokescreen.go:784`). That `dialContext` dials `d.ResolvedAddr` from Smokescreen's own `safeResolve` (`smokescreen.go:522-559`), not an address our evaluator judged. Ours is installed only as `gp.ConnectDialContext = p.dial` (`packages/egress-proxy/internal/egress/proxy.go:137`), which `ConnectAccept` uses and the MITM branch does not. Nothing is passed to `Registry.Track`, so revocation, max age and #387's doubly-approved address are all lost. **True.** |
| There is no upgrade relay in the MITM loop. | `goproxy/https.go:292-371`: one `ReadRequest`, `RoundTrip`, then a forced HTTP/1.1 status line, `Transfer-Encoding: chunked` and `Connection: close` (`:345-350`). A 101 response would be re-framed as a chunked body. **True.** |
| Our decider rejects MITM inner requests. | `proxy.go:458` `if a.ConnectReq != nil \|\| a.Req == nil { deny }`. Smokescreen passes `ConnectReq` only for MITM inner requests (`smokescreen.go:1443-1449`). **True.** Turning MITM on today would deny every inner request rather than leak, which is the safe failure. |
| Smokescreen can select MITM from the ACL result. | `acl/v2/engine.go:30-36` `Decision.MitmConfig`; `smokescreen.go:1034-1060` builds `ConnectMitm` with `MitmMutateRequest` from `MitmConfig.AddHeaders`. **True.** |
| goproxy ships a built-in CA. | `goproxy/https.go:50` `MitmConnect ... TLSConfigFromCA(&GoproxyCa)`; `goproxy/ca.pem`, `key.pem` are in the module. **True.** |
| CONNECT does not require TLS on a direct tunnel; ports 1–65535; at most 32 ports per rule; hostnames only, no IP literals. | `rules.go:348-352` (port range and `dnsNameError`); `snapshot.go:186`; `smokescreen/hostport` imposes no port allowlist. **True.** |
| Bindings do not advance the revision. | `packages/session-core/migrations/027_egress_bindings.sql:24-31` has a NOTIFY trigger and no `egress.revisions` bump. A proxy acknowledgement keyed by revision therefore cannot confirm that a binding was applied today. **True, and a good catch.** |
| `repo-access.ts` remints when less than ten minutes remain. | `packages/orchestrator/src/repo-access.ts:29` `REMINT_BEFORE_MS = 10 * 60 * 1000`; `beforeUse` at about `:142`. **True.** |

### 1.2 Understated or partly wrong

**C1. Upstream TLS verification *is* disabled on the stock MITM path, not just "a default not to adopt".** Astra writes
that "a server-side TLS config's `InsecureSkipVerify` is not itself evidence of upstream verification being disabled".
That is accurate for `defaultTLSConfig` (`goproxy/certs.go:20-22`, server side). But the *client* transport that MITM
inner requests use is `proxy.Tr = &http.Transport{TLSClientConfig: tlsClientSkipVerify, Proxy: http.ProxyFromEnvironment}`
(`goproxy/proxy.go:253`, `goproxy/certs.go:18`). Smokescreen's `configureTransport` (`smokescreen.go:724-736`) changes only
pool sizes and the idle timeout. So the stock path:

- does **not verify the upstream certificate**, and
- honours **the proxy Pod's `HTTPS_PROXY` environment**.

Both make the case for "do not use stock `ConnectMitm`" stronger. Name them in the ADR as reasons, with file:line, so
that nobody later "simplifies" back to the stock loop.

**C2. The stock path also has a concrete credential-redirection bug, which Astra treats only abstractly.** In the MITM
loop, `MitmMutateRequest` (the `AddHeaders` injection, `smokescreen.go:1046-1052`) runs at `goproxy/https.go:306`.
That is **before** `filterRequest`, where Smokescreen re-runs the ACL on the **inner request's** destination
(`smokescreen.go:810-866`). For an absolute-form request line (`GET https://other.example/ HTTP/1.1`), `http.ReadRequest`
sets `req.Host` from the URL, and goproxy keeps the absolute URL (`https.go:310`). Smokescreen deliberately supports
MITM'd requests to a *new* destination ("reusing role from CONNECT but checking new destination", `:827`).

So: if a future decider allowed `ConnectReq != nil` with the session's ordinary rules, an injected GitHub token would be
sent to any other host the session may reach. Astra's `InjectAuthorityCannotEscapeConnect` test covers this. The ADR
should state the mechanism. The fix is structural: inject after the authority check, from the CONNECT authority only.

**C3. Smokescreen re-reads `X-Upstream-Https-Proxy` on every MITM inner request** (`smokescreen.go:1380`). Our
`serve()` deletes that header only on the outer CONNECT (`proxy.go:155`). In the custom handler, strip it from inner
requests and never consult `UpstreamProxySelector` for `inject`. Astra says "strip proxy-auth and upstream-selection
headers on inner requests". That is correct, but the header name should be in the test list.

**C4. Leaf issuance: goproxy's signer is unusable as is.** It issues leaves valid from 1970 to 2049
(`goproxy/signer.go:21-22`), always RSA-2048 generated per cache miss, and caches per host across all sessions
(`https.go:567-660`). Astra's own issuer (24 h, exact SAN) is right. Spell out that `signHost` is not reused. A shared
leaf cache across sessions is acceptable, because leaves are public and only the proxy holds their keys. But it
must be keyed by CA generation, as Astra says.

**C5. "Direct raw TCP works today" is true for 80/443 and `privateEgress` ports, but it is not half-close correct.** The
proxy wraps both legs: the target in `trackedConn` (`registry.go:125`), and the client in Smokescreen's `TimeoutConn`
(`smokescreen.go:797`). goproxy's half-close-correct `copyAndClose` (`https.go:192-196`, `CloseWrite`/`CloseRead`)
needs `*net.TCPConn` on both sides, so it never runs. The fallback (`https.go:207-223`) **fully closes the target when
the client sends EOF**. Any protocol that half-closes and then waits for the reply (`nc`-style request/response, some
`rsync`/`tar` pipelines, a few DB tools) loses the reply.

Astra's `TcpPolicyAndHalfClose` test would fail today. The fix is small: set goproxy's `ConnectCopyHandler` with a
`CloseWrite` that unwraps. But it is real work, and slice 1 should list it.

**C6. Private TCP needs no new chart surface.** `egressProxy.privateEgress` already exists (`charts/cela/values.yaml:375-382`,
`templates/networkpolicy/egress-proxy.yaml:117-125`). Only public non-80/443 ports need `publicPorts` widened, and that
widening applies to **all** sessions at the network layer. The evaluator stays the per-session control.

### 1.3 Unverified claims that must be checked before round 2

- That pi-ai (1.5.x / 1.6) lets the orchestrator **own** OAuth refresh: a credential-store hook that cannot refresh
  silently. `docs/model-credentials.md:327-333` says only that pi stores `auth.json` and that refresh rotates the
  refresh token. Astra's "do not let an SDK silently run an unlocked refresh" assumes such a hook exists. If it does not,
  slice 4 needs a pi-ai patch or wrapper.
- That **Pi Durable never persists request headers or the credential store** into its Postgres state (`pi.*` tables).
  With placeholders this did not matter. With real keys in-process it does (see M6).
- OpenAI's terms for server-side use of a ChatGPT subscription (`docs/model-credentials.md:333-334`). OneCLI let the
  project avoid owning that question.

---

## 2. Missing threats and failure modes

**M1. Orchestrator egress becomes an open question, and the proposal skips it.** Today the orchestrator NetworkPolicy
allows the DB, sandboxd, OneCLI and the kube API (`charts/cela/templates/networkpolicy/orchestrator.yaml:1-6, 49-58`).
Under Cilium, the only public FQDN is `api.github.com` (`cilium.yaml:53-59`). OneCLI's gateway was the orchestrator's
egress filter: private-destination guard, metadata block, ADR 0043 open-public defaults. Without it, either:

- the orchestrator gets broad public egress. Under `standard` with no `kubeApiCidrs` it already effectively has 443 to
  anywhere (`orchestrator.yaml:85-87`), which is an accident, not a design. Or
- a Cilium `toFQDNs` set has to follow the MCP catalog and custom providers at runtime. That is a **new host-rule
  reconciler** with write access to Cilium policies, which recreates what slice 7 claims to delete. Or
- the orchestrator's model/MCP traffic goes through the egress proxy as a new principal kind (CONNECT only, no MITM).
  ADR 0040 rejected this, but its first reason (an extra hop in front of the gateway) disappears with the gateway.

The orchestrator holds the GitHub App key, the master key, the binding key and DB credentials. Widening its egress widens
the exfiltration paths from an orchestrator compromise. Round 2 must pick one option and amend 0040 explicitly. The
in-process SSRF guard Astra sketches (pin validated addresses, block platform and metadata destinations) is necessary in
every option. It is a port of the proxy's address tiers to TypeScript, and the TS/Go shared vectors should cover it.

**M2. Rotation would cut long git transfers every hour.** Today `judge()` compares the hash of the **OneCLI agent token**
(`proxy.go:374`). A remint updates the OneCLI *secret* in place (`repo-access.ts:190-192`) and the agent token stays the
same, so open tunnels survive. Astra's design closes intercepted connections on every binding generation change,
"even if the token's value happens to be identical", and a remint happens every ~50 minutes in an active session. A
clone, push or `gh` call that spans a remint dies.

Fix: separate **authorization** state from **credential** state. Keep the connection open while the session, rule and
route still allow it. Read the *current* binding per request at injection time. Close only on revocation (principal
gone, rule denied, route changed, binding deleted). Expiry is enforced per request, not by killing the socket.

**M3. CA blast radius is wider than it needs to be: name-constrain the CA.** Sandboxes put the CA into `SSL_CERT_FILE`,
`GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS` (`packages/orchestrator/src/workspace.ts:98-111`), so
every TLS client in the sandbox trusts it **for every name**. A stolen key from either proxy replica can then
impersonate any host to any sandbox that still holds the bundle in its PVC.

An X.509 **Name Constraints** extension (permitted DNS `github.com`, `api.github.com`, critical) shrinks that to the two
injected names. Go, OpenSSL and GnuTLS all enforce it. It costs one field and makes the "CA in two proxy pods" risk much
smaller. It belongs in Q2 and in a test: the leaf issuer refuses any other name, and a client rejects a leaf for another
name signed by the CA.

**M4. Two replicas, one CA key, no audit trail.** Both proxy replicas mount the signing key. Nothing records which leaves
were issued. Add a structured log line per issuance (serial, SAN, session, CA generation; no key material) so that a key
compromise can be scoped afterwards. Specify that the Secret is not readable by any other ServiceAccount, and that the
CA key is never in Helm values (an operator-created Secret or an ExternalSecret only, like the binding key).

**M5. Proxy resources and the cost of TLS termination.** Proxy limits are `cpu: 500m, memory: 256Mi`
(`charts/cela/values.yaml:331-334`). Two TLS legs per git packfile, plus a leaf keygen per cache miss (ECDSA P-256
rather than RSA-2048), on half a core per replica will show up in clone times. Slice 2 needs a CPU and memory
measurement on a large repository. The ">10% regression versus OneCLI" gate should also bound CPU per GiB transferred,
and the chart limits should change with it.

**M6. Real credentials in the orchestrator have new leak paths.** These include pi-ai error objects that echo request
headers, Pi Durable's persisted run state, `log()` calls that serialize fetch errors, and the admin status/capabilities
endpoints. Add an invariant test: after a scripted run with sentinel credentials, no `pi.*` table, orchestrator log line
or ingest response contains the sentinel. AGENT.md asks for exactly this kind of architectural test.

**M7. The Codex refresh moves into multiple shards, and the lock alone is not enough.** Astra's advisory lock with a
reread and CAS on `version` is right. Three gaps remain:

- **(a)** pg advisory locks are session-scoped. With a `pg.Pool`, the lock and the CAS must use the *same* checked-out
  client, and a pool reset during the provider call drops the lock silently. Use a transaction-scoped
  `pg_advisory_xact_lock` around the reread and the CAS, with the provider call between two short transactions guarded
  by a `refreshing_until` lease column. Or hold one client explicitly and say so.
- **(b)** Every shard's pi-ai instance needs the *new* access token after a refresh. That needs a cache-invalidation path
  (LISTEN/NOTIFY on the credential row, or reread on 401 once).
- **(c)** The initial login. The OneCLI dashboard ran the browser OAuth flow (`docs/model-credentials.md:84, 105`).
  Without it the operator logs in with a local pi and imports `auth.json`, then must **never use that local login
  again**, or the two refreshers race (the same #265 failure across machines). The import doc needs that warning, and
  the importer should refuse a login whose access token expires within N minutes.

**M8. Operator UX for secrets.** "An operator CLI with the credential key" means either the credential key leaves the
cluster for an operator laptop, or the CLI runs inside it. Prefer
`kubectl exec -i deploy/pi-orchestrator -- cela-credentials import --kind api-key --origin https://api.openai.com < key.json`,
so that the key never leaves the cluster and RBAC on `pods/exec` is the authorization.

Today the console shows credential hints from OneCLI's secret list (`packages/orchestrator/src/capabilities.ts:87-171`;
`packages/ingest/src/server.ts:339-371, 986-992`). The admin-ui MCP form picks `onecliSecret` names. Both need a
replacement, at minimum list-only metadata of the new credential table. That is UI and API work the proposal does not
count.

**M9. Migration of existing installs: the catalog and session schema.** `onecliSecret` is a column and field in the MCP
catalog (`packages/ingest/src/egress-routes.ts:73-74`), in profiles and in the admin UI. Sessions carry `session.onecli`
(`repo-access.ts:219`). `egress-routes.ts:435-460` explains and counts `route=onecli`. Every one of these needs a data
migration (`onecliSecret` to `credentialId`, mapped by an operator-supplied table, since OneCLI secrets cannot be
exported) and a compatibility window in the admin API. Also:

- Installs with `egressProxy.enabled: false` lose repo sessions entirely. Astra notes this. It needs a release-note-level
  decision: either the proxy becomes mandatory for repo sessions, or legacy mode keeps OneCLI.
- The `load-50` and `bug-hunt` example directories reference OneCLI (30 files). Decide whether they are historical
  records to leave alone or docs to update.

**M10. HTTP/1.1-only and git.** git smart HTTP, LFS and `gh` work over HTTP/1.1. The real risk is keep-alive: if the
custom handler closes after each response, as goproxy's loop does (`https.go:350`), every git round trip pays a new
CONNECT and two TLS handshakes. Require keep-alive on both legs, with the per-request re-judgement Astra describes, and
measure the number of handshakes per clone in slice 2.

**M11. Credential echo on GitHub.** Accepted as inherent. One concrete GitHub vector: the token can push to
`.github/workflows` only with the `workflows` permission, which `github-app.ts` does not request. Add a test that the
minted permission set never contains `workflows`, `administration` or `secrets`, because a workflow could print the
token to logs the sandbox can then read through the API.

**M12. `gh` and the placeholder.** `GH_TOKEN` is a placeholder (`workspace.ts:104`). With "always replace" this keeps
working. But a user-supplied PAT in the sandbox would be overwritten silently. Document that, or deny any non-placeholder
`Authorization` with a clear 4xx so the user knows why.

---

## 3. Is the scope minimal? The no-MITM option deserves a real costing

Astra rejects a git credential helper because "a hostile sandbox can invoke the helper itself" and the token sits in
sandbox memory. The first point is irrelevant. Under MITM, a hostile sandbox can already use the injected credential for
anything the token allows, for as long as the session lives. The only extra exposure of an in-sandbox token is
**portability**: it can be exfiltrated and used from outside, until

- it expires (1 h, fixed by GitHub), or
- the orchestrator revokes it with `DELETE /installation/token` (authenticated by the token itself, so the orchestrator
  can call it at teardown or remint).

What the no-MITM variant removes:

- the CA and its rotation, trust distribution and name constraints;
- TLS termination of untrusted traffic in the proxy;
- plaintext tokens and the binding seal key in the proxy (the proxy goes back to holding **no** secrets except principal
  hashes);
- the new `repo_bindings` table, the custom HTTP/1.1 handler, slice 2's whole spike, and M2, M3, M4, M5 and M10;
- the HTTP/1.1-only limit on GitHub traffic.

What it costs:

- a sandboxed agent can read a repo-scoped, 1 h, revocable token;
- plan.md's "sandboxes hold no real secrets" principle must be amended for GitHub. This is **not** an AGENT.md invariant
  violation: that invariant is about *model* credentials.

The pragmatic shape is a credential helper backed by an orchestrator endpoint that serves only the session's current
token over the existing sandboxd bridge. Simpler still: write the token into a file and remint it before tool calls, as
`beforeUse` already does.

I am not asserting this option is better. GitHub tokens with `contents:write` can do real damage after exfiltration
within their hour. But it is the **genuinely minimal** design the brief asks for, and it should be a costed column next
to "GitHub-only MITM": risk, effort, what is deleted. The decision can then be explicit. A hybrid is also possible:
helper by default, MITM injector only for profiles marked high-custody. That should be rejected on "two implementations",
but it should be named.

The scope could also be smaller on the orchestrator side. Phase the model/MCP move as **API keys first** (stateless and
easy) and **Codex OAuth last** (stateful, racy, terms-sensitive). Allow a configuration where only Codex stays on OneCLI
until slice 4b is proven. That reverses Astra's "never invoke both credential systems for one operation" only at the
granularity of a provider, which is acceptable.

---

## 4. TCP answer

**Agree: no SOCKS5 now.** Clients that ignore `HTTPS_PROXY` usually ignore `ALL_PROXY`/SOCKS as well. SOCKS5h's main
benefit, remote DNS, is already delivered by CONNECT. A SOCKS listener adds a second authentication surface (cleartext
username/password, like Basic today) for little gain. Corrections:

- **The sandbox image has no SSH client, `socat` or `nc`** (`images/sandbox/Dockerfile:59-62`). "SSH via ProxyCommand"
  needs an image change: `openssh-client` plus a tiny CONNECT helper. A 30-line Go or Node `cela-connect` reading the
  token from the env, not from argv, beats `corkscrew` or `socat`, which take credentials on the command line.
- **Tunnel lifetime:** `EGRESS_MAX_TUNNEL_AGE=1h` and `EGRESS_IDLE_TIMEOUT=10m`
  (`packages/egress-proxy/cmd/egress-proxy/main.go:44-48`). SSH and DB sessions are cut at 1 h and after 10 min idle.
  Document `ServerAliveInterval` and reconnecting, or allow per-rule max age, which is a schema change. Don't promise
  "arbitrary TCP" without saying this.
- **Half-close** (C5) must be fixed in slice 1.
- **Local forwarders for DB clients** break `sslmode=verify-full` hostname checks when the client dials `127.0.0.1`.
  Document the `host=` + `hostaddr=` pattern for libpq, or say that verify-full is not possible through the forwarder.
- **`publicPorts` is install-wide** (C6). Widening it to 22 lets every session's proxy dial 22 at the network layer. The
  per-session evaluator remains the gate, which is acceptable, but say so in the ADR.

Slice 1 at 2–3 days is fine if it covers docs, tests, the half-close fix and the `publicPorts` example. The image change
for SSH is a separate small slice.

---

## 5. Phasing, cost and kill criteria

**Cost realism.** The slices add up to 18–29 days. Missing from them:

- orchestrator NetworkPolicy and egress design (M1);
- admin-ui (31 files) and ingest (8 files) changes for credential pickers, hints and explain (M8, M9);
- catalog and profile data migration (M9);
- replacing `run-phase4b.sh` and `run-phase4c.sh` and the 11 OneCLI-touching e2e files;
- docs: 31 ADRs mention OneCLI, plus `docs/model-credentials.md`, `docs/repo-workspace.md` and `plan.md`;
- the pi-ai refresh-hook unknown.

Slice 7 at 1–2 days for 297 files is not realistic: budget 4–6 days. The honest figure is **6–9 engineer-weeks**, plus
security review. The no-MITM GitHub variant would cut about 2 weeks.

**Ordering.** The proposal sequences MITM feasibility (slice 2) before the model/MCP move (slices 4–5). They are
independent, and the orchestrator move delivers most of the security win: the OneCLI sign-up hole and the admin key that
lists every agent token both concern the *orchestrator's* use of OneCLI. Suggested order:

1. TCP.
2. The GitHub custody decision: helper versus MITM, which settles whether slice 2 exists.
3. Orchestrator API keys and MCP, with M1 resolved.
4. Codex OAuth.
5. The GitHub path.
6. Deletion.

OneCLI can then shrink to "GitHub only" or "Codex only" in between, without either half blocking the other.

**Kill criteria.** They are good and testable. Add:

- Kill MITM (fall back to the helper or to keeping OneCLI for GitHub) if slice 2 cannot keep connections open across a
  token remint (M2), or if a clone of a reference repository (state its size) through the injector uses more than X% CPU
  of the proxy limit.
- Kill the Codex move if pi-ai has no refresh hook that the orchestrator controls without a fork, or if the
  crash-after-provider-rotation window cannot be recovered without a manual re-login more often than once per N weeks
  of soak.
- Kill or redesign if M1 can only be solved by a Cilium-policy reconciler with write access from the orchestrator.

---

## (a) Verdict

**Adopt with changes.** The direction is right: a narrow proxy, credentials in the trusted orchestrator, no stock MITM,
no SOCKS5. Round 2 must close the orchestrator-egress gap, fix the rotation semantics, name-constrain the CA, cost the
no-MITM alternative honestly, and re-baseline effort and ordering.

## (b) Required changes for round 2

1. **Decide orchestrator egress without OneCLI (M1).** Pick one option (broad egress plus an in-process SSRF guard, an
   FQDN reconciler, or the egress proxy as an orchestrator principal without MITM). Amend ADR 0040 explicitly, and
   specify the TS address guard with shared Go/TS vectors.
2. **Separate authorization from credential generation (M2).** Inject the current binding per request. Close
   connections only on revocation (principal, rule, route or binding removed), never on a routine remint. Add a test: a
   push that spans a remint completes.
3. **Name-constrain the injection CA** to `github.com` and `api.github.com` (M3). Use ECDSA leaves, log every issuance
   (M4), keep the CA key only in an operator-created Secret, and do not reuse goproxy's `signHost` (C4).
4. **Cite the stock-path defects in the ADR** as the reasons for the custom handler: `proxy.Tr` with
   `InsecureSkipVerify` and `ProxyFromEnvironment` (C1), header injection before the inner-destination ACL recheck (C2),
   the inner `X-Upstream-Https-Proxy` (C3), and `Connection: close` per response (M10).
5. **Add a costed "no-MITM credential helper" column** (section 3): risk delta (portability of a 1 h, revocable,
   repo-scoped token), effort, deletions. Replace the current dismissal with a comparison.
6. **Re-order the slices** so that the orchestrator API-key and MCP move comes before the MITM spike, Codex OAuth is its
   own slice with its own kill criterion, and the GitHub custody decision is made before slice 2 is funded.
7. **Re-baseline effort** to include admin-ui and ingest, the catalog/profile/session data migration (`onecliSecret`,
   `session.onecli`), e2e replacement and docs (M8, M9). Size slice 7 for 297 files.
8. **Specify the Codex refresh mechanics concretely (M7):** the lock scope with `pg.Pool`, the lease column, cross-shard
   invalidation, the import guard against a soon-to-expire login, and the "never reuse the local login" procedure.
9. **Add invariant tests:**
   - no sentinel credential in `pi.*`, logs or API responses (M6);
   - minted GitHub permissions never include `workflows`, `administration` or `secrets` (M11);
   - the CA name constraint is enforced (M3);
   - half-close through a direct tunnel works (C5).
10. **TCP slice:** fix half-close through `ConnectCopyHandler` (C5), document tunnel max age and idle limits, put the SSH
    client and CONNECT helper in a separate image slice, and state that `publicPorts` is install-wide.
11. **Operator CLI runs in-cluster** through `kubectl exec -i` (M8), so that the credential key never leaves the cluster.
    Say what replaces the console's credential hints and secret pickers.

## (c) Open questions for the proposer

1. Does pi-ai expose a credential-store hook that lets the orchestrator own Codex refresh, with no SDK-side refresh?
   Cite the file in the pinned pi-ai version. If not, what is the plan?
2. Does Pi Durable persist anything from the auth context or request headers? Which tables, if any?
3. After OneCLI, which process filters the orchestrator's egress to MCP and model hosts, and what stops a catalog URL
   that resolves to the kube API, Postgres or metadata?
4. Why should GitHub custody justify a CA and TLS termination, given that a hostile sandbox can already *use* the
   token for its session lifetime? Quantify what portability of a revocable 1 h token adds.
5. How does an intercepted connection behave across a remint, across a binding-key rotation, and across a
   CA-generation change? Give a timeline for each.
6. What is the CPU and memory cost per GiB of git transfer through the injector, measured against the current
   500m/256Mi limits?
7. What happens to `egressProxy.enabled: false` installs with repo sessions? Is the proxy mandatory, or does OneCLI stay
   as legacy mode, and for how long?
8. How are `onecliSecret` catalog references and profile fields migrated when OneCLI secrets cannot be exported? Who
   supplies the mapping, and what does the admin API return during the window?
9. Is server-side use of a ChatGPT subscription within OpenAI's terms once the project, rather than OneCLI, holds the
   refresh token? If unknown, does Codex stay on OneCLI?
10. Is a per-rule tunnel max age needed for SSH and DB sessions, or is the 1 h install-wide cap acceptable?
