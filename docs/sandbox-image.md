# The default sandbox image

`pi-sandbox` (`images/sandbox/Dockerfile`) is the image of the `default` flavour: what a session's tool commands run in.
The `browser` flavour (`pi-sandbox-browser`, [ADR 0041](decisions/0041-browser-sandbox.md)) is built separately and does
not ship the tools below. Decision: [ADR 0048](decisions/0048-sandbox-image-tools.md) (issue #318).

## What it ships

| Tool | Version | Source |
| --- | --- | --- |
| `sandboxd` | v1.0.11 | base image `registry.k8s.io/agent-sandbox/sandboxd` (Debian 12 bookworm) |
| `pi-env` | 1.5.2 | npm tarball, binary by architecture and SHA-256 ([images/README.md](../images/README.md)) |
| `node`, `npm`, `npx` | Node 22.23.5, npm 10.9.9 | copied from the pinned `node:22-bookworm-slim` stage (bookworm's `nodejs` is v18), with the Node headers |
| `corepack`, `pnpm`, `yarn` | corepack 0.36.0 | shims from `corepack enable`; corepack downloads the package manager on first use, or the version a repository's `packageManager` names |
| `python3`, `pip`, `venv` | Python 3.11.2, pip 23.0.1 | bookworm apt (`python3`, `python3-pip`, `python3-venv`) |
| `gcc`, `g++`, `make`, libc headers | GCC 12.2 | bookworm apt (`build-essential`), for native npm and pip modules |
| `git` | 2.39.5 | bookworm apt |
| `curl`, `jq`, `unzip` | curl 7.88.1, jq 1.6, UnZip 6.00 | bookworm apt |
| `gh` | 2.103.3 | release `.deb` from `github.com/cli/cli`, by architecture and SHA-256 |
| `ca-certificates` | | bookworm apt |

Versions are the ones the pinned sources gave on 2026-11-20. The apt packages follow bookworm at build time; Node, `pi-env`
and `gh` change only when their pin in the Dockerfile does. Bump the pins on purpose and on a schedule, not on every patch
release, to keep image churn and CVE noise down. Go and Rust toolchains are not in the image: add them when a repository
needs them.

Size (arm64, `docker image ls`): 1.01 GB on disk and 254 MB compressed, up from 330 MB and 75 MB before these tools. Image
layers do not count against the sandbox's `ephemeralStorage` limit.

## Runtime layout

Commands run as uid 1000, which has no passwd entry and no root, so nothing can be installed with apt at run time.

| Variable | Value | Why |
| --- | --- | --- |
| `HOME` | `/home/pi` (owned by uid 1000) | otherwise `/`, which is not writable; holds tool config such as `gh`'s |
| `XDG_CACHE_HOME` | `/workspace/.cache` | pip's cache and others land on the workspace PVC: kept across restarts, not counted against `ephemeralStorage` |
| `npm_config_cache` | `/workspace/.cache/npm` | same, for npm |
| `COREPACK_HOME` | `/workspace/.cache/corepack` | same, for the package managers corepack downloads |
| `npm_config_nodedir` | `/usr/local` | node-gyp uses the copied headers instead of downloading them from `nodejs.org`, which no egress rule allows |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT`, `npm_config_update_notifier`, `PIP_DISABLE_PIP_VERSION_CHECK`, `GH_NO_UPDATE_NOTIFIER`, `GH_PROMPT_DISABLED` | off | no prompts and no update checks in a non-interactive sandbox |

`pip install` outside a virtual environment is refused (bookworm marks the system Python as externally managed, PEP 668):
use `python3 -m venv`.

## Proxy, CA and GitHub

The tools need no configuration of their own for the egress proxy. The session's environment
([repo workspace](repo-workspace.md)) sets `HTTPS_PROXY`/`https_proxy` with the egress token as the proxy password, which
`curl`, `gh`, `git`, npm, pip and Node's `fetch` (with `NODE_USE_ENV_PROXY=1`) all honour. A repository session also gets
the OneCLI CA: `SSL_CERT_FILE` (OpenSSL clients, `curl`, `gh`), `GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS` and
`REQUESTS_CA_BUNDLE` (Python's requests and pip, which ignore `SSL_CERT_FILE`).

`gh` refuses to call the API without a token, so a repository session has `GH_TOKEN` set to a fixed placeholder
(`onecli-injects-the-token`). It is not a credential: OneCLI replaces the `Authorization` header on `api.github.com` with the
session's repository-scoped token, which the sandbox never sees.

Which hosts a session may reach is the profile's business, not the image's: npm and PyPI need the `packages` rule set
([ADR 0034](decisions/0034-egress-rules.md)), `github.com` and `api.github.com` go through OneCLI in a repository session.

## Verification

- Local (arm64, Docker, no proxy): all tools above run as uid 1000; `npm install`, a native module built from source
  against the copied headers, `pnpm -v` through corepack, `python3 -m venv` with `pip install`, `curl` and `gh api` to
  `api.github.com`.
- In a repository session through the egress proxy: `tests/e2e/run.sh phase4c` (test `tools`, needs `REPO_A` and `REPO_B`)
  runs `node -v`, `npm ci`, `pnpm -v`, a venv with `pip install`, `curl` to the private `REPO_A` on `api.github.com`, and
  `gh pr create` plus `gh pr comment` on a test branch of `REPO_A`, then closes the PR and deletes the branch.
