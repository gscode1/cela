# 0046: Patchright replaces Playwright CLI in the browser image

Status: accepted, 2026-11-19 (issue #310). Amends [0041](0041-browser-sandbox.md): the tools section and the `playwright-cli`
skill. Everything else in 0041 (the flavour, `pi-browser`, the forwarder, the egress rules, durability, sizes) is unchanged.

## Context

The browser image drove its one Chromium with Playwright CLI (primary) and agent-browser. The owner wants
[Patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (Apache-2.0), a patched Playwright that avoids the
automation tells of stock Playwright, in place of Playwright.

## Decision

- **Library:** `patchright` 1.64.3 (npm, Kaliiiiiiiiii-Vinyzu; it depends on `patchright-core` 1.64.3 only), pinned by
  `images/sandbox-browser/package-lock.json` and installed with `npm ci --ignore-scripts`. `@playwright/cli` and `playwright`
  are gone from the image. The Chromium is the build Patchright's own `install` fetches (`patchright install --no-shell
  chromium`, system libraries from `install-deps`), still under `PLAYWRIGHT_BROWSERS_PATH` and linked as `pi-chromium`.
- **No CLI.** Patchright ships none. The npm package `patchright-cli` is not used: one maintainer, and its repository field
  points at a private Azure DevOps repository, so its source cannot be reviewed. Writing our own CLI is more code to own
  than the need justifies.
- **Scripts instead.** The `patchright` skill (replacing `playwright-cli`) teaches the agent to write a short CommonJS script
  and run it with `patchright-run script.cjs` (a wrapper that sets `NODE_PATH` and a writable `HOME`, then runs `node`). The
  script attaches with `chromium.connectOverCDP("http://127.0.0.1:9222")`: `pi-browser` still starts and owns the one
  Chromium with the flags, the policy and the forwarder, so no script launches a browser. `agent-browser` and its skill stay
  as the CLI for quick reads.
- **Profile seed.** `hack/seed-browser-profile.mjs` seeds the skills `patchright` and `agent-browser`. The create-only rule
  stands: an existing `browser` profile or a `playwright-cli` skill is never touched, so an existing install keeps its old
  skill (the image no longer has the command) until an operator updates the profile's skills.

## Security

Nothing in 0041's Security section changes: the same Chromium flags, URL blocklist, egress proxy, no credentials, CDP on
127.0.0.1. Patchright changes how a script talks to Chromium (no `Runtime.enable` leak, isolated-world `evaluate`), not what
the sandbox lets it reach. The skill tells the agent not to use it to get past bot checks or access controls, and that a site
refusing the browser is a result to report.

## Consequences

- The image has one npm dependency tree of two packages (before: the Playwright CLI tree). Patchright trails Playwright's
  version; Chromium is 156 (`patchright-core` 1.64.3) instead of Playwright 1.66's build.
- An agent now writes a script where it typed CLI commands: more tokens for a simple read (use `agent-browser` for those), but
  full Playwright API for complex flows.
- Existing installs keep a `playwright-cli` skill whose command is gone (see Decision, profile seed).
- amd64 is built by CI and not run here; the arm64 image was built and the e2e suite `browser` is the acceptance test.

## Alternatives not taken

- **Add Patchright next to Playwright CLI:** two Chromium builds or a mismatch, a larger image, two ways to do one job.
- **`patchright-cli` from npm:** see above.
- **An in-repo CLI over Patchright:** deferred; revisit if agents struggle with scripts.
