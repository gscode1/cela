# 0051: The MCP adapter ships as an npm tarball and an MCPB bundle on GitHub Releases

Status: accepted, 2026-11-20 (issue #345). Builds on [0031](0031-mcp-adapter.md) and [0033](0033-own-adapter-package.md).

## Context

The adapter (`packages/mcp`) ran only from a git checkout: clone, `pnpm install`, build, register `dist/main.js`. Claude
Desktop then keeps `PI_API_TOKEN` and `PI_API_ADMIN_TOKEN` in plain text in `claude_desktop_config.json`, where any local
agent with a shell can read them. Publishing to the npm registry or GitHub Packages would make `npx` easy, but both need a
token to install, which defeats the purpose.

## Decision

- **GitHub Releases only.** A tag `mcp-vX.Y.Z` runs `.github/workflows/mcp-release.yml`, which attaches two assets:
  `cela-mcp-X.Y.Z.tgz` (the npm tarball) and `cela-mcp-X.Y.Z.mcpb` (an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb)
  for Claude Desktop). Claude Code installs with `npx -y <release asset URL>`; the repository is public, so the download
  needs no token. Nothing is published to a registry.
- **One version, three places.** `packages/mcp/package.json`, `packages/mcp/manifest.json` and `SERVER_VERSION` in
  `src/server.ts` must be equal, and equal to the tag. A unit test (`test/release.test.ts`, part of `pnpm check`) checks
  the first three; the workflow checks the tag. The package is no longer `private`. Versions start at 1.0.0 and follow
  semver for the tools and settings.
- **The npm tarball** has `files: ["dist"]`, the bin `cela-mcp`, and only `@modelcontextprotocol/server` and `zod` as
  dependencies. A test rejects `workspace:`, `file:` and `link:` specifiers in dependencies. Workspace
  devDependencies (`@cela/session-core`) never reach consumers.
- **The bundle** is `server.type: node`, entry `dist/main.js`, manifest version 0.3 (the CLI's default). It carries a
  flat production `node_modules`, built from the workspace lockfile with `pnpm deploy --prod` and the hoisted linker, so
  there are no symlinks and no dev dependencies. The `.mcpb` is built by `packages/mcp/scripts/release-build.sh`, which
  the workflow and a developer use alike.
- **Settings.** `user_config` has `api_url`, `api_token` (sensitive, required), `admin_enabled`, `admin_token` (sensitive),
  `admin_writes` and `max_sessions`, mapped to the `PI_*` variables. The MCPB spec says a `sensitive` string is masked and
  stored securely by the host; Claude Desktop keeps it in the OS keychain, not in the config file.
- **Optional settings always have a default.** The reference substitution of `@anthropic-ai/mcpb` (`replaceVariables`) leaves
  `${user_config.x}` as a literal string when a setting has no value, and `parseConfig` would take that literal for a
  token or reject it as a flag. Booleans default to `false`, `max_sessions` to 20 and `admin_token` to the empty string,
  which `parseConfig` already treats as unset. A test renders the manifest with the reference code and feeds the result to
  `parseConfig`.
- **Pinned tooling.** `@anthropic-ai/mcpb` is an exact devDependency of `packages/mcp` (2.1.2), so the lockfile pins the CLI
  that CI uses and the unit test validates the manifest against the same strict schema as `mcpb validate`. The workflow's
  actions are pinned by commit like the other workflows.
- **Smoke test before release.** The workflow runs the tarball through `npx` from a fresh directory outside the checkout and the unpacked
  bundle with `node`, each as a stdio server with a fake environment, and checks `initialize` (name, version) and
  `tools/list`. Listing tools never calls the API.

## Consequences

- A release is a tag push after bumping the version in three files; no secret and no registry account is involved.
- The bundle is unsigned: Claude Desktop shows its unsigned-extension warning. `mcpb sign` needs a certificate and is left
  for later.
- If the repository becomes private, `npx` can no longer download the tarball without a token and the Claude Code install
  must change.
- The bundle declares Node 22.19 or newer in `compatibility.runtimes`, as the package does in `engines`. Whether Claude
  Desktop's own runtime meets it is checked by trying the first release.
- Each release bundles about 800 files (2 MB compressed), mostly `zod`'s sources. Trimming them is not worth a custom bundler.
