# Existing building blocks for minimal credential injection and TCP egress

Research snapshot: **2026-11-23**. This is a library/pattern inventory, not an implementation proposal or a decision to remove OneCLI. Context: [00-brief.md](00-brief.md).

## Bottom line

- **We already have MITM, certificate minting, and a bounded leaf cache in the pinned Stripe fork.** We do not need a CA framework just to set an HTTP header. But the fork's intercepted client leg is HTTP/1.x, lacks a WebSocket upgrade relay, and its default upstream transport disables certificate verification. Enabling MITM unchanged is not safe.
- **Current upstream `elazarl/goproxy` is the first engine-upgrade candidate**, not a drop-in replacement for Stripe's API. It has opt-in intercepted HTTP/2 and WebSocket handling. Keep Smokescreen's authorization, judged-IP dialing, identity propagation, and our revocation semantics; prove these survive any port.
- **Iron is the closest Go pattern donor** for modern HTTP MITM, bounded certificates, guarded transport, and WebSockets. Its implementation is predominantly `internal/`, so it is not an importable injector component. Fly Tokenizer is a particularly small credential-injection reference, but deliberately uses plaintext HTTP over a private transport rather than HTTPS CONNECT interception.
- **Arbitrary TCP does not require SOCKS.** HTTP CONNECT already carries opaque TCP to a requested port. Broaden authorized ports/network policy first. If actual clients need SOCKS5, prefer `things-go/go-socks5`, with a custom authentication/resolution/dial adapter—not its permissive defaults.
- **OAuth refresh belongs with the credential writer**, not our read-only sandbox egress proxy. Go `oauth2` handles local reuse; a transaction-scoped Postgres advisory lock, reread, and versioned atomic persistence handle multiple replicas. Neither a mutex nor `singleflight` alone solves rotating refresh tokens across processes.

### Evidence convention and limitations

**Verified** means source/docs were read, not that a live protocol or exploit test passed. Tables distinguish intercepted client HTTP/2 from upstream HTTP/2; one does not establish the other. Ordinary RFC 6455 WebSocket upgrade support does not establish RFC 8441 HTTP/2 extended CONNECT support. **UNVERIFIED** explicitly identifies information not established here. A README claim is identified as such.

GitHub stars, push dates, archived status, and latest GitHub Releases below were queried from `https://api.github.com/repos/{owner}/{repo}` and `/releases/latest` on the snapshot date. A push may be dependency/docs work, not evidence of active core maintenance. “No release” means no latest GitHub Release was returned, not no Go tags. Follow-up API requests hit rate limits; missing fields remain UNVERIFIED. Organization/name denotes stewardship, not a verified count of active maintainers. Licenses are project-level summaries, not legal review of every copied file/dependency.

## 1. Our installed foundation: exact findings

`go env GOMODCACHE` returned `$GOMODCACHE`. `packages/egress-proxy/go.mod` pins:

- `github.com/stripe/goproxy v0.0.0-20260922184237-948457f542a3`
- `github.com/stripe/smokescreen/v2 v2.0.0-20261112132816-8ba9b4e488a8`
- Go `1.27`; `golang.org/x/sync v0.24.0` is already indirect.

The following paths are relative to those exact module roots, not assumptions about upstream HEAD. Online equivalents: [fork](https://github.com/stripe/goproxy/tree/948457f542a3), [Smokescreen](https://github.com/stripe/smokescreen/tree/8ba9b4e488a8).

| Finding | Evidence and consequence |
|---|---|
| MITM already exists | Fork `https.go:267-385`, `ConnectMitm`: TLS termination, inner request filters, and upstream RoundTrip. Smokescreen `pkg/smokescreen/smokescreen.go:1034-1058` builds the MITM action. |
| Intercepted HTTP/1.x only | Fork `https.go:293` uses `http.ReadRequest`; the response path removes Content-Length, sets chunked encoding and Connection: close. There is no HTTP/2 server dispatch in this path. Upstream h2, if separately enabled, would not fix this. |
| No usable WebSocket relay found | No explicit 101 bidirectional upgrade implementation in the fork's non-test Go sources; the ordinary body-copy/close path is not a WebSocket tunnel. Runtime behavior is UNVERIFIED. Do not advertise support. |
| Leaf cache is already bounded | Fork `https.go:29-34,550-669`: mutex-protected LRU, default **4,096 entries / one-hour TTL**, per generator closure. `TLSConfigFromCAWithCache(ca *tls.Certificate, cacheMaxEntries int, cacheTTL time.Duration) func(host string, ctx *ProxyCtx) (*tls.Config, error)`. Nonpositive capacity/TTL disables caching. Concurrent misses can duplicate signing because generation is outside the lock. |
| Signer does not use vulnerable deterministic PRNG | Fork `signer.go:14-58`, `signHost(ca tls.Certificate, hosts []string) (cert tls.Certificate, err error)`: fresh `rsa.GenerateKey(rand.Reader, 2048)` and random serial. The legacy counter-encryptor helper's presence does not mean this signer calls it. |
| Leaf validity needs tightening | Fork `signer.go:21-22` uses epoch through **2049-12-31**, not a short, issuer-clamped lifetime. Cache TTL is not certificate lifetime; the cache does not visibly validate NotAfter on hit. |
| Unsafe upstream default | Fork `proxy.go:253`: `Tr: &http.Transport{TLSClientConfig: tlsClientSkipVerify, Proxy: http.ProxyFromEnvironment}`; `certs.go:18` sets InsecureSkipVerify. Smokescreen `smokescreen.go:724-736` only adjusts connection limits/timeouts, not this TLS setting. MITM must explicitly install verified upstream TLS, retain destination hostname/SNI while dialing the judged IP, and prevent accidental environment-proxy rerouting. Current opaque tunnels do not perform this upstream TLS handshake themselves. |
| Built-in CA is not deployment key material | Fork includes a public example CA/private key in `certs.go`. Never deploy it. Load a private deployment CA or constrained intermediate and distribute only its public trust certificate to clients. |
| Mutation ordering matters | `MitmMutateRequest` runs **before** inner request filters/ACL checks (`https.go:309-328`). Do not use that early hook to attach secrets. Smokescreen has `PostDecisionRequestHandler` after its decision check (`smokescreen.go:875` vicinity); this is a candidate later hook, but session/binding access and our stricter exact-authority policy still require integration. |
| Smokescreen has useful MITM defenses | `smokescreen.go:780-875`: carries proxy context into RoundTrip; reuses authenticated CONNECT role, rejects absent context, and rechecks inner destinations. `smokescreen_test.go:1934` onward tests MITM Host/target bypass cases. These are defenses to preserve, not evidence that our application already supports MITM. |

### Application integration is not just a flag

`packages/egress-proxy/internal/egress/proxy.go:149-164` admits only CONNECT (plus health); `packages/egress-proxy/internal/egress/proxy.go:453-522` explicitly rejects inner MITM requests:

```go
if a.ConnectReq != nil || a.Req == nil {
    return deny("only plain CONNECT is allowed")
}
```

`packages/egress-proxy/internal/egress/proxy.go:95-139` saves `gp.Tr.DialContext` as the base dialer and installs `gp.ConnectDialContext = p.dial`. A new MITM RoundTrip path cannot silently bypass the tracking/registry and revocation behavior in `p.dial`. HTTP/2 multiplexing and pooled upstream connections also change the lifetime being revoked: closing just the original CONNECT is not automatically proof that in-flight upstream work or another stream stops.

Required composition: authenticated token + actual pod peer → rule/credential-binding authorization → canonical exact destination host **and port** → resolve/evaluate all candidate addresses → dial an adjudicated address → verified TLS for the original hostname → attach authorized header without buffering the body. Recheck every inner request, not only CONNECT. For the minimal injector, reject inner authority/SNI/CONNECT mismatches rather than treating a tunnel as a general cross-origin credential channel.

This preserves ADRs 0034–0039 rather than adding a second library's independent DNS/ACL system. Routing orchestrator traffic through this sandbox proxy would also change ADR 0040; no candidate library resolves that policy tension.

## 2. TLS-MITM / CONNECT engines

### Capability and fit

| Candidate | What it gives us | HTTP/2, WebSockets, certificates | Fit and risks |
|---|---|---|---|
| **Stripe goproxy + Smokescreen** | Already installed; CONNECT, MITM, request hooks; Smokescreen ACL/dial context and metrics. | Intercepted h1 only; no explicit WS relay found. Fresh RSA leaves; bounded LRU/TTL already present. | Smallest h1-only slice. Must fix upstream verification/leaf lifetime, integrate post-authorization injection and tracking. Not a modern-protocol solution unchanged. |
| **[elazarl/goproxy](https://github.com/elazarl/goproxy)** | Public Go library, filters, configurable transport, MITM. Closest lineage. | `AllowHTTP2` opt-in; ALPN dispatch to `http2.Server.ServeConn` (`https.go:499-519`, `http2.go:114`). Upstream transport is separate; example enables `ForceAttemptHTTP2`. Explicit WS relay preserves buffered upgrade bytes (`https.go:650-676`). Optional `CertStore`, not automatic. | First engine-upgrade spike. Stripe-only fields/hooks and Smokescreen type imports preclude assuming a go.mod replacement works. Supply bounded, expiring cache; explicitly secure transport. Current signer uses CA-secret-derived randomness rather than independent fresh leaf keys. |
| **[google/martian](https://github.com/google/martian)** | Request/response modifiers, testing/debugging proxy, MITM package, special h2 stream processing. | MITM `TLS()` advertises h1; `TLSForHost()` allows h2 only for configured hosts (`mitm/mitm.go:195-233`). Normal transport disables h2; special `h2/h2.go:57-95` path dials separately. Core WS relay not established: **UNVERIFIED**. Host cert map is unbounded; checks cached expiry; shared random RSA leaf key (`mitm/mitm.go:121-150,248-315`). | Archived; do not start a new security boundary on it. Special h2 path's direct `tls.Dial` would bypass our adjudicated-IP dial unless adapted. |
| **[AdguardTeam/gomitmproxy](https://github.com/AdguardTeam/gomitmproxy)** | Go MITM proxy and customizable `CertsStorage`; README lists WebSockets. | Default map certificate storage; bounding/expiration guarantees **UNVERIFIED**. Intercepted/upstream h2 **UNVERIFIED**, not inferred from TLS support. | README explicitly says **deprecated, unsupported, to be removed**. GPL-3.0; not a sensible new embedded dependency here. |
| **[lqqyt2423/go-mitmproxy](https://github.com/lqqyt2423/go-mitmproxy)** | Go library, addon hooks, debug UI; `Requestheaders` supports header-stage work. | Real h2 ServeConn; eager mode mirrors upstream ALPN, lazy mode advertises h1 (`proxy/attacker.go:127,345-368,433`). Dedicated WS/message hooks (`proxy/websocket.go`, `proxy/addon.go`). LRU-100 + singleflight certificate cache. | Modern protocols, but CA implementation needs replacement: `cert/self_sign_ca.go:353-361` sets leaf `PrivateKey: &ca.PrivateKey` (same key as CA); one-year leaves, no expiry check seen on cache hit; persistence uses `os.Create`, not explicit 0600. These are source findings, not an exploit claim. Keep UI and body-inspection features out of production. |
| **[paradigmxyz/iron-proxy](https://github.com/paradigmxyz/iron-proxy)** | Purpose-built Go egress/injection proxy, independent `net/http` implementation. See §3. | Advertises intercepted h2 and enables HTTP/2 server; upstream `ForceAttemptHTTP2`; explicit h1 WebSocket relay. Bounded expiring fresh-ECDSA leaf cache. | Strong pattern donor, not drop-in library; most implementation is internal. Avoid replacing our policy plane with its YAML/DNS/transparent-mode assumptions. |
| **Go standard `net/http`, `crypto/tls`** | HTTP server/transport, TLS, Upgrade-capable building blocks. No dependency or third policy engine. | Can serve decrypted connections through an HTTP server (Iron demonstrates this). Does not provide a complete forward MITM proxy or leaf cache. | Appropriate for a narrowly scoped custom adapter, not a justification to write our own HTTP parsers or recreate an engine without protocol tests. |
| **[mitmproxy](https://github.com/mitmproxy/mitmproxy)** (not Go) | Mature external interception executable, Python addons. | Official [protocol docs](https://docs.mitmproxy.org/stable/concepts/protocols/) cover h1/h2 translation, WS, generic TCP/TLS and UDP/DTLS; h2c unsupported, h1 trailers unsupported. Leaf-cache implementation not inspected: **UNVERIFIED**. | Useful interoperability oracle / external alternative. Not embeddable Go; another runtime and authorization/dialing bridge. Not the minimum production stack. |

Upstream source snapshots inspected: elazarl `c150a338c02550eedace75f4baad4f73c0605b3c`; Martian `0f7e6797a04da412118541344bbe0d65945e24c9`; Adguard `3ba2cd5e15691cef79f0b655085a789dd8fcfb44`; lqq `07e0ca55ae1739a936147ac9878de0fa25f53a90`. File references in this table refer to these snapshots.

### Maintenance, license, security record

| Project / stewardship | Stars; last push | Latest GitHub Release | License / security assessment |
|---|---|---|---|
| Stripe goproxy / Stripe | 26; 2026-11-18 | No release returned; we pin a pseudo-version | BSD-3-Clause. Small fork, divergent API and signer; upstream fixes require applicability review. |
| Smokescreen / Stripe | 1,413; 2026-11-18 | v0.1.0, 2026-09-21; **not** our v2 module pin | MIT. Historical SSRF normalization bypasses; current MITM defenses warrant retention. |
| elazarl / Elazar Leibovich, Erik Pellizzon listed by project | 6,774; 2026-11-12 | v1.9.4, 2026-11-12 | BSD-3-Clause. Recent security fix below; do not select older upstream releases. |
| Martian / Google | 2,038; 2024-12-18; **archived** | v3.3.3, 2024-04-16 | Apache-2.0. No active upstream maintenance implied by Google's name. |
| gomitmproxy / AdGuard | 348; 2026-08-18 | v0.2.1, 2021-03-22 | GPL-3.0; explicit deprecation is stronger evidence than recent push timestamp. |
| go-mitmproxy / lqqyt2423-led | 1,591; 2026-11-12 | v1.9.5, 2026-11-12 | MIT; README currently requires Go 1.26+. Small-project concentration; certificate/key risks above. |
| Iron / Paradigm, formerly ironsh URL | 877; 2026-11-19 | v0.59.0, 2026-11-19 | Apache-2.0; fast-moving product. Security audit/complete advisory history **UNVERIFIED**. |
| mitmproxy / mitmproxy team | 47,149; 2026-11-19 | **UNVERIFIED** (API rate limit) | MIT; mature protocol reference, not assessed here for complete advisory history. |

**Verified advisories, not just search snippets:**

- [CVE-2026-133185](https://cve.circl.lu/cve/CVE-2026-133185): upstream goproxy **before v1.9.4** derives RSA/Ed25519 MITM leaf private keys from public data through misuse of `hash.Sum` in `NewCounterEncryptorRandFromKey`. An observer with CA certificate and a leaf certificate can reconstruct that leaf key. [Fix commit](https://github.com/elazarl/goproxy/commit/c150a338c02550eedace75f4baad4f73c0605b3c), [PR #822](https://github.com/elazarl/goproxy/pull/822). **Do not mechanically assign the upstream version range to Stripe's fork**: its active signer uses fresh crypto/rand RSA and does not call that helper. Conversely, a fork's age alone is not proof it is safe.
- [CVE-2023-37788](https://access.redhat.com/security/cve/cve-2023-37788): specially crafted `*` request target can crash MITM-mode goproxy. Exact fix coverage in our fork is **UNVERIFIED**; malformed-target regression testing is a ship gate.
- Smokescreen [GHSA-qwrf-gfpj-qvj6 / CVE-2022-29188](https://github.com/stripe/smokescreen/security/advisories/GHSA-qwrf-gfpj-qvj6): bracketed hostname deny-list bypass; advisory recommends >=0.0.4. Its public advisory listing also includes [GHSA-gcj7-j438-hjj2 / CVE-2022-24825](https://github.com/stripe/smokescreen/security/advisories/GHSA-gcj7-j438-hjj2), another SSRF deny bypass; exact patch ancestry was **UNVERIFIED** here.

Public GitHub advisory endpoints returned no advisories for the queried Stripe goproxy, elazarl, Martian, Adguard, and lqq repositories. This is **not** evidence of no CVEs (the goproxy examples demonstrate why). Full OSV/NVD/transitive-dependency audits, fuzzing, penetration testing, and maintainer-response guarantees are **UNVERIFIED** for every candidate.

## 3. Existing credential-injecting gateways and agent proxies

### Best patterns to reuse

**[OneCLI](https://github.com/onecli/onecli)** — Apache-2.0 core, enterprise directories separately licensed. Rust gateway, TLS MITM, per-agent Proxy-Authorization, encrypted storage, host/path matching and header/query injection. Existing deployment and brief already establish its actual role in cela; we should not reconstruct its management platform merely to remove it. Useful source decomposition: `apps/gateway/crates/ca`, `context`, `inject`, `policy`. Rust cannot be imported as a normal Go library.

Important version distinction: inspected HEAD `90e874c0cf4e059401577f687bee93e9f376bc65` contains `apps/gateway/crates/context/src/refresh_gate.rs`: process-local striped locks plus a **dedicated bounded Postgres refresh pool**, transaction advisory locking, and bounded lock wait/provider calls. This is a direct pattern donor for avoiding pool starvation during refresh. **Whether this code is included in our bundled v2.20.0 is UNVERIFIED**; it does not invalidate the brief's deployed refresh-race finding. Keep release-specific investigation separate from HEAD capabilities.

**[Iron Proxy](https://github.com/paradigmxyz/iron-proxy)** — closest feature fit in Go. README describes credential/proxy-token replacement, default-deny egress, host rules, SSRF/IP checks, explicit HTTP/SOCKS tunnels, WebSocket/SSE, and optional PostgreSQL MITM. It is a complete proxy, not a goproxy wrapper. Source inspected at `c32e47d653256ad7b1638214f60b5859ff94b268`:

- `internal/certcache/cache.go:66-114`: `GetOrCreate(domain string) (*tls.Certificate, error)`, bounded LRU, checks wall-clock expiry, fresh ECDSA P-256 key per leaf; default size 1,000 (`internal/config/config.go:265-266`). Serializes generation under the cache lock: simple, but unrelated misses contend. Leaves populate DNS SANs, not IP SANs.
- `internal/proxy/tunnel.go:383-428`: serves decrypted connections through a real HTTP server and configures h2; a better model than extending an h1 parser loop.
- `internal/proxy/proxy.go:779-918`: WS path guarded at dial time, canonical outbound authority, strips proxy/hop headers, checks upstream 101 before hijacking, preserves buffered bytes, closes upstream on cancellation. `http.Hijacker` path establishes h1 WS, **not** h2 extended CONNECT.
- `internal/proxy/proxy.go:1030-1048`: separately configured upstream transport with h2 enabled.

Copy small licensed patterns, with attribution and tests; importing another project's `internal` packages is prohibited by Go. Do not adopt transparent capture, a separate DNS server, or broad default policies contrary to ADR 0038. A full replacement would be a new policy/revocation integration project, not a dependency update.

**[Fly Tokenizer](https://github.com/superfly/tokenizer)** — compact Apache-2.0 Go proxy: client submits a public-key sealed credential and authorization constraints via `Proxy-Tokenizer`; proxy injects the unsealed secret. `allowed_hosts` prevents using a valid sealed token against an echo endpoint. README explicitly recommends combining with Smokescreen if exposed to public/untrusted addresses. It otherwise permits private destinations.

Key limitation: client uses **HTTP URL/plaintext to proxy**, proxy upgrades upstream to HTTPS; it assumes VPN/private transport and is not a transparent HTTPS CONNECT MITM replacement. Useful patterns: binding constraints to the sealed object, stripping proxy credentials, fixed authorized header destinations, statelessness. Avoid query injection (logs) and client-selected format/destination flexibility. Existing cela sealed bindings and pod-bound tokens already cover much of its envelope/auth role; adopting its wire format creates unnecessary migration. Snapshot `b6d819bca67399e931cf52ad7028cad2021a0ad1`; processors include HMAC/SigV4 and token exchanges, none required for our minimum header swap.

**[Agent Substrate / atenet-egress](https://github.com/agent-substrate/substrate)** — [credential injection guide](https://ate.dev/docs/guides/egress-credential-injection/) is unusually relevant: HTTPS termination/reorigination, declarative destination policy, external credential provider, actor identity, gateway/provider mTLS with SPIFFE identity. Provider handles both storage and authorization. The gateway fails closed for unavailable/malformed/empty/control-character credentials; `replaceHeaders` only replaces headers present on the request. Pattern worth copying: separate authenticated actor, authorized credential selection, header-value validation, and explicit fail-closed behavior.

Not an embeddable Go MITM library: documented dataplanes are Envoy/ext_proc or agentgateway. Kubernetes credential-provider sample has substantial Secret-read RBAC; namespace policy loaded at startup and credential cache TTL (10s) affect revocation. Guide also documents actor JWT cache/name-reuse UID-confusion risk up to roughly 2/3 token lifetime. Do not copy these cache/identity assumptions into our immediate-revocation design. Source snapshot `8368e765b5ede1f601cde3d8f03fd920eda0e481`; no runtime deployment tested.

**[Envoy credential_injector](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/credential_injector_filter)** — production dataplane building block: generic SDS credentials injected as Basic/Bearer Authorization; configurable overwrite and allow-without-credential. Use fail-closed settings, not the documentation example's `allow_request_without_credential: true`. OAuth extension supports **client_credentials**, not arbitrary rotating user refresh grants. Docs expressly distinguish workload authentication from end-user authentication.

Envoy is C++, not an in-process Go dependency; this filter alone neither terminates arbitrary CONNECT TLS nor selects a credential by our session binding. Needs TLS interception config, per-request authorization/secret selection, and a bridge to our policy/IP resolver. Ext_proc can externalize selection but adds a network control path. Strong semantics reference; poor minimum stack unless Envoy is already the intended dataplane.

### Other contemporary and adjacent candidates

| Candidate | Verified offering / fit | Maturity, license, risks |
|---|---|---|
| **[Infisical Agent Vault](https://github.com/Infisical/agent-vault)** | Go standalone vault + HTTP MITM proxy; README describes dummy substitution or complete header replacement, service restrictions, temporary agent tokens. Same problem domain, not a small library. | 2,524 stars; push 2026-11-22; latest release **UNVERIFIED**. LICENSE: MIT Expat outside `ee/`, separate enterprise terms inside; API says NOASSERTION, so use actual LICENSE. **README explicitly no longer recommends standalone project for any new setup**, directing users to integrated Infisical Agent Vault. Default unmatched hosts forward unless strict deny is enabled. Protocol/cache internals and independent audit **UNVERIFIED**. Patterns only, not recommended dependency. Snapshot `16ec8d5a5db38be9d2c77fe9c19c7fd7125246ba`. |
| **[OpenShell](https://github.com/ai-openshell/openshell)** (formerly NVIDIA/OpenShell) | README describes sandbox kernel enforcement and credentials added only for approved endpoints; a full agent runtime, not our missing header helper. | Earlier NVIDIA API snapshot: 21,880 stars; push 2026-11-23; Apache-2.0. README says development moved to CNCF `ai-openshell/openshell`; inspected snapshot `9c3c92f1023e15e711ab710cc67f0e490b46784c`. Latest release and MITM/h2/WS/key-cache internals **UNVERIFIED**. Scope far exceeds replacing OneCLI; formal-policy-verification claims not independently evaluated. |
| **[Tailscale Aperture](https://tailscale.com/docs/aperture)** | Official docs: identity-bound AI gateway, LLM provider authentication injection, HTTP/API connectors and MCP proxying. Good pattern: callers carry identity, not provider keys. | Product documentation verified; an OSS embeddable Aperture gateway implementation, license, stars, release, and MITM internals **UNVERIFIED**. Do not confuse open-source Tailscale clients with a verified open-source Aperture dataplane. Product/service alternative, not a selected library. |
| **[Teleport Application Access](https://goteleport.com/docs/enroll-resources/application-access/guides/connecting-apps/)** | Identity-aware application reverse proxy; documentation search surfaces header rewrite / Teleport JWT forwarding. Appropriate for predefined internal apps, not generic session egress. | 21,127 stars; v18.11.10 (2026-11-16), push 2026-11-17; Teleport-maintained, current repo AGPL-3.0 with per-component licensing caveats. **Detailed header behavior UNVERIFIED**: direct doc extraction failed, search results alone were not treated as source review. No claim that its headers implement our secret store/OAuth refresh. |
| **[Pomerium](https://github.com/pomerium/pomerium)** | [Header docs](https://www.pomerium.com/docs/reference/routes/headers) verified: static headers, `${pomerium.access_token}` / ID token substitution, remove headers. Trusted upstream receives user credential. Reverse-proxy identity gateway, not CONNECT MITM. | 5,114 stars; v0.34.1 (2026-11-11), push 2026-11-22; Pomerium team; Apache-2.0 core. IdP access-token forwarding is not a general provider-specific refresh vault; hosted-authenticate availability limitations apply. Separate Envoy-backed platform; no reason to embed for one header. |
| **[smallstep certificates](https://github.com/smallstep/certificates)** | Private PKI issuance, ACME/provisioners and CA lifecycle; useful if centralized CA custody/rotation becomes a requirement. Not a credential-injecting egress proxy. | 9,093 stars; v0.30.2 (2026-03-23), push 2026-11-16; Smallstep; Apache-2.0. CA service introduces availability/authentication/operations; see §4. |

Other directly relevant maturity snapshots: OneCLI **3,653** stars, latest **v2.20.0 (2026-11-09)**, pushed same date; Fly Tokenizer **509**, push **2026-11-18**, no latest GitHub Release returned; Agent Substrate **8,187**, push **2026-11-22**, latest release **UNVERIFIED**, Apache-2.0; Envoy **29,282**, **v1.40.2 (2026-10-27)**, push **2026-11-23**, Apache-2.0, Envoy/CNCF stewardship. Full security audit/advisory coverage for these gateways is **UNVERIFIED**; empty public advisory lists for Substrate, Agent Vault, and OpenShell do not establish safety.

**Shared limitation:** secret-hiding is not credential-usage confinement. An allowed API endpoint can echo headers, create a new credential, trigger a webhook, or act as an exfiltration oracle. No library listed proves this impossible. Host+port/path/provider scope, installation-token permissions and negative tests are still ours to own. Do not generalize a project's “eliminates exfiltration” marketing into that guarantee.

## 4. CA and leaf certificates: avoid a second PKI system

| Building block | Gives us / maturity | Fit and cautions |
|---|---|---|
| **[`crypto/x509`](https://pkg.go.dev/crypto/x509#CreateCertificate), `crypto/ecdsa`, `crypto/rand`, `crypto/tls`** | Standard Go implementation and security maintenance; BSD-3-Clause Go distribution, version follows Go toolchain (our go.mod says 1.27, installed patch not verified). `CreateCertificate` signs a leaf from a template, issuer, leaf public key and signer. | First choice for a tiny leaf policy. Set random positive serial, DNS SAN or IP SAN correctly, ServerAuth EKU, non-CA leaf, short validity clamped to issuer expiry. Generate leaf key independently of CA key. No hostname cache/rotation policy is provided automatically. |
| **Existing Stripe signer/cache** | Already imported, fresh RSA and bounded cache; §1. | Reuse rather than add certmagic/a CA daemon. Tighten long validity and expiry handling; add per-host singleflight only if signing bursts warrant it. Store cache by normalized host + CA generation; rebuild on issuer rotation. |
| **[`go.step.sm/crypto/x509util`](https://pkg.go.dev/go.step.sm/crypto/x509util)** | Smallstep's reusable template/SAN/certificate utilities; `CreateCertificate(template, parent *x509.Certificate, pub crypto.PublicKey, signer crypto.Signer) (*x509.Certificate, error)`. Repo smallstep/crypto: 109 stars; v0.92.1 (2026-11-21), pushed same day; Apache-2.0. | Good if already using Smallstep templates/signers. More machinery than a fixed MITM leaf template; does not inherently supply a bounded hot-path hostname cache. |
| **smallstep/certificates (`step-ca`)** | Private CA server, issuer policy and renewal integration. Lifecycle tooling rather than just leaf signing. Maturity above. | Use only if we intentionally move signing authority out of proxy pods or already operate it. Remote per-host signing on cache miss adds latency/outage dependency and a powerful signing identity. Central signing does not remove private leaf keys from the proxy or automatically constrain endpoint use. |
| **Iron cert cache pattern** | Fresh P-256, bounded expiring LRU, small implementation. | Copy minimal pattern if replacing fork signer/cache; add IP SAN handling if authorized IP literals are supported. Avoid global cache lock around expensive signing at high churn. |

Recommended custody boundary (design recommendation, not existing implementation): keep root key out of sandbox and, where practical, offline; issue a short-lived proxy intermediate, mount its key only in intended injection pods, distribute only trust certificates to clients, rotate with overlapping trust and cache invalidation. At minimum, an explicitly generated private deployment CA must replace the embedded sample key. Cache only certificate/key material, **not** authorization or session identity. Bounded cache, handshake timeouts/rate limits and authorization before issuance limit hostile hostname cardinality/CPU exhaustion. Sharing a leaf between sessions is not inherently a credential mix-up; sharing a credential-bearing transport/session state can be.

Smallstep or another remote signer is not automatically necessary. The cost/blast radius of putting CA signing material in the proxy remains a real security delta even with a familiar library.

## 5. OAuth refresh: local reuse versus durable coordination

### Reusable Go components

- **[`golang.org/x/oauth2`](https://pkg.go.dev/golang.org/x/oauth2)**, Go team, BSD-3-Clause; repository snapshot 5,908 stars, push 2026-11-09, no GitHub Release returned. Source read at `0f01e8215572819016fac21b005f5f32ba407798`, [`oauth2.go`](https://github.com/golang/oauth2/blob/0f01e8215572819016fac21b005f5f32ba407798/oauth2.go):
  - `Config.TokenSource(ctx context.Context, t *Token) TokenSource` returns a mutex-protected `reuseTokenSource` which caches valid tokens and synchronizes refresh.
  - `TokenSource.Token()` must be concurrent-safe; returned tokens must not be modified.
  - **Share one source per credential**. Building one per HTTP request defeats local serialization.
  - Internal token refresher updates its refresh-token field; **it does not persist the new refresh token to our database**. Durable rotation is application work.
  - `ReuseTokenSourceWithExpiry` supports an early-expiry margin. Use a bounded provider HTTP client/context; a TokenSource retains the context it was created with, so do not accidentally bind a long-lived source to one cancelled sandbox request.
  - Provider-specific Codex request/response details, refresh semantics, and library compatibility are **UNVERIFIED**. Do not assume generic OAuth support fixes a nonstandard provider protocol.
- **[`golang.org/x/sync/singleflight`](https://pkg.go.dev/golang.org/x/sync/singleflight)**, Go team, BSD-3-Clause; repo 939 stars, push 2026-11-09, no GitHub Release returned. Already indirect in this Go module. `Group.Do` coalesces simultaneous work for a key; it is not a persistent token cache and not a distributed lock. Useful around a durable refresh function or certificate creation. A shared ReuseTokenSource already serializes its own local refresh, so adding both without a reason is redundant.
- **Postgres transaction advisory locks**, existing database rather than Redis/another lock service. [Locking docs](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) establish automatic transaction-end release; [function reference](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS) describes the advisory lock APIs. No new Go dependency needed beyond our DB driver. Installed server version is **UNVERIFIED**. PostgreSQL License; PostgreSQL Global Development Group stewardship; GitHub stars/releases are not meaningful selection metrics for a facility in our existing database.

### Minimal multi-replica pattern

This is a recommended pattern, not code already wired into cela:

1. In the **trusted credential-owning writer**, start a transaction; set a bounded lock wait and overall operation deadline. Acquire `pg_advisory_xact_lock` using a stable credential ID/namespace (not an access-token string or process-random hash).
2. **Reread after acquiring the lock**, including current version and expiry. If another replica refreshed, use its committed result. Advisory locks protect only cooperating refreshers; every writer path must follow the same protocol.
3. If still due, refresh using the current stored refresh token and a strict provider timeout. Holding a DB transaction during the network request is the straightforward correct lock scope, but occupies a connection. Bound concurrency; consider a small separate pool as OneCLI HEAD does, rather than starving ordinary traffic.
4. Atomically persist encrypted access token, rotated refresh token, expiry and new version, with `UPDATE ... WHERE id = ... AND version = ...`. Check exactly one affected row; CAS detects out-of-band edits even when advisory locking is cooperative. Preserve the old refresh token if the provider omits a replacement, per provider semantics.
5. Commit before publishing the new cache value. Do not log bearer/refresh tokens or return plaintext credentials to the sandbox. Invalidate local credential caches on edits/revocation/version changes.

A crash **after provider rotation but before database commit** cannot be made atomic with a Postgres lock: provider and database are separate systems. Recovery may require provider grace/idempotency or reauthentication; these capabilities are **UNVERIFIED** for Codex. A lease expiring mid-refresh has the same risk, which is why a casually implemented expiring distributed lock is not a substitute.

Our proxy's DB role is intentionally read-only except status (ADR 0035); granting refresh-token writes to it would violate that boundary. Prefer orchestrator-owned refresh/storage and short-lived access-token bindings if the proxy needs tokens. If refresh stays in TypeScript, implement the same database protocol there; adopting a Go package is not a reason to move ownership.

## 6. TCP, SOCKS5, and git SSH

### CONNECT already does opaque TCP

Fork `https.go:133` onward, `ConnectAccept`, dials the requested host:port and copies bytes; it does not require an HTTP protocol on those bytes. Smokescreen is an HTTP forward proxy, **not a SOCKS listener**. No SOCKS entry point was found in the inspected source. There is no fundamental “TLS-only” limitation in the raw CONNECT relay; application rule/port checks, upstream chaining and network policy still determine whether a port is usable.

Today the brief establishes `publicPorts` 80/443 and existing rule `ports`. Therefore the first TCP slice can be: authorize the extra exact host:port, expose only the needed outbound network ports, keep raw CONNECT route, preserve session/pod binding and revocation. A CONNECT to port 22 must **not** select MITM or attempt to parse SSH as TLS. UDP, transparent capture, STARTTLS interpretation and database password injection are separate scope; skip them.

### SOCKS candidates

| Library / stewardship | What it provides | Maturity/license | Fit / risks |
|---|---|---|---|
| **[things-go/go-socks5](https://github.com/things-go/go-socks5)** / things-go | Server, username/password or custom authenticator, rules, resolver, TCP CONNECT, UDP ASSOCIATE; BIND listed TODO. `WithDialAndRequest` exposes original request; `Request.AuthContext`, `Request.RemoteAddr`, FQDN are available. | 616 stars; push 2026-11-12; v0.1.4 (2026-10-28); MIT. Derived from armon, more active extension points/tests. | **First choice if SOCKS is justified.** `handle.go:55-78` resolves before rules; default resolver returns one IP, not our complete judged address set. Override resolution/policy/dial deliberately, with all-IP checks and direct judged-IP dialing. Default/no-auth/UDP behavior must not leak into our listener. |
| **[armon/go-socks5](https://github.com/armon/go-socks5)** / armon | Small TCP CONNECT server, auth, RuleSet, resolver, custom dialer; BIND and ASSOCIATE TODO. | 2,121 stars; last push 2024-06-14; no GitHub Release returned; MIT. Long-lived, small, relatively quiet. | Easier to read but less active. Reasonable minimal fallback if newer fork adds unwanted behavior. Still no native cela identity/revocation/all-IP policy. |
| **[txthinking/socks5](https://github.com/txthinking/socks5)** / txthinking | Low-level protocol structs plus classic client/server, TCP/UDP IPv4/IPv6; custom TCPHandle/UDPHandle. Used by Brook and other networking tools per README. | 785 stars; push 2026-06-01; no GitHub Release returned; MIT. | Better when custom protocol handling is desired; broader UDP surface, lower-level integration burden. Less natural than things-go's request-aware dial hooks for our existing evaluator. |

Inspected snapshots: things-go `a6a0a4519b359f7cf52376060b127ca7b54ec5a1`; armon `e75332964ef517daa070d7c38a9466a0d687e0a5`; txthinking `339b044ab0eb8485292330ab589ab4c80d8e4390`. Full advisory histories/security audits for **all three are UNVERIFIED**. Stars are not a security endorsement.

SOCKS integration must reuse the evaluator, not Smokescreen's HTTP parser: authenticate the egress token and real peer pod IP, retain original hostname, resolve remotely (`socks5h` clients), authorize all candidates and port, dial only the judged IP, register both halves for revocation/idle limits. Reject BIND and UDP ASSOCIATE; no-auth is forbidden. Standard SOCKS username/password negotiation is **not encrypted**; the same observation/theft concern as HTTP proxy credentials on a plaintext pod network applies. Validate token length/encoding against SOCKS' one-byte username/password lengths; compatibility with our token format is **UNVERIFIED**. Never log credentials or place long-lived secrets in process arguments.

### SSH-over-proxy for git

- OpenSSH does not automatically use `HTTPS_PROXY`. Its documented [`ProxyCommand`](https://man.openbsd.org/ssh_config#ProxyCommand) can run a byte-relay helper supporting HTTP CONNECT or SOCKS, with destination `%h`/`%p`. `ProxyJump` is an SSH bastion, **not** an HTTP/SOCKS client. A helper must support our proxy authentication; packaging/credential-delivery details are **UNVERIFIED**. Do not publish a shell example that leaks the egress token through argv.
- [`ssh.github.com:443`](https://docs.github.com/en/authentication/troubleshooting-ssh/using-ssh-over-the-https-port) is GitHub's documented SSH-over-443 endpoint, distinct from github.com. It remains SSH, not HTTPS. Through a raw CONNECT route, it can avoid adding port 22, but needs an exact policy grant and genuine SSH client credentials; GitHub Enterprise/data-residency exceptions apply.
- **GitHub installation tokens cannot authenticate the SSH protocol.** Raw TCP gives reachability, not GitHub credential injection. Keep git HTTPS + repo-scoped installation-token injection as the smallest path for today's use case. If SSH is truly required, define short-lived SSH credentials/agent access separately rather than putting a private key into a generic TCP tunnel feature.
- Database clients that lack proxy settings need a local explicit TCP bridge/SOCKS-capable wrapper or remain direct-mode only. This is client integration, not evidence that transparent interception is necessary. No raw TCP secret mutation recommended.

## 7. Ranked shortlist and recommended stack

Ranked for **our installed Smokescreen-based proxy**, not by popularity:

1. **Keep pinned Stripe goproxy + Smokescreen for a constrained h1 injection slice and broader raw CONNECT ports.** Existing signer/cache are enough building blocks. Explicitly secure upstream transport; narrow leaf lifetime; attach secrets only after authorization; integrate inner-request identity/dial tracking/revocation. This ranking is conditional on h1 being acceptable—do not promise h2/WS.
2. **Spike current upstream elazarl/goproxy >=v1.9.4 for modern intercepted protocols.** Closest lineage and public library API. Compare/port Stripe-specific hooks rather than blind module replacement; retain Smokescreen security semantics. If h2/WS are day-one requirements, this spike is a prerequisite and option 1 alone is insufficient.
3. **Borrow Iron's focused HTTP-server/WS/certificate patterns** if upstream adaptation is worse than a small, explicit MITM adapter. Do not wholesale replace our policy plane or depend on unexported internal packages. Iron is also the most relevant complete-Go-proxy alternative to evaluate if we decide the current engine is the wrong foundation.
4. **Add things-go/go-socks5 only for demonstrated client need.** CONNECT-first avoids another auth listener/parser. Reject UDP/BIND and connect through the same session/evaluator/revocation path.
5. **Use standard x509 plus existing cache, and standard OAuth components in the credential owner.** Smallstep `x509util` only if template/signer integration is actually needed; `step-ca` only for deliberate centralized PKI. Use `x/oauth2` if refresh owner is Go; otherwise keep existing language ownership. Postgres transaction lock + reread + CAS is the durable coordination mechanism either way.

**Recommended minimum stack:** existing Smokescreen/Stripe fork + strict injection binding (exact authority/header, body untouched), explicit verified `http.Transport`, private deployment CA/short-lived leaves using standard crypto, existing bounded certificate cache, existing Postgres sealed-binding reader, orchestrator-owned refresh/minting, existing raw CONNECT and evaluator for extra TCP ports. No Envoy, new vault platform, CA daemon, SOCKS listener, or Redis unless a concrete requirement justifies it. Fly Tokenizer, OneCLI HEAD refresh gating, Agent Substrate fail-closed provider behavior, and Iron are reference patterns—not four more runtime dependencies.

**Modern-protocol escape hatch:** if we cannot preserve judged-IP dialing, per-inner authorization, streaming, h2 stream isolation and prompt revocation while adopting upstream goproxy, keep current OneCLI integration temporarily rather than ship an unchecked fork/adapter. Reject archived Martian, deprecated Adguard, and unmodified lqq certificate custody for this boundary. Full platforms (Envoy/Substrate/Infisical/OpenShell/Teleport/Pomerium) only become attractive if we intentionally change the dataplane/identity architecture.

### Checks still required before selecting/shipping

No build, live bakeoff, exploit reproduction or performance tests were run for this research-only document. Specific acceptance gates:

- invalid/expired upstream cert rejected while hostname verification/SNI survives judged-IP dialing;
- CONNECT authority vs SNI vs inner Host/URL mismatch, malformed `*` target, duplicate/smuggled headers and proxy-auth stripping;
- exact session/binding isolation under keepalive, concurrent requests, upstream pool reuse and h2 multiplexing;
- no dial path (normal HTTP, WS, h2, SOCKS) bypasses all-IP policy or revocation registry;
- credential missing/malformed/decryption failure is fail-closed; no header/body/query/log leaks; allowed echo endpoint risk explicitly bounded;
- WS early buffered data, bidirectional cancellation, non-101 rejection, streaming/SSE backpressure, body untouched;
- certificate expiry/CA rotation invalidates cache, bounded churn, concurrent miss CPU, restrictive key-file permissions;
- two-replica rotating refresh race, post-lock reread, CAS failure, DB/provider timeout, pool starvation, crash-after-rotation recovery;
- authenticated arbitrary-port CONNECT and SOCKS with remote DNS, IPv6/IP literals, denied UDP/BIND, actual client token length and no argv leakage.

These are not supplied automatically by choosing a library; they are the cost of preserving cela's existing security boundary.
