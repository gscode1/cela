# 0048: Node, Python and common CLIs in the default sandbox image

Status: accepted, 2026-11-20 (issue #318).

## Context

The default sandbox image had only `sandboxd`, `git`, `ca-certificates` and `pi-env`. Tool commands run as uid 1000
without root, so an agent could not install anything, and `nodejs.org` is in no egress rule set. A `renovate` profile
session on cela-dev that reviews Renovate PRs ended `UNSURE` twice: no npm to run the checks, no `curl` or `python3` to
post its PR comment, although its GitHub App token allowed it.

## Decision

- **Tools.** The default image ships Node 22 with npm and corepack (pnpm and yarn shims), Python 3 with pip and venv,
  `build-essential`, `curl`, `jq`, `unzip` and `gh`. The list and versions are in [sandbox-image.md](../sandbox-image.md).
  The browser image is unchanged.
- **Sources.** Node, its headers, npm and corepack are copied from the pinned `node:22-bookworm-slim` stage the image
  already has for `pi-env` (bookworm's `nodejs` is v18). Python, the compilers, `curl`, `jq` and `unzip` come from
  bookworm apt. `gh` is its release `.deb`, pinned by version and SHA-256 per architecture like agent-browser in the
  browser image. Go and Rust stay out until a repository needs them.
- **A writable home, caches on the PVC.** uid 1000 has no passwd entry, so `HOME` was `/`. The image sets
  `HOME=/home/pi` (owned by uid 1000) and puts the npm, corepack and XDG (pip) caches under `/workspace/.cache`: they
  survive a sandbox restart and do not count against the small `ephemeralStorage` limit (1 GiB for the smallest size),
  which an `npm ci` cache could otherwise exceed and get the Pod evicted. `npm_config_nodedir=/usr/local` lets node-gyp
  build native modules against the copied headers without fetching them from `nodejs.org`.
- **gh through OneCLI.** `gh` will not call the API without a token. A repository session's environment
  (`buildWorkspaceEnv`) sets `GH_TOKEN` to a fixed placeholder that does not look like a GitHub token; OneCLI replaces
  the `Authorization` header on `api.github.com` with the session's own token, as it already does for git. It also sets
  `REQUESTS_CA_BUNDLE` to the OneCLI CA bundle, because Python's requests and pip ignore `SSL_CERT_FILE`.
- **No egress change.** npm and PyPI are in the `packages` rule set (ADR 0034 addendum), which a profile adds;
  `github.com` and `api.github.com` already reach OneCLI in a repository session.

## Consequences

- The image grows from 330 MB to 1.01 GB on disk and from 75 MB to 254 MB compressed (arm64). Each node pulls it once.
- More packages mean more CVE reports. The pins are bumped on a schedule, not on every patch release.
- A workspace PVC now also holds tool caches. They count against the PVC size, and deleting `/workspace/.cache` is safe.
- `pip install` into the system Python is refused (PEP 668): agents use a venv.
- Verified locally; the repository-session check through the proxy is the `tools` test of `tests/e2e/run.sh phase4c`.
