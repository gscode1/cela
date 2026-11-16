# Repository workspace (Phase 4c)

`POST /sessions` may carry `{ "repo": "owner/name", "branch": "…" }`. The session then gets `/workspace/repo`, a clone of
that GitHub repository, and can push to it. Without `repo` nothing changes: no OneCLI agent, no secret, no GitHub call.

Status: code and unit/local tests only. Not run against the live OneCLI, GitHub or c2 (see "Unverified").

## Input

Validated in `session-core` (`repo.ts`), used by ingest: `repo` matches `^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`, owner at most 39
characters, no `..`, no leading `-`, no `.git` suffix. `branch` is a ref name: starts alphanumeric, `[A-Za-z0-9._/-]`, no `..`,
`//`, trailing `/`, `.` or `.lock`. URLs are never accepted: the orchestrator builds `https://github.com/<repo>.git` itself.
Stored in `inbox.sessions` (`repo`, `repo_branch`; migration `004_repo.sql`).

## Credentials: no GitHub token in the sandbox

```
orchestrator --JWT(App key)--> api.github.com  POST /app/installations/{id}/access_tokens
               {"repositories":["<name>"],"permissions":{"contents":"write","pull_requests":"write","metadata":"read"}}
           <-- 1 h token for that one repository (checked: the answer must list exactly owner/name)
orchestrator --admin API--> OneCLI: agent <prefix><uuid>, secrets <prefix><uuid>-git / -api, grants
sandbox command --HTTPS_PROXY=http://x:<agent token>@onecli.onecli:10255--> gateway injects the token
```

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
- The admin key is `ONECLI_API_KEY` (Secret `pi-onecli-admin`, key `api-key`), orchestrator only. It is account-level; the plan
  wants a project-scoped key or a separate provisioner before real use.

## How per-session env reaches only that session's commands

pi-env 1.5.2 `RemoteExecutionEnv` takes `shellEnv`, "added to the remote environment of every command that inherits it". It is
one option per env instance and the orchestrator builds one env per conversation (`Sandboxes.#open`), so the variables reach
only that session's commands, through the pi-env protocol to the daemon, not through the bridge process (the bridge
launcher still strips everything but its allow-list; tested). `sandbox-env` only gained a pass-through option; the bridge
and the storage adapter are untouched. Set once at env open, so it holds only stable values.

Variables (`workspace.ts` `buildShellEnv`): `HTTPS_PROXY`/`https_proxy` with the agent token, `NO_PROXY=localhost,127.0.0.1,::1`,
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
`x-ratelimit-remaining: 0`, `retry-after` or a rate-limit message) included, retry through the inbox (5 attempts).

## Repo skills

With the profile switch `repoSkills` (ADR 0014; `docs/session-api.md`, Repo skills), `SessionService.prepare` scans the
clone for `SKILL.md` files under `.pi/skills` and `.agents/skills` right after the clone step and again before each new
message, but only while the session's sandbox is already open (it never resumes a suspended one for this). The scan
runs through the session's env (`listDir`, `readTextFile`) and writes nothing to the workspace; the result goes into the
conversation's instructions.

With `repoContext` (ADR 0015) the same pass also reads the repo's `AGENTS.md` / `CLAUDE.md` (the first of five names, at the
checkout root) into the instructions, before the skills catalog.

## Branch ruleset: agents may only touch `agent/**`

A session token has `contents: write` on its repository, and GitHub cannot scope a token by ref. Without a guard the agent can
push, force-push or delete `main`. `deploy/agent-ruleset.json` is a repository ruleset that closes this:

- Target: branches, `include: ["~ALL"]`, `exclude: ["refs/heads/agent/**"]`. Every branch except `agent/**` is covered.
- Rules `creation`, `update`, `deletion`, `non_fast_forward`: nobody without bypass can create, push to (including merging a PR
  into), force-push or delete a covered branch. `update` also stops the App merging a pull request into `main`, which its
  `pull_requests: write` would otherwise allow.
- Bypass list: only the repository role Admin (`actor_type: RepositoryRole`, `actor_id: 5`, `bypass_mode: always`) so the human
  owner can still push and merge `main`. The App's installation is **not** a bypass actor; adding it would void the whole control.
  Admin bypass is a trade-off: it is the simplest way to keep the owner working and the App is not an admin role, but it also lets
  admins skip the rule by accident. A stricter option is `bypass_mode: pull_request` (admins only via PR); change the JSON and re-apply.
- Tags are not covered (the ruleset targets branches). The agent can still create tags. Add a second tag ruleset if that matters.
- Agents keep working on `agent/**`: they can create, push, force-push and delete those branches, and open a PR from one.
  `branch` in `POST /sessions` should therefore be an `agent/...` name for repository sessions that push.

Apply to every repository the GitHub App is installed on (needs `gh` logged in as a repo admin, and `jq`):

```
deploy/agent-ruleset.sh owner/repo           # create, or update the ruleset named pi-agent-branches (idempotent)
deploy/agent-ruleset.sh --check owner/repo   # read-only; exit 0 when present and matching, 1 when missing or different
```

Rulesets need a public repo, or a private one on a paid plan (GitHub Pro/Team/Enterprise). Run `--check` after every new installation.

Live check (not automated yet): with a session token, `git push origin HEAD:refs/heads/agent/x` succeeds; `git push origin HEAD:main`,
`git push --force origin HEAD:main` and `git push origin :main` are each rejected (`GH013: Repository rule violations`).

Future work: the orchestrator could refuse a repo session when `--check` would fail (the App needs `administration: read` for that).
It does not today; the ruleset is an operator step, and nothing at startup calls GitHub for it.

## OneCLI call bounds

Every management API call has a timeout and a bounded retry on network errors, timeouts and 5xx (never 4xx). A `POST` is never
re-sent; a create looks the object up by name again after a failure and POSTs only if it is absent. Environment: `PI_ONECLI_TIMEOUT_SECONDS` (default 15, per attempt), `PI_ONECLI_RETRIES` (default 3),
`PI_ONECLI_BACKOFF_MS` (default 500, doubling, capped at 5 s).

## Unverified

- The OneCLI v2 generic-secret body (`type: "generic"`, `injectionConfig: {headerName, valueFormat}`), `PATCH /v1/secrets/{id}`, the
  response shapes of `GET /v1/agents`, `/v1/secrets` and `GET /v1/agents/{id}/grants`, and `DELETE …/grants/connections/{id}` come
  from the v1.45 spike or are guessed; list parsing accepts two shapes and fails closed on anything else. There is no separate
  "effective credentials" call: the grant list is used.
- Basic injection for `github.com` with a minted token, push through the gateway, and `proxyAuthMethod=basic` on v2.
- That an agent really cannot use an LLM secret after narrowing (not tested through the gateway).
- "Rejected from another pod's IP": OneCLI v2 has no source binding, so this is not provided.
- Hosts other than github.com/api.github.com (codeload, LFS) and the org egress rules in `docs/onecli-host-rules.md`.
- Network: the orchestrator needs `deploy/cilium/orchestrator-github.yaml`, and the sandbox needs the new image (`images/sandbox`,
  tag `1.5.2-r2-<sha>`) in `deploy/sandbox-template.yaml`.
- Recycling the Pod on interrupt for repo sessions (plan, `setsid` children) and a sweep of orphaned agents are not built.
