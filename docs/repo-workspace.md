# Repository workspace (Phase 4c)

`POST /sessions` may carry `{ "repo": "owner/name", "branch": "…" }`. The session then gets `/workspace/repo`, a clone of
that GitHub repository, and can push to it. Without `repo` nothing changes: no OneCLI agent, no secret, no GitHub call.

Status: run live on the example test cluster on 2026-11-16 (`tests/e2e/run.sh phase4c`, needs `REPO_A` and `REPO_B`): clone, push and branch delete through OneCLI pass, a push to the other repo is refused (plan.md). On 2026-11-19 the same suite passed with the egress proxy on (the sandbox reaches GitHub only through the proxy's OneCLI route; issue #284). The items under "Unverified" were not checked separately.

## Input

Validated in `session-core` (`repo.ts`), used by ingest: `repo` matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`, owner at most 39
characters (`repo` at most 140, the name at most 100), no `..`, no leading or trailing `-` on the owner, no leading `-` on the name, no `.git` suffix. `branch` (at most 200 characters) is a ref name: starts alphanumeric, `[A-Za-z0-9._/-]`, no `..`,
`//`, `/.`, trailing `/` or `.`, and no path component ending in `.lock`. URLs are never accepted: the orchestrator builds `https://github.com/<repo>.git` itself.
Stored in `inbox.sessions` (`repo`, `repo_branch`; migration `004_repo.sql`).

## Which repositories: the repo allowlist

A session may only clone a repository the `repoAllowlist` setting lists ([ADR 0032](decisions/0032-repo-allowlist.md)):
`owner/name`, `owner/*` or `*`, matched case-insensitively. Empty, the default, refuses every repo session. Ingest
answers `403` for a repository it does not list. The orchestrator checks the list again before every token mint, so a
repository an admin removes gets no new token and its running sessions lose access within the hour the current token
lives. Seed it with the chart value `github.repoAllowlist` (`PI_REPO_ALLOWLIST`). Change it on the console's settings
page or with `PUT /admin/settings`. The list narrows what the GitHub App installation offers, so install the App only on
the repositories you mean to use as well.

## Credentials: no GitHub token in the sandbox

```
orchestrator --JWT(App key)--> api.github.com  POST /app/installations/{id}/access_tokens
               {"repositories":["<name>"],"permissions":{"contents":"write","pull_requests":"write","metadata":"read"}}
           <-- 1 h token for that one repository (checked: the answer must list exactly owner/name)
orchestrator --admin API--> OneCLI: agent <prefix><uuid>, secrets <prefix><uuid>-git / -api, grants
sandbox command --HTTPS_PROXY=http://x:<agent token>@onecli.onecli:10255--> gateway injects the token   (egress proxy off)
sandbox command --HTTPS_PROXY=http://x:<egress token>@pi-egress-proxy:3128--> proxy --CONNECT with the agent token
                  from egress.bindings (sealed)--> OneCLI gateway injects the token                    (egress proxy on, ADR 0037)
```

With `egressProxy.enabled` the sandbox holds only its egress token. The agent token is sealed with the binding key into
`egress.bindings` (the proxy opens it for `route=onecli` tunnels of that session only), and the orchestrator adds session
rules that send `github.com` and `api.github.com` through OneCLI, removed with the session. Without the proxy the sandbox keeps
the gateway URL and the agent token as before. See [ADR 0037](decisions/0037-egress-onecli-route.md).

- `<prefix>` is `PI_ONECLI_NAME_PREFIX` (default `pi-session-`; lowercase `[a-z0-9-]`, ending in `-`). Stacks that share a OneCLI
  workspace need different ones: the orphan sweep judges only names with its own prefix (`docs/e2e.md`).
- The GitHub App id and installation id are in the Secret. The private key is Secret `pi-github-app` (`private-key.pem`, `app-id`,
  `installation-id`), delivered by ExternalSecret to the orchestrator only and mounted at `/etc/pi-github-app`.
- Secrets: `…-git` for `github.com` injects `Authorization: Basic base64("x-access-token:<token>")`, `…-api` for `api.github.com`
  injects `Bearer <token>`. No `pathPattern`: it can be bypassed (`onecli-v2-recheck.md`); GitHub's own repository scope is the boundary.
- OneCLI auto-grants LLM keys to a new agent. After creating it the orchestrator grants its two secrets, deletes every
  other grant, reads the grants back and requires exactly those two. If it cannot prove that, it deletes the agent and fails.
- The token is re-minted on every cold `ensure` (orchestrator restart) and before each tool call when less than 10 minutes remain
  (`PATCH /v1/secrets/{id}`). The OneCLI agent token is stable for the session and is **readable by the agent** (plan: accepted). A failed
  grant check on renewal keeps an agent that an earlier attempt proved narrow (a transient OneCLI error says nothing about
  its grants); an agent proven still wide is deleted and replaced, and the open env, whose `shellEnv` holds the old
  token, is then closed and reopened before its next call (`RepoAccess.envStale`).
- Teardown (`DELETE /sessions/{id}`): tombstone row in `inbox.tombstones` first, then the OneCLI agent (its token dies at
  once), then its secrets (found by stored id and by name), then the claim and PVC. Repeatable after a crash.
- The admin key is `ONECLI_API_KEY` (Secret `pi-onecli-admin`, key `api-key`), orchestrator only. It is account-level; keeping it
  there is an accepted risk for the proof of concept ([ADR 0042](decisions/0042-onecli-admin-key-in-orchestrator.md)).

## How per-session env reaches only that session's commands

pi-env 1.5.2 `RemoteExecutionEnv` takes `shellEnv`, "added to the remote environment of every command that inherits it". It is
one option per env instance and the orchestrator builds one env per conversation (`Sandboxes.#open`), so the variables reach
only that session's commands, through the pi-env protocol to the daemon, not through the bridge process (the bridge
launcher still strips everything but its allow-list; tested). `sandbox-env` only gained a pass-through option; the bridge
and the storage adapter are untouched. Set once at env open, so it holds only stable values.

Variables with the egress proxy on: the proxy variables of ADR 0036 (the egress token) plus `buildWorkspaceEnv()`, which is the CA, git and
identity part of the list below, and no OneCLI address or token. Variables without it (`workspace.ts` `buildShellEnv`): `HTTPS_PROXY`/`https_proxy` with the agent token, `NO_PROXY=localhost,127.0.0.1,::1`,
`SSL_CERT_FILE` and `GIT_SSL_CAINFO` (system roots + OneCLI CA, `/workspace/.onecli/bundle.pem`), `NODE_EXTRA_CA_CERTS`
(`/workspace/.onecli/ca.pem`), `NODE_USE_ENV_PROXY=1`, git author identity, and git config through `GIT_CONFIG_COUNT=1`,
`GIT_CONFIG_KEY_0=http.proxyAuthMethod`, `GIT_CONFIG_VALUE_0=basic`. (`GIT_CONFIG` itself is read only by `git config`, so it is not used.)
The CA is public; the orchestrator writes it into the workspace from its ConfigMap mount.

## Clone

Before the session's first turn (`SessionService.prepare`, run by the inbox *before* it claims the row, with no transaction or pool client held; ADR 0005): provision, then `prepareWorkspace` through the session's env. It is idempotent, so a crash or retry runs it again.
Skipped when `/workspace/repo/.git` exists. Otherwise `git clone [--branch b] -- <url> /workspace/.clone-tmp`, then rename to
`/workspace/repo`, so `.git` exists only for a complete clone. A leftover `.clone-tmp` is removed first. Then
`/workspace/.pi-workspace.json` is written and `workspace_ready_at` set. A session that was ready but whose marker or
repository is gone is `failed` ("workspace is missing"), never re-cloned. Only a check that succeeds and reports the
path absent counts: a failing check (bridge or Pod error) is a transient error and retries. GitHub refusing the token
(repo not in the installation) also fails the session; transient errors, GitHub rate limiting (429, or 403 with
`x-ratelimit-remaining: 0`, `retry-after` or a rate-limit message) included, retry through the inbox (8 attempts with backoff, about two minutes).

## Repo skills

With the profile switch `repoSkills` (ADR 0014; `docs/session-api.md`, Repo skills), `SessionService.prepare` scans the
clone for `SKILL.md` files under `.pi/skills` and `.agents/skills` right after the clone step and again before each new
message, but only while the session's sandbox is already open (it never resumes a suspended one for this). The scan
runs through the session's env (`listDir`, `readTextFile`) and writes nothing to the workspace; the result goes into the
conversation's instructions.

With `repoContext` (ADR 0015) the same pass also reads the repo's `AGENTS.md` / `CLAUDE.md` (the first of five names, at the
checkout root) into the instructions, before the skills catalog.

## Branch protection is the repository owner's job

A session token has `contents: write` (and `pull_requests: write`) on its repository, and GitHub cannot scope a token by ref.
Whatever the repository does not protect, the agent can push to, force-push, delete or merge into, and so can a prompt
injection in what it reads. pi-durable does not impose a branch policy on the repository ([ADR 0027](decisions/0027-no-agent-branch-ruleset.md)):
protect the branches that matter with GitHub's own branch protection or rulesets. A sensible minimum for `main` and release
branches:

- require a pull request (with review) before merging, so the App cannot push or merge on its own;
- block force-pushes and deletion;
- do **not** add the GitHub App to the bypass list: that would void the protection for every session.

Tags are not covered by branch protection; add a tag ruleset if that matters. `branch` in `POST /sessions` can be any branch
name the repository lets the App push to.

## OneCLI call bounds

Every management API call has a timeout and a bounded retry on network errors, timeouts and 5xx (never 4xx). A `POST` is never
re-sent; a create looks the object up by name again after a failure and POSTs only if it is absent. Environment: `PI_ONECLI_TIMEOUT_SECONDS` (default 15, per attempt), `PI_ONECLI_RETRIES` (default 3),
`PI_ONECLI_BACKOFF_MS` (default 500, doubling, capped at 5 s).

## Unverified

- Verified since (2026-11-19, issue #284): through the egress proxy (ADR 0037) the chain sandbox -> proxy -> OneCLI -> GitHub
  with the real GitHub App. `tests/e2e/run.sh phase4c` (proxy on, its default now) passed 5/5 on the test cluster (run
  `pi-e2e-a449ac`): clone, push of a test branch and its deletion, restart-skip, scope and delete. The sandbox's `HTTPS_PROXY`
  was the proxy, its environment held no OneCLI address, agent token or GitHub token, explain answered `route: onecli` with a
  binding for `github.com` and `api.github.com`, and the proxy logged the session's 4 `github.com:443` tunnels as allowed with
  route onecli and none direct. The installation was shown to cover repo B (a `metadata: read` token scoped to B minted and
  revoked in the orchestrator), and A's token was refused reading B. Not covered: `EGRESS_PROXY=0` was not re-run live.

- The OneCLI v2 generic-secret body (`type: "generic"`, `injectionConfig: {headerName, valueFormat}`), `PATCH /v1/secrets/{id}`, the
  response shapes of `GET /v1/agents`, `/v1/secrets` and `GET /v1/agents/{id}/grants`, and `DELETE …/grants/connections/{id}` come
  from the v1.45 spike or are guessed; list parsing accepts two shapes and fails closed on anything else. There is no separate
  "effective credentials" call: the grant list is used.
- Basic injection for `github.com` with a minted token, push through the gateway, and `proxyAuthMethod=basic` on v2.
- That an agent really cannot use an LLM secret after narrowing (not tested through the gateway).
- "Rejected from another pod's IP": OneCLI v2 has no source binding, so this is not provided.
- Hosts other than github.com/api.github.com (codeload, LFS) and the org egress rules in `docs/onecli-host-rules.md`.
- Pod recycling on interrupt (ADR 0003) and the orphan sweep of OneCLI agents (ADR 0002, `docs/session-api.md`) exist; neither was exercised on a repo session in the phase 4c run.
