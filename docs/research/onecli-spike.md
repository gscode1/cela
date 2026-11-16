# OneCLI as the credential layer: spike (2026-11-15)

Target: c2 `onecli` deployment, image `ghcr.io/onecli/onecli:latest`, which reports **v1.45.0** (`/api/health`). The `:latest` tag of this all-in-one image stopped at v1.45.0 (2026-07-31). Docs and repo HEAD (v2.20) describe a newer product, so I read source at tag v1.45.0. Live tests used pods in `pi-durable-poc` and dummy values only. All `pi-spike-*` objects are deleted.

## Blocking for the plan
1. **The gateway is an open relay.** A request without a token is not rejected: it gets a raw TCP tunnel to any host:port, including `kubernetes.default.svc:443`, `onecli:10254` and Postgres :5432. There is no host allowlist or deny setting. The 4b/4c egress control therefore has to be a Cilium policy on the gateway pod (FQDN allow, cluster CIDRs denied), not OneCLI config.
2. **No per-repo scope in this edition.** The GitHub grant `resources.repositories` is locked to OneCLI Cloud (422). Use the per-session secret with `pathPattern` workaround (Q4), or a GitHub App token we mint ourselves.
3. **Tokens have no TTL and no IP/pod binding.** Mitigate by creating one agent per session, regenerating or deleting it on `ensure()`/delete, and using NetworkPolicy.
4. **The management API is unauthenticated, and `GET /v1/agents` returns every agent's `accessToken`.** Enabling auth (Q8) gates real credentials. The existing data belongs to the `local-admin` user and needs a plan when auth is switched on.
5. **Git needs `http.proxyAuthMethod=basic`.** The gateway never sends a 407 challenge, so libcurl waits for one and never authenticates (Q3).

## Q1 Subscription OAuth: YES (source + API; not live-injected)
- Secret types are `anthropic`, `openai`, `generic`. An `openai` secret whose value is a Codex `auth.json` (`tokens.access_token` and `refresh_token`) is stored with `authMode: oauth`, host `chatgpt.com`.
- Evidence: `POST /v1/secrets {type:"openai", value:<dummy auth.json>, hostPattern:"chatgpt.com"}` returned 201 and `metadata:{authMode:"oauth", accountId:"<redacted>"}`.
- Source `secret_inject.rs`: injects `Authorization: Bearer <access_token>` and `chatgpt-account-id`. It covers `chatgpt.com`, `*.chatgpt.com`, `api.openai.com` and `*.openai.com`. The gateway refreshes the token with the Codex CLI client id against `auth.openai.com` and re-encrypts it. v1.45 intercepts the Codex `onecli-managed` refresh stub.
- Not tested: a live call to chatgpt.com (it would send a dummy to a real service).
- **pi-ai caveat:** the `openai-codex-responses` provider derives `chatgpt_account_id` by decoding the apiKey as a JWT (`extractAccountId`). The sandbox needs a JWT-shaped placeholder with that claim, because the gateway only replaces the headers. It defaults to a WebSocket transport (`options.transport`); force `"sse"` unless WebSocket-through-gateway is proven (UNVERIFIED).
- Plan 4b: the OAuth fallback is not needed, but the first real Codex call is still to be verified.

## Q2 Injection: YES
- Agent `pi-spike-a`, generic secret on `postman-echo.com` (`x-pi-spike-key: Bearer {value}`), grant by `PUT /v1/agents/{id}/grants/secrets/{secretId}`.
- `curl --cacert ca.pem -x "http://x:<redacted>@onecli.onecli:10255" https://postman-echo.com/headers` showed `"x-pi-spike-key":"Bearer pi-spike-dummy-123"`.
- **Token format:** `aoc_` + 64 hex. It is sent as `Proxy-Authorization: Basic base64("x:<token>")`, which is userinfo in the proxy URL (username is anything, token is the password). `Bearer` returned 000/failed.
- **CA:** `GET http://onecli.onecli:10254/v1/gateway/ca` (no auth, PEM, 638 bytes). The CA is `OneCLI Local Gateway CA` and persists in `/app/data`. Mounting it from a ConfigMap is feasible.
- **Bad token:** 407. **No token:** not rejected (200 via tunnel, no injection); see Q6.
- Plan 4b: the credential delivery model works as designed.

## Q3 git over HTTPS: YES with a client setting
- Source `apps.rs`: the `github` and `github-app` providers inject `Authorization: Basic base64("x-access-token:<token>")` on `github.com` (Bearer on `api.github.com`).
- Test: a generic secret on `github.com` carrying a dummy Basic value. Without a token, a public clone worked through a tunnel (log: `mode="tunnel"`). With a token and **default git settings**, the clone was still a tunnel with no injection (git sent no Proxy-Authorization). With `git -c http.proxyAuthMethod=basic`, the gateway logged `mode="mitm" agent="pi-spike-a"`, the issuer was the OneCLI CA, and GitHub answered **401** to the injected dummy credentials. That proves the Basic header went out.
- Push uses the same host, so the same injection (not tested; needs real credentials).
- Plan 4c: set `http.proxyAuthMethod=basic` plus `http.sslCAInfo`; the proxy URL carries the token.

## Q4 Per-repo scoping: NO natively; workaround verified
- Grants are per connection or secret. Connection grants take per-tool allow/ask lists (path patterns like `/repos/*/*/pulls`, wildcard on owner/repo). `resources:{repositories:[..]}` exists in the schema, but the OSS `ossPolicyValidator` throws 422 "available on OneCLI Cloud" (source; not live-reachable without a connection). `/v1/org/policy` is 404 and project rules return 410.
- GitHub App connection (docs `guides/github-app`): scope is the repo set chosen on GitHub for the whole installation. The 1 h token auto-refreshes, and the dashboard OAuth flow is needed per installation. A self-hosted install needs `GITHUB_APP_ID`, `GITHUB_APP_SLUG` and `GITHUB_APP_PRIVATE_KEY`.
- **Workaround (tested):** a secret has `pathPattern`. A secret with `pathPattern:"/get*"` on the echo host injected on `/get` only, not on `/headers`. For 4c, the orchestrator mints a repo-limited installation token (GitHub supports `repositories:[repo]`), stores it as a per-session generic secret (host `github.com`, `pathPattern:"/owner/repo*"`, Basic format), and grants it to the session agent. The orchestrator then holds the GitHub App key, which is the plan's stated fallback. Refresh by `PATCH /v1/secrets/{id}`.

## Q5 Token binding, TTL, rotation: NO binding, NO TTL
- The `Agent` model has `accessToken` (unique, stored as-is) and no expiry or IP field. The gateway only logs the peer.
- API: `POST /v1/agents {name, identifier}` (201; the token is not in the response, fetch it from `GET /v1/agents`), `POST /v1/agents/{id}/regenerate-token` (200; the old token returned 407 immediately), `DELETE /v1/agents/{id}` (204; the token then failed), `PUT/DELETE /v1/agents/{id}/grants/secrets/{sid}`, `GET /v1/agents/{id}/grants`.
- Plan: per-session agent (identifier `pi-<uuid prefix>`, max 50 chars, lowercase), regenerate on each `ensure()`, delete on session delete. CLI equivalent: `onecli agents create|regenerate-token|delete`, `grants attach-secret`.

## Q6 Forwarding scope: forwards everything
- With a token: `https://example.com` 200; abs-form `http://onecli.onecli:10254/v1/agents` 200 (the management API through the proxy); CONNECT to `kubernetes.default.svc:443` gave 502 `resolution_failed` (a MITM failure, not a deny).
- No token (raw tunnel): `kubernetes.default.svc:443` returned the apiserver's 401 JSON; `onecli:10254/v1/agents` 200; `pi-pg-rw.pi-durable-poc:5432` answered a Postgres SSLRequest with `S`. A closed port errored.
- Gateway env knobs are only `GATEWAY_SKIP_VERIFY_HOSTS` and `GATEWAY_DANGER_ACCEPT_INVALID_CERTS` (source). Per-agent block rules are not available in OSS (Q4).
- Plan: the "deny cluster CIDRs" item must be a CiliumNetworkPolicy on the `onecli` pod egress; sandboxes must not be able to reach the gateway without going through the orchestrator's policy.

## Q7 Node and pi-ai: YES
- node:22.23.5, `HTTPS_PROXY=http://x:<redacted>@onecli.onecli:10255 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=ca.pem`: `fetch` returned `x-pi-spike-key: Bearer pi-spike-dummy-123`. Controls without `NODE_USE_ENV_PROXY`, or with `NO_PROXY=<host>`, showed no injection (so `NO_PROXY` for the cluster works). The Node `EnvHttpProxyAgent` warning is harmless.
- pi-ai 1.5.2 (`api/openai-completions`, custom model with `baseUrl:"https://httpbin.org/anything"`, apiKey `pi-spike-placeholder-key`): the upstream saw `Authorization: Bearer pi-spike-dummy-123`. Without the proxy it saw the placeholder, so the gateway replaces the SDK's key. The openai SDK uses global fetch. Bedrock has its own proxy-agent handling (not tested).

## Q8 Enabling auth for self-hosting (not applied)
- Source (`entrypoint.sh`, `proxy.ts`): setting `NEXTAUTH_SECRET` switches `AUTH_MODE` from `local` (ambient admin, no auth) to `oauth`. It then requires `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` too, or the app redirects to `/setup-error`. No other provider is supported in OSS.
- Steps: (1) create a Google OAuth client with redirect `https://onecli.example.com/api/auth/callback/google`; (2) add the three vars to the `onecli-secrets` Secret and as `env` on the deployment (keep the `onecli-data` PVC: it holds the encryption key and CA); (3) likely also `AUTH_URL`/`AUTH_TRUST_HOST` behind the HTTPRoute (UNVERIFIED); (4) roll the pod; (5) create a project API key in the dashboard and send it as `Authorization: Bearer oc_...` (CLI: `onecli auth login --api-key`). Without a session or key, `/v1/*` returns 401 (non-strict: an invalid `oc_` key falls through to session auth).
- Caveats: **existing data is owned by user `local-admin`** (agents, secrets) and will not be visible to the new Google user (re-create, or update `users.external_auth_id`). NextAuth has no email allowlist, so any Google account can sign in and gets its own project; restrict at the Google consent screen or put auth at the HTTPRoute. Gateway tokens keep working. The gateway port 10255 is cluster-only (the HTTPRoute exposes 10254 only).
