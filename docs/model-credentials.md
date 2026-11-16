# Model credentials and model selection

Every model credential lives in OneCLI. The orchestrator holds only a OneCLI **agent token**; provider API keys in
pi-ai are placeholders that the gateway replaces (for the Codex provider, a JWT-shaped placeholder login: see below). Sandboxes and bridges never see either. Background and test
results: `docs/research/onecli-spike.md` (v1.45) and `docs/research/onecli-v2-recheck.md` (v2.20.0, what runs on c2).

## Flow

```
orchestrator (pi-ai, apiKey = placeholder)
  --fetch with an undici ProxyAgent, Proxy-Authorization: Basic x:<agent token>-->  onecli.onecli:10255 (gateway)
  gateway: checks the agent token, MITMs TLS with the OneCLI CA, swaps in the real credential --> provider
```

- **Scoped to model calls.** `createGatewayFetch` (`packages/orchestrator/src/onecli.ts`) is a `fetch` bound to a
  `ProxyAgent`; `withFetch` hands it to pi-ai on every `streamSimple`/`stream` call. There is no `HTTPS_PROXY`, no
  `NODE_USE_ENV_PROXY` and no global dispatcher, so the Kubernetes client, Postgres, bridges and sandboxd are never
  proxied. Hosts matching `NO_PROXY` skip the gateway even for model calls: the deployment lists `.svc`,
  `.cluster.local`, `kubernetes.default`, `pi-pg-rw` and `10.0.0.0/8`, and the code adds the cluster ranges itself.
- **Placeholders.** `placeholderAuthContext` answers every `*_API_KEY`/`*_API_TOKEN` lookup with
  `onecli-managed-placeholder` and ignores the real environment. The gateway replaces the SDK's key (spike Q7), so a
  model call works with no provider key in the orchestrator's environment.
- **The token.** `ONECLI_AGENT_TOKEN` comes from Secret `pi-onecli` (key `agent-token`), delivered by the
  ExternalSecret `deploy/onecli-externalsecret.yaml` from `secret-store` (remote key `pi-onecli`, property
  `agent-token`). It is wrapped in `Redacted`, which prints as `[redacted]` in JSON, string conversion and
  `console.log`. The bridge launcher allows only a short list of variables, so the token, `NO_PROXY` and any proxy
  setting never reach a bridge (tested). The orchestrator refuses to start with a real provider in the allowlist and no
  token.
- **The CA.** OneCLI v2 serves its CA, unauthenticated, at `GET http://onecli.onecli:10256/v1/gateway/ca` (v1.45:
  `:10254`). `deploy/fetch-onecli-ca.sh` copies it into ConfigMap `onecli-ca`, mounted at `/etc/onecli/ca.pem`
  (`PI_ONECLI_CA_FILE`). The CA lives in OneCLI's data volume, so run the script once, and again only if that volume
  is recreated.

## OpenAI Codex (ChatGPT subscription): the working setup

Verified on c2 (OneCLI v2.20, pi-ai 1.5.2): `openai-codex/gpt-6.1-terra` and `gpt-6.1-sol` each answered after one
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
4. **Model config** (`deploy/model-config.yaml`): default `openai-codex/gpt-6.1-terra`, `PI_MODEL_REASONING=medium`,
   allowlist `openai-codex/gpt-6.1-terra,openai-codex/gpt-6.1-sol,scripted/scripted-1,scripted/scripted-2`. Pick a
   model per session with `POST /sessions {provider, model}`. In pi-ai's list `gpt-6-luna` is the cheapest
   ($0.10/$0.50 per million tokens), then `gpt-6.1-terra` ($1/$5), then `gpt-6.1-sol` and `gpt-6-sol` ($2/$10).
5. **Deploy:** `deploy/fetch-onecli-ca.sh`, `deploy/push-code.sh`, `deploy/push-ingest.sh`, `kubectl apply -k deploy`, then
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

## Set up (once per cluster)

1. **OneCLI agent for the orchestrator** (dashboard `https://onecli.example.com`, or the API with an `oc_` key): create
   an agent, for example identifier `pi-orchestrator`, and grant it **only** the model-provider secrets (`Codex subscription`). Never grant a GitHub connection to it. Copy its access token (`aoc_...`).
2. **Secret in the store:**
   `kubectl -n secret-store create secret generic pi-onecli --from-literal=agent-token=<token>`.
3. `kubectl apply -k deploy` (adds `pi-model-config` and the ExternalSecret), then
   `deploy/fetch-onecli-ca.sh`. Check `kubectl -n pi-durable-poc get externalsecret pi-onecli` is Ready.
4. **Gateway egress.** OneCLI v2 still relays any public host by default. Add org rules that allow the model hosts and
   block the rest (`docs/research/onecli-v2-recheck.md`, section 2).
5. **Choose models** in ConfigMap `pi-model-config`, then restart ingest and the orchestrator (env is read at start):

| Key                      | Meaning                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| `PI_MODEL_PROVIDER`      | Default provider for sessions that name none. `scripted` is the e2e fake model (`tests/e2e/deploy` sets it). |
| `PI_MODEL_ID`            | Default model id.                                                                                        |
| `PI_MODEL_REASONING`     | Reasoning effort of every new session: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Unset: none.  |
| `PI_MODEL_ALLOWLIST`     | Comma-separated `provider/model` pairs; the model id may contain slashes. The default is always allowed. |
| `PI_SESSION_TURN_BUDGET` | Model turns one session may use in total (default 100).                                                  |

Example for OpenRouter: `PI_MODEL_PROVIDER=openrouter`, `PI_MODEL_ID=openai/gpt-4.1-nano`,
`PI_MODEL_ALLOWLIST=openrouter/openai/gpt-4.1-nano,openrouter/google/gemini-2.5-flash-lite`. An allowlisted model that
pi-ai does not know stops the orchestrator at start with a clear message, not at the first request.

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
  budget below counts assistant entries in the stored transcript and sets `maxTurns` to what is left.

## Failures and spend limits

- **Rejected credentials end the session.** A model error whose text reads as 401, 403 or 407 (the provider rejecting
  the key, or the gateway rejecting the agent token) sets the session to the terminal status `failed` and stores a
  fixed message (never the provider's text). pi-ai does not retry these statuses, and nothing in the orchestrator does
  either. The session then answers new events with 409 and stays readable; `DELETE` still works. The orchestrator does
  not exit, so there is no restart loop. Other model errors (429 after the retries, network errors) leave the session
  active for its next message.
- **Where it is detected.** Pi Durable reports a model error only inside the conversation (the run's submissions end
  `unanswered` with the reason and text), not through `onReport`. The orchestrator's run watcher polls the
  submissions it handed over until they settle, and re-adds the last 24 hours of submitted events at start, so a run
  a previous process started is still seen.
- **Turn budget.** `PI_SESSION_TURN_BUDGET` is checked before each input; a session that used all its turns becomes
  `failed` with "turn budget exhausted". It is the first spend limit; a token budget and a concurrency cap come later.
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
