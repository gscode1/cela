# Bundled OneCLI on kind: spike for install slice 10 (2026-11-17)

Spike for issue #120, before slice 10 of [install-plan.md](../install-plan.md) (D4, "OneCLI bootstrap", "OneCLI CA"). Follow-up to [onecli-v2-recheck.md](onecli-v2-recheck.md). Everything ran on a throwaway kind cluster that was deleted afterwards. All secret values were generated at run time and are not recorded here. Dummy values only, no real model credential.

## Versions

| Part | Version |
| --- | --- |
| kind / Kubernetes | kind v0.33.0, Kubernetes v1.37.0 (one node, kindnet, runc) |
| Helm | v4.3.1 |
| OneCLI chart | `oci://ghcr.io/onecli/charts/onecli` **2.20.0** (appVersion 2.20.0, kubeVersion >= 1.30) |
| OneCLI images | `ghcr.io/onecli/onecli-{api,web,gateway,migrations}:2.20.0` (the chart takes the tag from appVersion) |
| Postgres | `charts/pi-postgres` (merged), `postgres:17-bookworm`, 17.12 |

## Commands

```sh
kind create cluster --name pi-onecli-spike          # every kubectl/helm call used --context kind-pi-onecli-spike
kubectl create namespace pi
kubectl label ns pi \
  pod-security.kubernetes.io/{enforce,warn,audit}=restricted \
  pod-security.kubernetes.io/{enforce,warn,audit}-version=latest
kubectl -n pi create secret generic pi-postgres-auth \
  --from-literal=postgres-password="$(openssl rand -hex 24)" \
  --from-literal=pi-password="$(openssl rand -hex 24)" \
  --from-literal=onecli-password="$(openssl rand -hex 24)"
helm install pi-postgres charts/pi-postgres -n pi --wait

# OneCLI's database URL: role and database `onecli`, no sslmode (pi-postgres has no TLS yet)
kubectl -n pi create secret generic onecli-database \
  --from-literal=DATABASE_URL="postgresql://onecli:<onecli-password>@pi-postgres.pi.svc:5432/onecli"
# the three application secrets the chart reads when the runner is off (RUNNER_TOKEN is not needed)
b64() { head -c 32 /dev/urandom | base64; }
kubectl -n pi create secret generic onecli-secrets \
  --from-literal=BETTER_AUTH_SECRET="$(b64)" \
  --from-literal=SECRET_ENCRYPTION_KEY="$(b64)" \
  --from-literal=GATEWAY_INTERNAL_SECRET="$(b64)"

helm install onecli oci://ghcr.io/onecli/charts/onecli --version 2.20.0 -n pi -f values-onecli.yaml --wait
hack/onecli-bootstrap.sh -n pi
```

Values used (`values-onecli.yaml`), everything else is the chart default:

```yaml
externalUrl: http://localhost:10254
allowInsecureExternalUrl: true
secrets:
  existingSecret: onecli-secrets
database:
  enabled: false
  external:
    existingSecret: onecli-database
runner:
  enabled: false
```

Rendered: 3 Deployments (api, web, gateway), 2 Jobs (migrations, gateway CA), 3 Services, one ServiceAccount, Role and RoleBinding for the CA Job, one ConfigMap (the Node tool the CA Job runs). With the runner off, no sandbox namespace, quota or fence is created, and no Redis or bundled database exists. `gateway.replicas` and `api.replicas` stay 1 (the chart refuses anything else).

## Answers

### 1. Prisma migrations as the non-superuser `onecli` on Postgres 17: YES

Job `onecli-migrations-<revision>` ran `prisma migrate deploy` in 5 s: 182 migrations found, "All migrations have been successfully applied." Check as `postgres`:

```text
select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname='onecli';   -> onecli|f|f|f
select count(*) from _prisma_migrations where finished_at is not null;                         -> 182
select extname from pg_extension;                                                              -> plpgsql
select count(*) from pg_tables where schemaname='public' and tableowner='onecli';             -> 92
```

No extension beyond the built-in `plpgsql`, no superuser, no `CREATEDB`/`CREATEROLE`. The role owns its database, which is enough (PG 15+ lets the database owner create in `public`). It also worked after dropping the database and recreating it through pi-postgres's init (the same run repeated three times). The `wait-for-schema` init container of the api (`prisma migrate status`) passed on the first try. `pi-postgres` needed no change, and its NetworkPolicy already admits `app.kubernetes.io/name=onecli`, which every OneCLI pod (migrations Job included) carries.

### 2. Restricted Pod Security: YES with the chart's defaults, no patches

The namespace enforced `restricted` (with warn and audit). `helm install` printed no PSA warning, nothing was rejected, and every Pod and Job ran. The chart already sets on every Pod and Job (templates `onecli.podSecurityContext` and `onecli.containerSecurityContext`): `runAsNonRoot`, explicit `runAsUser`/`runAsGroup` (1000, gateway 100:101), `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `readOnlyRootFilesystem: true`, `automountServiceAccountToken: false` (only the CA Job mounts a token, scoped to one Secret). Only transient Warning events appeared: "secret onecli-gateway-ca not found" on the api and gateway pods and failed readiness probes, for about 40 s while the CA Job and the migrations ran (the Deployments and Job start together; the pods restart themselves). That is not a PSA issue, but `helm install --wait` and any "Ready within N seconds" check must allow for it. Nothing to add to values.

Two lifecycle facts for slice 10:

- The CA Secret is minted by a Job, not by Helm, so `helm uninstall onecli` **keeps** `onecli-gateway-ca` (and `onecli-secrets` if the chart generated it). A reinstall reuses it (the fingerprint was identical after two reinstalls). That keeps existing sandbox trust working, but it also means uninstall plus a database wipe leaves a CA behind on purpose.
- Job names carry the Helm revision (`onecli-migrations-1`, `onecli-gateway-ca-generate-1`) and are kept 24 h or 1 h, so every upgrade starts a new migrations Job.

### 3. Scripted first account, admin key, agent, host rule, grant: YES, through the HTTP API only

Base is the api Service (`onecli-api:10256`); the script used a `kubectl port-forward`. Bodies show the shape only.

| # | Request | Answer |
| --- | --- | --- |
| 1 | `POST /auth/sign-up/email` `{email, password, name}` | 200 `{token, user{id,email,...}}` and `Set-Cookie: better-auth.session_token`. Existing email: **422** `{code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"}`. No `Origin` header needed |
| 2 | `POST /auth/sign-in/email` `{email, password}` | 200 plus cookie; wrong password 401 `INVALID_EMAIL_OR_PASSWORD` |
| 3 | `GET /v1/auth/session` (cookie, `Origin: <externalUrl>`) | 200 `{id,email,name,workspaceId,organizationId,projectId}`. **Must be the first `/v1` call of a new session**: until then `/v1/user/api-key` answers 401 "Invalid API key or token" |
| 4 | `GET /v1/user/api-key` (cookie, `Origin: <externalUrl>`) | 200 `{apiKey: "oc_..."}`. Stable: repeated GETs return the same key |
| 5 | `POST /v1/agents` (Bearer `oc_`) `{name, identifier}` | 201 `{id,name,identifier,kind:"byo",...,llmKeys:[]}` (no token). Same identifier again: **409** |
| 6 | `GET /v1/agents` | `[{id,name,identifier,kind,createdAt,channels,accessToken:"aoc_...",imageUrl,lastSeenAt}]`. A fresh install has no agent (no "Default Agent") |
| 7 | `POST /v1/secrets` `{name, type:"generic", value, hostPattern, injectionConfig:{headerName, valueFormat}}` | 201 `{id,name,type,valueSource,hostPattern,pathPattern,preview,attachedAgents}`. The v1.45 shape used by `onecli-admin.ts` is **confirmed on v2.20**. Same name again: **201, a second secret** (not idempotent) |
| 8 | `PUT /v1/agents/{agentId}/grants/secrets/{secretId}` (no body) | 200 `{agentId, mode:"grants", connections:[], secrets:[{secretId,name,type,scope}]}`. Idempotent. `GET /v1/agents/{id}/grants` returns the same shape (a bare-object with `secrets` and `connections`, which `parseGrants` already accepts) |
| 9 | `POST /v1/org/policy/rules` `{name, action, targets:[{kind:"network", hostPattern}]}` | 201 rule with `priority` = creation order. Same name again: **201, a duplicate** (not idempotent). `GET` is a bare array. `DELETE /v1/org/policy/rules/{id}` 204 |
| 10 | `DELETE /v1/secrets/{id}` | 204 |

The session cookie only works on `/v1/*` when the request also carries `Origin` equal to `externalUrl` (here `http://localhost:10254`). Without it, `/v1/user` and `/v1/user/api-key` answer 401 and only `/v1/auth/session` works. `GET /v1/instance` (no auth) returns that URL as `origins.external`, so the script reads it from there. The `/auth/*` calls do not need it. Sign-up and sign-in are rate limited (the run hit HTTP 429 after about 10 auth calls in a minute), so the script avoids auth calls on a rerun.

Gateway checks, from the host through a port-forward and from a restricted-PSA Pod in the namespace (curl 8.11.1, CA from the ConfigMap, token from the Secret):

```text
api.openai.com/v1/models  with token   -> 401 from OpenAI; gateway log: MITM ... injections_applied=1 agent="pi-orchestrator"
example.com               with token   -> 403; gateway log: BLOCKED by policy rule rule="pi-block-all"
no token / invalid token / no CA       -> 000 (407 at CONNECT: "CONNECT rejected: no agent token" / "invalid agent token")
```

So the dummy credential was injected, the allowlist (14 rules, `allow` per host then `block *` last) worked on first write, and the agent token works from a Pod that mounts only the public CA.

**Idempotency.** `hack/onecli-bootstrap.sh` was run on a fresh database, then again:

- run 1: account created, key stored, agent created, token stored, 14 rules written, secret created and granted, CA ConfigMap written;
- run 2 (and a run with only the key Secret deleted): "stored admin key is valid" (no auth calls at all), agent exists, token unchanged, 0 rules written, secret exists, CA unchanged; counts stayed at 1 agent, 1 secret, 14 rules;
- admin Secret deleted entirely: the script generates a new password, sign-up answers 422, sign-in answers 401, and the script stops with "the install may have been claimed by someone else". That is the intended signal, see below.

What makes it idempotent is not the API (agents 409, but secrets and rules duplicate silently): the script finds by name or identifier first.

**Does sign-up stay open? YES, confirmed. The plan's "the first account owns the install" is wrong as a security statement.** After the bootstrap, `POST /auth/sign-up/email` with a new email still returns 200 and a working session. The second account gets its **own organization** and sees none of the first one's agents, secrets or rules (`GET /v1/agents` returned `[]`, a different `organizationId`). It also creates agents with tokens, and those tokens use the gateway without the first organization's rules: a second-organization agent fetched `https://example.com/` through the gateway with **200**, while the first organization's agent got 403 from `pi-block-all`. So the host allowlist protects only the first organization's agents; anyone who can reach `/auth/sign-up/email` on the api (through the Service, an Ingress or the dashboard's own port) gets an agent token, hence a public-internet egress proxy, and nothing in OneCLI prevents it (no env var, no setting; the chart has no switch; a grep of the api image found none). "First account owns the install" holds only in the sense that the first account owns the pre-existing data of a v1 upgrade, not here.

Consequences for the plan: (a) the bootstrap must run right after rollout, as planned, but it is not a lock; (b) the real control is **network**: only the bootstrap and the orchestrator reach `onecli-api:10256`, and only sandboxes reach the gateway `:10255`; never expose `/auth/*` through an Ingress or Gateway route unless an authenticating edge sits in front. The bundled install must say so; the chart's own `ingress`/`httpRoute` options route `/auth` to the api, so they must stay off; (c) a gateway-side NetworkPolicy (default deny egress to the Internet except an FQDN allowlist) still matters because the gateway honours any organization's token.

### 4. Dashboard sign-in over port-forward with an http `externalUrl`: YES, with two port-forwards

With `externalUrl: http://localhost:10254` the chart's own note ("the dashboard cannot sign in through it") is only half true. The API reports `origins.mode: "ports"` and tells the browser to call the API at `http://localhost:10256` (CORS allows the origin `http://localhost:10254`, with credentials). Tested in a real browser:

```sh
kubectl -n pi port-forward svc/onecli-web 10254:10254 &
kubectl -n pi port-forward svc/onecli-api 10256:10256 &
# open http://localhost:10254/auth/login, sign in with the bootstrap account -> lands on the agent page
```

Sign-in works and shows the `pi-orchestrator` agent. With only `:10254` forwarded the form stays on `/auth/login` and sign-in does nothing. The same two forwards work for the real-model step (`/auth/login`, then connect the Codex login in the dashboard). The gateway URL the dashboard shows is `http://localhost:10255` (so `:10255` too, for the dashboard's CA/proxy hints). The login for this is the Secret `pi-onecli-admin` (`email`, `password`), which the bootstrap stores.

### 5. Gateway CA

- Secret **`<release>-gateway-ca`** (`onecli-gateway-ca`), type Opaque, keys **`GATEWAY_CA_CERT`** and **`GATEWAY_CA_KEY`** (PEM, both in the one Secret). No labels. Created once by the CA Job (`onecli-gateway --generate-ca`, `CN=OneCLI Local Gateway CA, O=OneCLI`, valid 2026-11-17 to 2036-11-14); never overwritten. `gatewayCa.existingSecret` can supply your own, made with the gateway binary (not openssl).
- The api serves the public cert without auth at `GET /v1/gateway/ca` (638 bytes, `application/x-pem-file`), as in v1/v2.20 before; it matches the Secret.
- Copying only the public part works: the script reads `GATEWAY_CA_CERT`, checks it parses with `openssl x509` and contains no `PRIVATE KEY`, and applies ConfigMap `pi-onecli-ca` with key `ca.crt`. The probe Pod mounted only that ConfigMap and verified TLS through the MITM gateway.
- The key never leaves the Secret. Reading it needs `get secret` in the namespace, which the bootstrap runner has. The orchestrator does not need it; it only needs the ConfigMap. The orchestrator reads the CA at start, so rotation still needs a restart.

### 6. Pod labels and Services (for NetworkPolicies)

All objects carry `app.kubernetes.io/name=onecli`, `app.kubernetes.io/instance=<release>`, `app.kubernetes.io/component=<c>` (plus `app.kubernetes.io/part-of=onecli`, version, chart labels). Pod templates also carry `onecli.sh/role`.

| Component | Pod labels (selector) | Extra pod label | Service | Port | Talks to |
| --- | --- | --- | --- | --- | --- |
| api | `...component=api` | `onecli.sh/role=api` | `<release>-api` | **10256** (`http`) | Postgres 5432, gateway :10255 |
| web (dashboard) | `...component=web` | `onecli.sh/role=web` | `<release>-web` | **10254** | Postgres 5432 (it has `DATABASE_URL`), api :10256, gateway :10255 (`API_INTERNAL_URL`, `GATEWAY_INTERNAL_URL`) |
| gateway | `...component=gateway` | `onecli.sh/role=gateway` | `<release>-gateway` | **10255** (`proxy`, CONNECT proxy and `/healthz`) | Postgres 5432, api :10256, the Internet |
| migrations Job | `...component=migrations` | none | none | none | Postgres 5432 |
| CA Job | `...component=gateway-ca-generate` | none | none | none | kube API only (it is the one Pod with a ServiceAccount token) |

Selector for "all OneCLI pods": `app.kubernetes.io/name=onecli,app.kubernetes.io/instance=<release>` (this is what the pi-postgres client selector `app.kubernetes.io/name: onecli` already matches). With release name `onecli` the Service DNS names are `onecli-api.<ns>:10256`, `onecli-gateway.<ns>:10255`, `onecli-web.<ns>:10254`. Api, web and gateway all read `DATABASE_URL`, so all three need egress to Postgres. The chart's own NetworkPolicy exists only for its bundled database and is not rendered here.

## Prototype: `hack/onecli-bootstrap.sh`

Header says PROTOTYPE. Bash 3.2 safe (no arrays-of-arrays, no `mapfile`, empty-array expansions guarded), `shellcheck -x` clean, `set -euo pipefail`, curl credentials only through files or the cookie jar in a `0700` temp dir (nothing on a command line), values never printed, Kubernetes Secrets written only when a value changed. Order: wait for `/v1/health`; learn `externalUrl` from `/v1/instance`; if `pi-onecli-admin` holds a valid `api-key` skip to the agent; otherwise sign up (password generated and stored first), sign in on 422, `GET /v1/auth/session`, `GET /v1/user/api-key`; agent; rules (a late-added allow rule deletes and recreates the block last); optional secret and grant (`ONECLI_SECRET_*`, value from the environment only); CA ConfigMap. Outputs: Secret `pi-onecli-admin` (`email`, `password`, `api-key`), Secret `pi-onecli` (`agent-token`, the names `docs/model-credentials.md` already uses), ConfigMap `pi-onecli-ca` (`ca.crt`).

## Gaps and risks

1. **Open sign-up with per-organization rules** (question 3): the allowlist is bypassable by anyone with network access to `/auth/*`; the mitigation is network isolation of the api, not OneCLI config. Worth reporting upstream (a `DISABLE_SIGNUP` switch, or org-less agents).
2. The admin key is the first account's key and lives in a Kubernetes Secret next to the login password. It gives account-level access (all agents, tokens, secrets). The orchestrator must not mount `pi-onecli-admin`; it needs only `pi-onecli`. This does not fix the plan's least-privilege note in "OneCLI bootstrap" (the orchestrator today holds an admin key to create per-session agents and grants); there is still no scoped key type.
3. Sessions rely on an unstated order (`/v1/auth/session` first) and an `Origin` header. Both were observed on v2.20.0 only; a chart or image bump needs this spike's script run again (the script fails loudly, never silently).
4. Secrets and rules are not idempotent in OneCLI (duplicates are created); a concurrent second bootstrap run could create duplicates. Run it once at a time (a Job with `parallelism: 1`, `backoffLimit` small, or a lock Secret).
5. The 429 rate limit on sign-up/sign-in (about 10 per minute) is handled by a retry and by skipping auth when the stored key works.
6. The dashboard needs `:10254` and `:10256` forwarded together (and `externalUrl` fixed at `http://localhost:10254`, so the port numbers cannot change). An https `externalUrl` through a real edge is the supported path.
7. Not tested: a real model call and the Codex login; an in-cluster Job instead of the port-forward (the script takes `ONECLI_API_URL=http://onecli-api.<ns>:10256` and `ONECLI_EXTERNAL_URL`; the calls are the same); upgrade of the chart from 2.20.0; `database.external` with TLS (`sslmode=require`, slice 11); Cilium; a second bootstrap running concurrently.
8. `helm uninstall` keeps the CA Secret by design (and a generated `onecli-secrets`). Slice 10 must document it, and the e2e cleanup must delete it with the namespace.
9. The api and gateway pods restart or wait for about 40 s on first install because the CA Secret does not exist yet; use `helm --wait` and a generous timeout.

## What slice 10 should build

- `charts/` stays untouched: the upstream chart is its own release, installed by `hack/install.sh` after `pi-postgres` with the values above (`--version 2.20.0`, runner off, `database.external.existingSecret`, `secrets.existingSecret`, `externalUrl` from `onecli.externalUrl`, `allowInsecureExternalUrl` only for the kind/port-forward path). `install.sh` creates `onecli-database` (from the `pi-postgres-auth` `onecli-password`) and `onecli-secrets` (the three keys above) if missing, never regenerating them.
- Promote `hack/onecli-bootstrap.sh` to the bootstrap step: run it right after `helm --wait`, from `install.sh` on the operator machine, or as a Job with its own ServiceAccount (`get/patch/create` on the three named Secrets and the ConfigMap, `get` on `<release>-gateway-ca`) and a tiny image with `curl`, `jq` and `kubectl`. The Job variant needs `ONECLI_API_URL` and `ONECLI_EXTERNAL_URL`, and a NetworkPolicy that allows it to the api.
- Host rules: have the bootstrap own the allowlist (the same list as `deploy/onecli-host-rules.sh`, which it can replace for bundled installs).
- NetworkPolicies for bundled OneCLI (replace `deploy/onecli-policies/*` for this mode): api ingress from the orchestrator, the bootstrap Job, web and gateway only; web ingress from nowhere by default (port-forward) or an operator-chosen edge; gateway ingress `:10255` from sandboxes and the orchestrator; egress api to Postgres and gateway, web to Postgres, api and gateway, gateway to Postgres, api, DNS and public hosts, CA Job to the kube API. Do not create an Ingress or HTTPRoute for `/auth` (finding 1).
- Document the open sign-up (question 3) in `docs/model-credentials.md` and `docs/network-policy.md`; fix the install plan's sentence ("the first account owns the install") when slice 10 lands.
- E2E for `--onecli`: after the bootstrap, a Pod with the CA ConfigMap and the agent token reaches the gateway (as above); a second bootstrap run reports "0 written", "unchanged"; a second sign-up is allowed but cannot reach the api from a sandbox (NetworkPolicy test).
- The real-model step stays manual or opt-in: port-forward `:10254` and `:10256`, sign in with `pi-onecli-admin`, connect the Codex login (or `ONECLI_SECRET_*` for an API key).

## Cleanup

`kind delete cluster --name pi-onecli-spike`. No other kubectl context was used (every call named `--context kind-pi-onecli-spike`).
