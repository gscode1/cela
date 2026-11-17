# vendor/

`netzlabor-pi-durable-postgres-0.2.0.tgz`: `@netzlabor/pi-durable-postgres` 0.2.0, the port of the Postgres storage adapter
to Pi Durable 1.5.2. A git+file dependency needs the adapter's build scripts to run at install time (dist is not committed),
so the packed tarball is checked in instead. Replace it when the upstream PR lands and a release exists.

## Provenance

- Published fork: https://github.com/gscode1/pi-durable-postgres
- Branch `port-pi-durable-1.5`, tag `v0.2.0-pi-durable-1.5.2`, commit `b43fe1688a850bb415c38dab071c013240e43d47`
- Upstream PR: https://github.com/j-koester/pi-durable-postgres/pull/20
- Contract diff: `docs/port-1.5.md` in the fork

## Integrity

The sha256 of the tarball is the single recorded value. `packages/orchestrator/test/vendor-tarball.test.ts` reads it from
this line and fails when the file differs:

sha256: `cffe9cf2649a6b22cd1778e5cd74840d08f09e669991eb29c6e76c6ca198904e`

When you replace the tarball, update this line, the tag and the commit in the same change.

## Rebuild

A fresh `pnpm pack` at the tag reproduces the same sha256 (checked with pnpm 10.16.1 and Node 26.12.1; pack normalizes
file mtimes). If a different toolchain gives another hash, compare the extracted contents instead (`tar -xzf` both, then
`diff -r`).

```sh
git clone https://github.com/gscode1/pi-durable-postgres.git
cd pi-durable-postgres
git checkout v0.2.0-pi-durable-1.5.2   # b43fe1688a850bb415c38dab071c013240e43d47
pnpm install --frozen-lockfile
pnpm pack --pack-destination ..        # runs prepack (tsc build)
shasum -a 256 ../netzlabor-pi-durable-postgres-0.2.0.tgz
```
