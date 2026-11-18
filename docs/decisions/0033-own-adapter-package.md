# 0033: The Postgres adapter is our own npm package

Status: accepted, 2026-11-18 (issue #231). Replaces the vendored tarball that plan.md's phase 2 introduced.

## Context

The orchestrator stores agent state through a Postgres adapter for Pi Durable. Upstream is
`@netzlabor/pi-durable-postgres` (j-koester/pi-durable-postgres), which supports Pi Durable up to 1.1.0. We ported it
to the 1.5.2 storage contract in the fork gscode1/pi-durable-postgres and proposed the port upstream in
j-koester/pi-durable-postgres#20.

Until now the port was a tarball checked into `vendor/`, with a sha256 in `vendor/README.md` and a test that compared
the two. Three things were wrong with that:

- **Two artifacts with one identity.** The tarball was `@netzlabor/pi-durable-postgres` 0.2.0. Upstream published a
  different 0.2.0 under that name on 2026-10-08 (Pi Durable 1.1.0). A lockfile, an audit tool or a reader could not
  tell them apart by name and version.
- **Waiting on a review that may not come.** The upstream pull request had no review and no comment, and the upstream
  default branch had no commit since 2026-10-08. Everything here depends on the adapter, so its release cannot depend
  on someone else's schedule.
- **A binary in git, checked by hand.** Each adapter change meant a new tarball, a new sha256 line, and a `COPY vendor`
  in every image build.

## Decision

- **The fork publishes the port to the public npm registry as `@gscode1/pi-durable-postgres`.** The `@netzlabor` scope
  is upstream's; we never publish under it.
- **Versions start at 0.3.0**, above every upstream release, so a version number alone never matches an upstream
  artifact.
- **This repo depends on an exact version** (`"@gscode1/pi-durable-postgres": "0.3.0"`), as AGENT.md requires for the
  adapter. `pnpm-lock.yaml` holds the integrity hash, which replaces the sha256 in `vendor/README.md`.
  `packages/orchestrator/test/adapter-pin.test.ts` fails on a range, a tag, a `file:` path or a git reference.
- **`vendor/` is removed**, with its README, its sha256 test, the `COPY vendor` step of the three application images
  and the `.dockerignore` exception.
- **The upstream pull request stays open.** If upstream merges it and releases, moving back is a dependency rename;
  that would be a new decision.
- **Releases follow the fork's `docs/releasing.md`:** conformance and regression suites against PostgreSQL 17, the
  package smoke test, then a version tag. The peer dependencies on Pi Durable and Chord stay exact, so a Pi Durable
  upgrade here always needs an adapter release first.

## Consequences

- An install and an image build now need the npm registry for the adapter too. They already needed it for every other
  dependency.
- We maintain the adapter: Pi Durable contract changes, security fixes and releases are ours. This was already true in
  practice since the port.
- 0.3.0 has the same source as the tarball it replaces (fork commit `b43fe16`) plus the rename. Its schema version is
  still 2, so existing databases open unchanged.
- The package name appears in one import, `packages/orchestrator/src/storage.ts`.
- npm does not allow a published version to be replaced. A bad release is fixed by a new version.
- pnpm's minimum release age refuses a version published minutes ago. `pnpm-workspace.yaml` exempts the exact pinned
  adapter version (`minimumReleaseAgeExclude`); each adapter upgrade updates that entry with the version.

## Alternatives rejected

- **Keep the tarball until upstream answers.** Leaves the identity clash and the open-ended wait.
- **A git dependency on the fork's tag.** The adapter's `dist` is not committed, so every install would run its build;
  that is why the tarball existed in the first place.
- **GitHub Packages.** Installs need a token even for a public package, in CI, in image builds and for every outside
  user.
- **A tarball attached to a GitHub release.** No registry account needed, but no version resolution and no Dependabot.
