# Model credentials and model selection

Every model credential lives in OneCLI. The orchestrator holds only a OneCLI **agent token**; provider API keys in
pi-ai are placeholders that the gateway replaces (for the Codex provider, a JWT-shaped placeholder login: see below). Sandboxes and bridges never see either. Background and test
results: `docs/research/onecli-spike.md` (v1.45) and `docs/research/onecli-v2-recheck.md` (v2.20.0, what runs on the example test cluster).

## Flow

```
orchestrator (pi-ai, apiKey = placeholder)
  --fetch with an undici ProxyAgent, Proxy-Authorization: Basic x:<agent token>-->  onecli.onecli:10255 (gateway)
  gateway: checks the agent token, MITMs TLS with the OneCLI CA, swaps in the real credential --> provider
```

- **Scoped to model and MCP calls.** `createGatewayFetch` (`packages/orchestrator/src/onecli.ts`) is a `fetch` bound to a
  `ProxyAgent`; `withFetch` hands it to pi-ai on every `streamSimple`/`stream` call, and the remote MCP client
  (`packages/orchestrator/src/mcp.ts`, ADR 0007) gets the same fetch. There is no `HTTPS_PROXY`, no
  `NODE_USE_ENV_PROXY` and no global dispatcher, so the Kubernetes client, Postgres, bridges and sandboxd are never
  proxied. Hosts matching `NO_PROXY` skip the gateway even for those calls: the deployment lists `.svc`,
  `.cluster.local`, `kubernetes.default`, `pi-pg-rw` and `10.0.0.0/8`, and the code adds the cluster ranges itself.
- **Placeholders.** `placeholderAuthContext` answers every `*_API_KEY`/`*_API_TOKEN` lookup with
  `onecli-managed-placeholder` and ignores the real environment. The gateway replaces the SDK's key (spike Q7), so a
  model call works with no provider key in the orchestrator's environment.
- **The token.** `ONECLI_AGENT_TOKEN` comes from Secret `pi-onecli` (key `agent-token`), delivered by the
  ExternalSecret (example: `charts/cela/examples/external-secrets.yaml`) from `secret-store` (remote key `pi-onecli`, property
  `agent-token`). It is wrapped in `Redacted`, which prints as `[redacted]` in JSON, string conversion and
  `console.log`. The bridge launcher allows only a short list of variables, so the token, `NO_PROXY` and any proxy
  setting never reach a bridge (tested). The orchestrator refuses to start with a real provider in the allowlist and no
  token.
- **The CA.** OneCLI v2 serves its CA, unauthenticated, at `GET http://onecli.onecli:10256/v1/gateway/ca` (v1.45:
  `:10254`). `hack/fetch-onecli-ca.sh` copies it into ConfigMap `onecli-ca`, mounted at `/etc/onecli/ca.pem`
  (`PI_ONECLI_CA_FILE`). The CA lives in OneCLI's data volume, so run the script once, and again only if that volume
  is recreated. With the bundled OneCLI (next section) the bootstrap writes the public part into ConfigMap
  `pi-onecli-ca` (key `ca.pem`) and the chart mounts it; the script is for an external OneCLI.

## Bundled OneCLI: sign-in and credentials

`hack/kind-up.sh --onecli` (or `onecli.mode=bundled` with `hack/install.sh`) installs the upstream OneCLI chart as release
`onecli` next to the app ([ADR 0022](decisions/0022-bundled-onecli.md), [network policy](network-policy.md#bundled-onecli)).
The bootstrap leaves three things in the namespace; no script prints a value:

| Object | Holds |
| --- | --- |
| Secret `pi-onecli-admin` | `email`, `password` (the dashboard login) and `api-key` (the account-level `oc_` admin key) |
| Secret `pi-onecli` | `agent-token` (`aoc_`, the orchestrator's agent `pi-orchestrator`) |
| ConfigMap `pi-onecli-ca` | `ca.pem`, the public gateway CA |

It writes no host rules by default: OneCLI is open ([ADR 0043](decisions/0043-open-onecli-defaults.md)). With `ONECLI_HOSTS` set it
writes the host allowlist ([OneCLI host rules](onecli-host-rules.md)): an allow rule per host, then `block *`.
The orchestrator gets only the `api-key` and `agent-token` keys and the CA, never the password.

**Sign in to the dashboard on kind.** `hack/kind-up.sh` publishes the dashboard and the API on the host's loopback
(`http://localhost:10254` and `:10256`, [ADR 0022 addendum](decisions/0022-bundled-onecli.md#addendum-kind-publishes-the-dashboard-and-api-on-localhost-issue-138)),
so there is nothing to forward. Open `http://localhost:10254/auth/login` and use the login from the Secret:

```sh
NS=cela; CTX=kind-cela
open http://localhost:10254/auth/login        # sign in, paste the password; the agent pi-orchestrator is listed
kubectl --context $CTX -n $NS get secret pi-onecli-admin -o jsonpath='{.data.email}' | base64 -d; echo
kubectl --context $CTX -n $NS get secret pi-onecli-admin -o jsonpath='{.data.password}' | base64 -d | pbcopy   # macOS; xclip -selection clipboard on Linux
```

A cluster made with `--no-expose`, or any other cluster, has no such ports.

**Sign in to the dashboard with a port-forward** (any cluster, and kind with `--no-expose`). The API and dashboard have no
Ingress. Forward both ports (the dashboard calls the API at `localhost:10256`, so one forward is not enough) and read the
login from the Secret:

```sh
NS=cela; CTX=kind-cela            # your namespace and kubectl context
kubectl --context $CTX -n $NS port-forward svc/onecli-web 10254:10254 &
kubectl --context $CTX -n $NS port-forward svc/onecli-api 10256:10256 &
kubectl --context $CTX -n $NS port-forward svc/onecli-gateway 10255:10255 &   # only for the dashboard's proxy and CA hints
kubectl --context $CTX -n $NS get secret pi-onecli-admin -o jsonpath='{.data.email}' | base64 -d; echo
kubectl --context $CTX -n $NS get secret pi-onecli-admin -o jsonpath='{.data.password}' | base64 -d | pbcopy   # macOS; xclip -selection clipboard on Linux
open http://localhost:10254/auth/login        # sign in, paste the password; the agent pi-orchestrator is listed
```

The ports must be 10254 and 10256: OneCLI's `externalUrl` is fixed at install time to `http://localhost:10254`. Closing
sign-up does not exist in OneCLI (nothing to block), so this sign-in is always possible and always works.

**What works over localhost (a port-forward or the kind ports).** Read from OneCLI 2.20.0's source (the API image), not tested against a live provider:

- Sign-in, agents, secrets, host rules, the Codex login (a browser flow in the dashboard) and API-key secrets work: they
  need only the browser to reach `localhost:10254` and `localhost:10256`.
- OAuth connections to apps (GitHub, Atlassian, ...) build their redirect URI from the API's own address
  (`http://localhost:10256/v1/...` over a port-forward), and the redirect goes through your browser. It works if the
  provider accepts an `http://localhost` redirect URI, and it does for GitHub OAuth Apps and Google; Atlassian and others
  need the URI registered exactly. The forward must be up during the flow.
- Anything the provider calls **from the internet** does not work: GitHub App and Slack webhooks and event
  subscriptions (OneCLI offers them only when `externalUrl` is https; with http it falls back to Slack socket mode), and
  OAuth providers that refuse `http` redirect URIs. Those need a reachable https URL (next paragraph).

**Expose the dashboard deliberately.** The charts render no Ingress or HTTPRoute for OneCLI, on purpose. If you need
webhooks or shared access, run your own route to the `onecli-web` and `onecli-api` Services, install OneCLI with
`hack/onecli.sh --external-url https://onecli.example.com` (the origin of that route), and admit your ingress
controller in `charts/pi-onecli` (`web.allowFrom`, and for the API a route you trust). **OneCLI sign-up is open and cannot be
closed**, and an account created there gets an organization of its own whose agents bypass our host rules. So the route
must block it: return 403 for `/auth/signup` and `/auth/sign-up*` (the dashboard page and the API calls
`POST /auth/sign-up/email`), and put your own authentication in front of everything else. Then check from outside the
cluster that `POST /auth/sign-up/email` answers 403, and that the management API (`/v1/*`, `/auth/*` on `:10256`) is not
published at all unless you also protect it. The bootstrap needs neither: it uses a port-forward.

**The real-model check (not done by the installer).** The scripted model needs nothing; a real one needs a credential in
OneCLI. Either sign in as above and connect the Codex login (secret type `openai`, host `chatgpt.com`, `oauth`) and grant it
to `pi-orchestrator`, or give the bootstrap an API key from the environment (it creates one generic secret and the grant,
and never prints the value):

```sh
ONECLI_SECRET_NAME=openai ONECLI_SECRET_HOST=api.openai.com ONECLI_SECRET_VALUE=<key> \
  KUBE_CONTEXT=$CTX hack/onecli-bootstrap.sh -n $NS
```

Then make the model available. The `models` values seed the settings row only on the first start, so on an install that
already ran, `helm upgrade` with new `models` values changes nothing: use `PUT /admin/settings` (`allowlist`, and
`defaultModel` if it should be the default; [session API](session-api.md)), or pick it per session with
`POST /sessions {provider, model, reasoning}`. Then run one session. Verified on kind with `openai-codex/gpt-6-luna` at
`reasoning: low`: one bash tool call and the answer, the gateway log shows `chatgpt.com` `status 200` with
`injections_applied: 2` for agent `pi-orchestrator`, and the orchestrator has no OpenAI credential. `GATEWAY_CHECK_HOST=api.openai.com hack/kind-smoke.sh --onecli` (inside the orchestrator pod, with its token and CA)
sends one request through the gateway to that host instead of the blocked `example.com`; the answer shows whether the credential was injected (OpenAI answers
401 without one).

## OpenAI Codex (ChatGPT subscription): the working setup

Verified on the example test cluster (OneCLI v2.20, pi-ai 1.5.2): `openai-codex/gpt-6.1-terra` and `gpt-6.1-sol` each answered after one
sandbox tool call, through the gateway, with no provider credential in the orchestrator.

1. **OneCLI.** Secret "Codex subscription": type `openai`, host `chatgpt.com`, `authMode: oauth` (a Codex `auth.json`
   login; the gateway refreshes it). Agent `pi-orchestrator`, granted only that secret. Its token is
   `secret-store/pi-onecli` key `agent-token`; ExternalSecret `pi-onecli` delivers it (`SecretSynced`).
2. **Placeholder login.** pi-ai's `openai-codex` provider has only OAuth auth, so the API-key placeholder does not
   apply. `buildModels` gives `createModels` a credential store holding an OAuth login for `openai-codex` whose
   `access` is `placeholderCredentials` (`packages/orchestrator/src/onecli.ts`): an unsigned JWT-shaped string
   `header.payload.onecli-managed-placeholder` with claim `"https://api.openai.com/auth".chatgpt_account_id`, valid for ten
   years so pi-ai never tries to refresh it. pi-ai decodes that claim (`extractAccountId`) and sends it as
   `chatgpt-account-id`; it fails with "Failed to extract accountId" if the token is not JWT-shaped.
   **The claim's value does not matter**: the gateway replaces both `Authorization` and `chatgpt-account-id` with the real
   login's. The turns above ran with the default account id `onecli-managed-placeholder`; `PI_CODEX_ACCOUNT_ID` can set
   another and is not needed. The token is built in memory; it is not in the environment or the logs.
3. **Transport `sse`.** The provider defaults to a WebSocket. `withFetch` sets `transport: "sse"` on every stream call so
   the request is plain HTTPS through the gateway's `fetch` (WebSocket through the gateway is not tested).
4. **Model config** (the chart's `models` values, ConfigMap `pi-model-config`): default `openai-codex/gpt-6.1-terra`, `PI_MODEL_REASONING=medium`,
   allowlist `openai-codex/gpt-6.1-terra,openai-codex/gpt-6.1-sol,scripted/scripted-1,scripted/scripted-2`. Pick a
   model per session with `POST /sessions {provider, model}`. In pi-ai's list `gpt-6-luna` is the cheapest
   ($0.10/$0.50 per million tokens), then `gpt-6.1-terra` ($1/$5), then `gpt-6.1-sol` and `gpt-6-sol` ($2/$10).
5. **Deploy:** `hack/fetch-onecli-ca.sh`, configure your built image digests in your values file ([chart README](../charts/cela/README.md)), `hack/install.sh`, then
   restart orchestrator and ingest. Gateway line for a model call (redacted): `INFO session{peer=<pod ip> host=chatgpt.com:443
   lane=Mitm workspace_id=.. org_id=.. agent="pi-orchestrator" ..}: server: CONNECT`. A `WARN ... error=serving MITM
   connection` after a stream ends is normal here.

**Reasoning effort.** Pi's `thinkingLevel` is stored per session next to the model (`inbox.sessions.model_reasoning`,
`PI_MODEL_REASONING`, default `medium`). The orchestrator creates the conversation with
`agent: { model, thinkingLevel }`, which Pi Durable keeps in the conversation's `pi.agent` document (tested across a
restart in `host-model.test.ts`). At every request Pi Durable passes it to pi-ai as `streamSimple(..., { reasoning })`
(not when `off`), and the Codex provider sends `reasoning.effort` clamped to what the model supports. On the wire the
effort is UNVERIFIED (the body is inside TLS); the stored value and the call path are tested.

**Revoking, tested live.** Deleting the grant (`DELETE /v1/agents/<id>/grants/secrets/<secretId>`, admin key) makes the
gateway answer `401` with a JSON body `{"error":"access_restricted","message":"chatgpt.com credentials exist in OneCLI
but this agent does not have access..."}`. pi-ai keeps only that body, not the status, so `failure.ts` also matches
`access_restricted` / `does not have access`. The next turn ends `failed` (two seconds), further input gets 409, the
orchestrator does not restart. `PUT` on the same path restored the grant, and the next turn answered again.

**Token refresh under parallel load: accepted risk (issue #265).** OneCLI v2.20.0 refreshes the Codex access token when
it is within 5 minutes of expiring (it lives about 10 days), in `refresh_openai_oauth_if_expired`
(`crates/inject/src/secret_inject.rs`). Unlike OneCLI's other OAuth connections, that path has no lock, re-read or
compare-and-set ([egress bake-off, case 2](research/egress-bakeoff.md)), so model calls from several sessions that land in
those 5 minutes each spend the same refresh token. If OpenAI rotates refresh tokens on use, only one exchange wins and the
login may be revoked. It was never reproduced: a 100-session run on one subscription ([lab notes](lab-notes.md)) lasted
minutes and almost certainly missed the window. It is accepted for the proof of concept because the effect is
recoverable and nothing leaks.

- **Symptom:** after a burst of parallel sessions, model calls on that subscription fail with authentication errors
  (`401`, or a turn that ends `failed` with an auth message), across sessions, until the login is renewed. The OneCLI
  gateway log has a warning from the Codex OAuth refresh (it then keeps injecting the old token).
- **Fix:** sign in to Codex again and replace the secret in OneCLI (the same steps as the first setup above, or the
  dashboard, [Bundled OneCLI](#bundled-onecli-sign-in-and-credentials)). Grants stay; new turns work at once.
- **To avoid it:** keep large parallel bursts on one subscription away from the token's last minutes, or spread
  sessions over more than one subscription. Revisit if OneCLI moves the Codex refresh onto its locked refresh path.

**Pi 1.6.0 (ADR 0053).** `openai-completions` sends the `developer` role only to `api.openai.com`; other hosts
(OpenRouter and the like) get `system` unless `compat.supportsDeveloperRole` says otherwise. The Google adapters
(`google-generative-ai`, `google-vertex`) now accept a custom `fetch`, so Google calls can be sent through the OneCLI
gateway like the others; cela does not wire that yet, and until it does they bypass the gateway.

## Set up (once per cluster)

1. **OneCLI agent for the orchestrator** (your dashboard, or the API with an `oc_` key): create
   an agent, for example identifier `pi-orchestrator`, and grant it **only** the model-provider secrets (`Codex subscription`). Never grant a GitHub connection to it. Copy its access token (`aoc_...`).
2. **Secret in your store:** securely supply the token under the remote key/property referenced by
   `charts/cela/examples/external-secrets.yaml` (example: `pi-onecli` / `agent-token`). Adapt `secretStoreRef` and `remoteRef`
   to your backend. Alternatively omit the ExternalSecret and provision target Secret `pi-onecli`, key `agent-token`,
   with your secret-management tool. Do not put tokens in shell history or manifests.
3. Apply the ExternalSecret and run `hack/install.sh` (it installs `pi-model-config` with the chart), then
   `hack/fetch-onecli-ca.sh`. Check `kubectl -n cela-dev get externalsecret pi-onecli` is Ready. (e2e run namespaces get the same ExternalSecrets from the same store, `docs/e2e.md`.)
4. **Gateway egress.** OneCLI v2 still relays any public host by default. Add org rules that allow the model hosts and
   block the rest (`docs/research/onecli-v2-recheck.md`, section 2).
5. **Choose models.** The settings live in Postgres (`inbox.settings`, `docs/decisions/0008-settings-in-postgres.md`).
   Ingest seeds them once from ConfigMap `pi-model-config` (the keys below) when the row is absent; **after that the
   table wins** and a differing ConfigMap value only logs `settings-env-ignored`. Change them with
   `PUT /admin/settings` (`docs/session-api.md`), no restart. (Operator-defined providers are not settings: see
   [Adding an OpenAI-compatible provider](#adding-an-openai-compatible-provider).) With an OneCLI token the orchestrator installs every built-in
   provider at start, so adding a built-in provider needs no restart (without a token only allowlisted providers are installed).
   A credential added to OneCLI later also needs no restart: shard 0 re-reads OneCLI's secrets every 30 s, and the console's
   model pickers list the provider once its hint is `configured` ([ADR 0025](decisions/0025-model-catalog.md)).

| Key (seed only)          | Setting (admin API)                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `PI_MODEL_PROVIDER`, `PI_MODEL_ID` | `defaultModel` (`provider/model`) for sessions that name none.                                  |
| `PI_MODEL_REASONING`     | `reasoning`: effort of every new session, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `null`. |
| `PI_MODEL_ALLOWLIST`     | `allowlist`: `provider/model` pairs; the model id may contain slashes. The default is always allowed.     |
| `PI_SESSION_TURN_BUDGET` | `turnBudget`: model turns one session may use in total (default 100).                                     |
| `PI_SESSION_TOKEN_BUDGET` | `tokenBudget`: tokens one session may use in total; unset is no limit (ADR 0028).                       |
| `PI_REPO_ALLOWLIST`      | `repoAllowlist`: comma-separated `owner/name`, `owner/*` or `*`; unset refuses repo sessions (ADR 0032). |

Example for OpenRouter (seed values): `PI_MODEL_PROVIDER=openrouter`, `PI_MODEL_ID=openai/gpt-4.1-nano`,
`PI_MODEL_ALLOWLIST=openrouter/openai/gpt-4.1-nano,openrouter/google/gemini-2.5-flash-lite`. An allowlisted model that
pi-ai does not know stops the orchestrator at start with a clear message, not at the first request.

## Adding an OpenAI-compatible provider

Any server that speaks the OpenAI chat-completions API can offer models to agents ([ADR 0055](decisions/0055-custom-model-providers.md)).
The operator declares it in the chart values (`models.customProviders`, reference in `charts/cela/values.yaml`); it is
read at start by every orchestrator shard, so a change restarts them. A model is then picked like a builtin one. There are two
transports.

**HTTPS with a key, through OneCLI (the generic path).** The `baseUrl` is `https://` with a host name (an IP address is
refused: OneCLI matches the host name).

1. In OneCLI, create a **generic secret** holding the real key, with `hostPattern` the host (`llm.acme.example`, or
   `*.acme.example`), header `Authorization` and value format `Bearer {value}`, and grant it to the agent `pi-orchestrator`
   ([bundled OneCLI](#bundled-onecli-sign-in-and-credentials)). The orchestrator holds only the placeholder.
2. Add the provider to the values:

```yaml
models:
  customProviders:
    - id: acme
      baseUrl: https://llm.acme.example/v1
      models:
        - { id: acme-large, contextWindow: 128000, maxTokens: 8192, reasoning: true }
```

An HTTPS host on a LAN works the same way: OneCLI admits private targets on TCP 443 ([ADR 0043](decisions/0043-open-onecli-defaults.md)).
The orchestrator refuses a host that `NO_PROXY` would send around the gateway.

**Keyless server on the LAN, direct.** For a server with no key, such as oMLX, with plain HTTP and an IP address. The call
skips OneCLI (and its audit), refuses redirects, and the chart opens exactly one egress rule for the orchestrator:

```yaml
models:
  customProviders:
    - id: omlx
      baseUrl: http://192.168.7.101:8000/v1
      via: direct
      egress: { cidr: 192.168.7.101/32, port: 8000 }
      models:
        - { id: <model-id>, contextWindow: 32768, maxTokens: 8192 }
```

`egress` is required; the chart (and the orchestrator at start) refuse a CIDR in 169.254.0.0/16, 100.64.0.0/10 or 127.0.0.0/8
and any key, token or header field: a direct provider is **keyless only**. A keyed server goes through OneCLI.

**Then allow the models** (the chart values only define them): the provider shows in `GET /admin/models` (a direct provider
at once, a provider through OneCLI when a secret's host pattern covers its host, [ADR 0025](decisions/0025-model-catalog.md)),
and you add `omlx/<model-id>` to the allowlist with `PUT /admin/settings`, or name it as a profile's `defaultModel`.

```sh
curl -X PUT $API/admin/settings -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"allowlist":["scripted/scripted-1","omlx/<model-id>"]}'
```

Notes. A model's `contextWindow` and `maxTokens` are yours to state; there is no discovery. `compat` sets pi-ai's
openai-completions flags for a server that differs (`supportsDeveloperRole` and `supportsReasoningEffort` default to false
here). The cost is 0. **Removing a provider or model from the values breaks the stored conversations that name it at their
next turn**; the start log `custom-model-providers` lists the providers (ids, transport, model counts, no other value).

## Per-session model

`POST /sessions` takes an optional `{ provider, model }` (`docs/session-api.md`). Ingest checks it against the
allowlist (400 otherwise) and stores it in `inbox.sessions`. The orchestrator creates the Pi conversation with that
model.

**What Pi Durable 1.5.2 does with a model** (types and README read, then tested in `host-model.test.ts`):

- A conversation's model is stored in its `pi.agent` document as the names `{ provider, modelId }`. It is committed
  with the conversation (`createConversation({ agent: { model } })`, or later `conversation.configure({ model })`).
- It **persists across restarts**: a Harness reopened on the same storage runs the conversation on the stored model.
  It is set once, not applied every turn. A change through `configure` applies from the next request.
- It is stored as names and **resolved against `Models` at every use**. So every provider a stored conversation may
  name has to be installed at every start. A provider that is gone makes the run fail with `no_model`. This is why the
  orchestrator installs every builtin provider (when the OneCLI token is set) and the scripted ones at start, and why removing a model from the
  allowlist stops new sessions only: existing conversations keep it, even when it was the provider's last allowed model.
- The turn limit is `maxTurns` (tool rounds per run, `configure({ maxTurns })`). Pi has no per-session total, so the
  budget below counts assistant entries in the stored transcript. Pi compares `maxTurns` with the running run's own
  rounds (`pi.live.run.turns`, from 0 per run), so it is set to the budget minus the turns used **before** the running
  run started. An input that arrives mid-run (a steer) must not count that run's rounds twice and cut it short.

## Failures and spend limits

- **Rejected credentials end the session.** A model error whose text reads as 401, 403 or 407 (the provider rejecting
  the key, or the gateway rejecting the agent token) sets the session to the terminal status `failed` and stores a
  fixed message (never the provider's text). pi-ai does not retry these statuses, and nothing in the orchestrator does
  either. The session then answers new events with 409 and stays readable; `DELETE` still works. The orchestrator does
  not exit, so there is no restart loop. Other model errors (429 after the retries, network errors) leave the session
  active for its next message.
- **Where it is detected.** Pi Durable reports a model error only inside the conversation (the run's submissions end
  `unanswered` with the reason and text), not through `onReport`. The orchestrator's run watcher awaits each
  submission it handed over with `Submission.wait()` (one lookup by request id, then no polling), and re-adds the last
  24 hours of submitted events at start, so a run a previous process started is still seen. When a run answers it sets
  the turn limit again for a run queued behind it ([ADR 0029](decisions/0029-run-outcomes-from-wait.md)).
- **Turn budget.** The budget is checked before each input: the session profile's `turnBudget` if it has one, else the live `turnBudget` setting in Postgres (`PI_SESSION_TURN_BUDGET` only seeds that setting). A session that used all its turns becomes
  `failed` with "turn budget exhausted".
- **Token budget.** The session profile's `tokenBudget` if it has one, else the `tokenBudget` setting (null: no limit), is checked before each input against the tokens the
  conversation's `pi.usage` records, every model and attempt included. A session at or over it becomes `failed` with
  "token budget exhausted". It is checked between inputs, so one run can go past it
  ([ADR 0028](decisions/0028-token-budget.md)). A concurrency cap comes later.
- **Revoking access.** Deleting the grant, the agent, or regenerating its token makes the next model call fail with
  401/403/407 and fails the sessions that hit it. A simulated 401 is covered by `tests/e2e/run-phase4b.sh`; the live
  revocation path through the gateway was tested by hand (see the Codex section); it is not automated, because it
  needs the OneCLI admin key.

## Fallback: our own credential store (only if OneCLI cannot do it)

Use this only if OneCLI cannot handle a subscription login. It is not implemented in the orchestrator.

- Pi 1.5.2 stores an OAuth login in `<agent-dir>/auth.json` as `{"openai-codex": {"type":"oauth","access":…,"refresh":…,"expires":…}}`.
  Refreshing rotates the refresh token, so the cluster needs its own login and the orchestrator would have to persist
  the refreshed credential itself.
- Steps that work today: log in with a throwaway `PI_CODING_AGENT_DIR`, copy the `openai-codex` entry into a Secret in
  `secret-store` (`pi-orchestrator-model-auth`, key `auth.json`), and pull it into the namespace with an ExternalSecret
  (`refreshPolicy: CreatedOnce`, target `pi-model-auth-seed`). Never run `/logout`.
- Not built: loading the seed at start, writing refreshed credentials back to Postgres, and re-login. Check OpenAI's
  terms for server-side use of a subscription.
