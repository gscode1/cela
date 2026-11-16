# OneCLI v2 re-check of the v1.45 blockers (2026-11-15)

Follow-up to [onecli-spike.md](onecli-spike.md). c2 `onecli` was upgraded from v1.45.0 (all-in-one `ghcr.io/onecli/onecli:latest`) to **v2.20.0**, pinned by tag and digest. This file re-checks blockers 1–5 from the spike on the live v2 instance, with source references to the v2.20.0 tag. All test objects (`bt-*`) were deleted. No secret values appear here.

## Summary

| # | v1.45 blocker | v2.20.0 | Short evidence |
|---|---|---|---|
| 1 | Gateway forwards requests with no proxy token | **Fixed** | 407 on CONNECT and absolute-form, from the Mac and from in-cluster, with no, invalid or `open:` credentials |
| 2 | Open relay to any host and in-cluster targets; no allowlist | **Partially fixed** | Private, loopback, metadata and cluster targets are hard-refused (403). Any **public** host is still relayed by default. An allowlist is possible with explicit org rules, but the "Default Rule: block" switch does not do it |
| 3 | Per-repo GitHub scoping | **Not fixed** (unlicensed) | The `repositories` scope is enterprise-gated and unlicensed connections inject **unscoped**. Path rules can be bypassed with `..`, `/repositories/<id>` and search |
| 4 | Agent token TTL / source binding | **Not fixed** (rotation works) | No expiry or CIDR field. The same token works from the Mac and from a pod in another namespace. `regenerate-token` invalidates the old token immediately |
| 5 | Management API without auth; only Google OAuth | **Auth fixed; options not** | All management routes return 401 without credentials. No-auth mode is gone. Sign-up is **open** and cannot be disabled. Only email+password and Google; SSO/OIDC/SAML/SCIM are enterprise-only (`entitled:false` here) |

`GET /v1/instance` (unauthenticated) returns `{"edition":"onprem","entitled":false,"version":"2.20.0"}`. Enterprise is an honour-system flag, `ENTERPRISE_ENABLED=true` (`packages/api/src/lib/entitlements.ts:5-9,76-81`, `apps/gateway/crates/common/src/edition.rs:35-59`), and it is not set.

## Upgrade notes relevant to pi-durable-k8s

- **Split services.** The pod now has 3 containers plus a migrate init container. The ports are web `:10254` (dashboard), gateway `:10255` (proxy, also `/healthz`) and **api `:10256`** (`/v1/*`). In v1 the API was on `:10254`, so `http://onecli.onecli:10254/v1/...` no longer reaches the API: use `:10256` in-cluster, or `https://onecli.example.com/v1/...`. The HTTPRoute path-routes `/v1`, `/auth`, `/scim/v2` → api, `/gw/*` → gateway, and everything else → web.
- **Proxy address is unchanged:** `onecli.onecli.svc.cluster.local:10255`. The gateway CA was preserved: `/v1/gateway/ca` matches the v1 `/app/data/gateway/ca.pem` (same SHA-256 fingerprint), so existing CA mounts keep working.
- **Auth is mandatory.**
  - v1 data (Default Agent, OpenRouter secret) was adopted by the first registered account. Its credentials and an API key are kept outside this repository.
  - The API takes `Authorization: Bearer oc_...`. API keys are per user (`GET /v1/user/api-key`, `POST /v1/user/api-key/regenerate`).
  - `GET /v1/agents` still returns every agent's `accessToken` in plain text to an authenticated caller.
- **Policy API moved.**
  - `/v1/policy/*` returns 410 ("workspace rules are compiled from agent credential grants").
  - Org rules are at `/v1/org/policy/rules` (CRUD) and `/v1/org/policy/default` (`{"action":"allow|block"}`).
  - Rule shape: `{"name","action","targets":[{"kind":"network","hostPattern","pathPattern"?,"method"?}]}`. Writes take effect at once.
- **Git `proxyAuthMethod`** (spike blocker 5). v2 now answers tokenless requests with 407. That should let git/libcurl authenticate without `http.proxyAuthMethod=basic`. **UNVERIFIED**: keep the setting.
- Backups taken before the upgrade:
  - `pg_dump` of the `onecli` DB.
  - CNPG Backup `pre-onecli-v1-45-20261115t152456z`.
  - A copy of `/app/data`.
  - Longhorn snapshot `onecli-data-pre-v1-45-20261115t152456z`.
  - The v1 rollback image is `ghcr.io/onecli/onecli@sha256:d0177458b1f9ecece4abbe9abb6c5f925475357c1734f50a675d83a2ef9c8687`. The DB migration is forward-only, so a rollback also needs a DB restore.

Post-upgrade health:
- api `/v1/health`: 200, `version 2.20.0`.
- web `/healthz`: 200.
- gateway `/healthz`: 200, and `/gw/healthz` is 200 through the public route.
- `GET /v1/agents` returns `Default Agent`, and `GET /v1/secrets` returns `OpenRouter` (`openrouter.ai`).
- Injection check on `https://openrouter.ai/api/v1/key`: **401 direct, 200 via gateway** with the Default Agent token. The gateway log shows `lane=Mitm host=openrouter.ai:443 agent="Default Ag..."`.

## 1. Tokenless proxy use: FIXED

| Request (via `:10255`) | Result |
|---|---|
| CONNECT `https://example.com`, no credentials / `x:aoc_invalid` / `open:` | 407 / 407 / 407 |
| Absolute-form `http://example.com/`, same three cases | 407 / 407 / 407 |
| In-cluster pod (ns `default`) → `onecli.onecli.svc.cluster.local:10255`, CONNECT and absolute-form, no credentials | 407 / 407 |

Source: `apps/gateway/crates/server/src/lib.rs:943-956` (CONNECT) and `:1160-1180` (absolute-form) refuse a missing token as an "open relay". `proxy/src/tunnel.rs:13` ("no token, no tunnel"). The check is always on; there is no flag.

## 2. Relay scope: PARTIALLY FIXED

**Private and in-cluster targets are refused** with a valid token, on both the MITM lane and the `open` lane. HTTP gets 403 `{"error":"destination_not_allowed"}`. On CONNECT, the MITM lane returns 403 inside the tunnel and the `open` lane returns 403 at CONNECT. Refused targets:
- `kubernetes.default.svc` and `10.96.0.1`
- `onecli.onecli.svc.cluster.local:10256` and its ClusterIP
- a node address (`<node-ip>:50000`) and the LAN gateway
- `127.0.0.1` and `localhost`
- `169.254.169.254`
- `2130706433`, `0x7f.1` and `0`
- `[::1]` and `[::ffff:127.0.0.1]`
- `100.64.0.1`
- `<lan-ip>.nip.io` and `127.0.0.1.nip.io`. The error says "it resolves to …", so the check is on the resolved IP and DNS rebinding is covered.

Source: `apps/gateway/crates/proxy/src/egress.rs` (resolver plus `connect_tcp` guard). The opt-in exception is `GATEWAY_ALLOW_PRIVATE_DESTINATIONS` (CIDR/IP/host/`*.suffix`; metadata only by exact IP). It is not set on c2. The gateway's own Postgres and Redis can never be allowlisted.

**Any public host is still relayed by default.** `https://example.com`, `http://example.com` and `https://api.github.com/zen` all returned 200 with the Default Agent token, on both lanes. So a leaked token is still a general-purpose egress proxy to the internet.

**Allowlist/deny settings:**
- An org block rule on `example.com` returned 403 on both lanes, while other hosts were unaffected.
- **An allowlist works as ordered explicit rules:** `allow openrouter.ai` followed by `block *`. With that, `example.com`, `example.net` and `api.github.com` (open lane at CONNECT) all returned 403, while `openrouter.ai/api/v1/key` returned 200 with the secret injected.
- **`/v1/org/policy/default {"action":"block"}` is not an egress allowlist.** With it set, `api.github.com`, `example.net` and the open lane were still 200. The reason is `policy-engine/src/types.rs:64-66` `enforce_deny() = has_injections && !is_llm_host`, gated in `evaluate.rs:228-243`: the default block applies only to credentialed, non-LLM requests.
- Residual state from the test: the org default is now a persisted `allow` row; before, `allow` was synthetic. Behaviour is unchanged.

**Implication:** Cilium/NetworkPolicy egress on the gateway pod is no longer needed to stop cluster or LAN access. It, or org `allow …` + `block *` rules, is still needed to restrict public egress.

## 3. Per-repo GitHub scoping: NOT FIXED (on this unlicensed instance)

- Connection types: `GET /v1/apps` lists `github` and `github-app` (both `connectionType: oauth`) and `gitlab`. A PAT is a `generic` secret (`validations/secret.ts:272`). No GitHub connection is configured on c2.
- **Native scope is enterprise-gated:**
  - The GitHub App grant `session_policy {"repositories":[...]}` would mint a repo-narrowed installation token per request (`packages/api/src/apps/github-app.ts:78-110`). But `granular_access` is enterprise (`entitlements.ts:29`), and writing it calls `assertEntitled("granular_access")` (`providers/hooks/policy-validator.ts:31-34`, which throws in `entitlements-guard.ts:22-24`).
  - On the gateway side, unlicensed means `session_policy = None`. `apps/gateway/crates/proxy/src/connect.rs:452-473` and `:426-429` say "unlicensed, org connections inject UNSCOPED". **An unlicensed GitHub App/OAuth connection injects an account-wide token.**
  - Live: inconclusive. A POST with a fake connectionId returned 422 (wrong org) before the entitlement check.
- **Path rules are not a sound per-repo boundary.** The test used org rules allowing `api.github.com /repos/onecli/onecli[/*]` and `github.com /onecli/onecli.git/*` and blocking `/repos/*` and `github.com *`:

| Request | Result |
|---|---|
| `/repos/onecli/onecli`, `/repos/onecli/onecli/issues` | 200 |
| `/repos/torvalds/linux` | 403 |
| `/repos/OneCLI/OneCLI` (case) | 403 (case-sensitive; fails closed) |
| `%2F..%2F` encoded traversal | 403 |
| `github.com/onecli/onecli.git/info/refs` vs `torvalds/linux.git/...` | 200 vs 403 (git smart-HTTP scoping works) |
| `--path-as-is /repos/onecli/onecli/../../torvalds/linux` | **200, returned torvalds/linux** |
| `/repositories/2325298` (repo by id) | **200, bypass** |
| `/search/repositories?q=…` | **200, bypass** |
| `raw.githubusercontent.com/...` | 200 (other host, not covered) |

  The matcher (`apps/gateway/crates/inject/src/lib.rs:576-595`) compares raw strings with the query stripped. It does no dot-segment normalisation, so GitHub normalises `..` after the policy check. **Not tested:** whether the same `..` and `/repositories/<id>` bypass applies to a *secret's* `pathPattern` (the spike's Q4 workaround). Assume yes until tested.
- **Recommendation unchanged from the spike:** mint repo-limited GitHub App installation tokens in the orchestrator (`repositories:[repo]`, scoped by GitHub itself). Store each as a per-session secret. Do not rely on OneCLI path patterns for isolation.

## 4. Agent token TTL / source binding: NOT FIXED (rotation works)

- `GET /v1/agents` fields: `id, name, identifier, kind, createdAt, channels, accessToken, imageUrl, lastSeenAt`. There is no expiry, TTL or CIDR field.
- A grep of the gateway crates, `packages/api/src` and the prisma schema (`schema.prisma:436-516`) for expiry or allowed-IP fields found nothing agent-related.
- **Rotation test** (temp agent `bt-agent`):
  - `POST /v1/agents` returned 201 (no token in the response; read it from `GET /v1/agents`).
  - `POST /v1/agents/<id>/regenerate-token` returned 200.
  - The old token got 407 immediately and still 407 after 6 s. The new token got 200. There is no grace period. Source: `packages/api/src/routes/agents.ts:307-320`.
- **No source binding:** the Default Agent token returned 200 on `openrouter.ai/api/v1/key` from the Mac (port-forward) **and** from a pod in namespace `default`. The pod also reached `http://example.com`. `peer_addr` is only logged.
- Mitigation unchanged: one agent per session, regenerate or delete it on lifecycle events, and add a NetworkPolicy restricting who can reach `:10255`.

## 5. Management API auth and options: AUTH FIXED, OPTIONS NOT

**Without credentials (both port-forward and public ingress):**
- **401:** `/v1/agents`, `/v1/agents/<id>`, `/v1/secrets`, `/v1/user`, `/v1/user/api-key`, `/v1/org`, `/v1/org/policy/rules`, `/v1/apps`, `/v1/auth/session`.
- **Open (200):** `/v1/health`, `/v1/gateway/ca` (CA PEM), `/v1/gateway-url` (`{"url":"https://onecli.example.com/gw"}`), `/v1/instance` (edition/entitled/version/origins), and better-auth's `/auth/ok` and `/auth/get-session` (null).
- Source: `packages/api/src/middleware/auth.ts`. A Bearer `oc_` key is a hard 401 on failure; the alternative is a session cookie. The v1 auto-login is gone (`packages/api/src/lib/legacy-local-identity.ts:1-9`).

**Auth options (live: `googleConfigured:false`, `/auth/sign-in/social {"provider":"google"}` returns 404 `PROVIDER_NOT_FOUND`):**
- Email+password is always on (`better-auth.ts:142-152,176-187`; no `disableSignUp`).
- Google OAuth via `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (`packages/api/src/lib/env.ts:88-90`).
- API keys `oc_…`, per user.
- **No** generic OIDC, SAML, forward-auth/trusted-header, allowed-domain, invite-only or sign-up-disable env var.
- SSO (SAML/OIDC), verified domains and SCIM exist but are enterprise-gated: `entitlements.ts:27`, `ee/routes/org-sso-enforcement.ts:64` (`requireEnterprise("sso")`), `ee/routes/org-domains.ts:28`, `ee/scim/*`.

**Sign-up is open by design** (`registration.ts:15-21`: "deliberately offers no registration switch… keeps its dashboard behind the network boundary"):
- Live, `/auth/signup` renders "Create account". `POST /auth/sign-up/email` with an invalid email gave a validation error, not "sign-up disabled".
- Any new sign-up gets its own org, so it can't see the admin org. It does get a working account and can create its own agents, which means gateway egress for anyone who can reach the dashboard.
- Rate limit: 10 sign-ups per 60 s (`better-auth.ts:262-279`).
- `onecli.example.com` resolves only to a LAN IP.
- Sessions last 30 days, sliding.

**Implication:** restrict who can reach the dashboard and `/auth/*`. Options are an Envoy Gateway `SecurityPolicy` (IP allowlist or ext-auth/OIDC in front), or not exposing the HTTPRoute at all and using port-forward. Or license enterprise for SSO.
