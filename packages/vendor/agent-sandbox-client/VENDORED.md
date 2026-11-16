# Vendored: agentic-sandbox-client

- Upstream: https://github.com/kubernetes-sigs/agent-sandbox
- Path: `clients/typescript/agentic-sandbox-client`
- Tag: `v1.0.11`
- Commit: `890de53a4dd18e35313173e6dc34d9559b1a9733`
- License: Apache-2.0 (see `LICENSE`, copied from the upstream repo root)

Copied as source, not a submodule. Changes from upstream:

- `package.json`: dependencies pinned exactly. The connect-es packages (`@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-node`) are regular dependencies here because `commands.start()` needs them (upstream lists them as optional peers). `@types/node` is pinned to 22.20.5 (the older 22.0.0 fails to compile `src/tunnel.ts`). The `biome` scripts were dropped.
- `src/__tests__`, `biome.json`, `vitest.config.ts`, `tsconfig.test.json` and `package-lock.json` were not copied.

Only `packages/sandbox-env/src/sandbox-client.ts` may import this package. To upgrade, re-copy from a new pinned commit and update this file.
