# 0001: Per-sandbox sandboxd token

Status: accepted, 2026-11-16 (issue #7). Replaces the single shared token of Phases 1 to 4.

## Context

Every sandbox's sandboxd started with the same `--auth-token-sha256`, read from Secret `sandboxd-auth`. A sandbox that
learned the shared token (or its hash, which sits in its own Pod spec and env) could authenticate to any other
sandbox's sandboxd. NetworkPolicy already blocks sandbox-to-sandbox traffic; this is the second layer, for the day a
policy is wrong or a sandbox is reached another way.

## Decision

- **Derivation.** `token = hex(HMAC-SHA256(master, claimName))`, in `packages/sandbox-env/src/token.ts`
  (`deriveSandboxToken`, `sandboxTokenSha256`). It is the only implementation: the e2e suites call it too (inside the
  orchestrator or runner pod), not a copy in shell.
- **What a sandbox gets.** Only `sha256(token)`, set by the orchestrator in the SandboxClaim `spec.env` as
  `SANDBOXD_AUTH_TOKEN_SHA256`. The hash does not reveal the token, and it is the hash of one claim's token only.
- **Where the master lives.** Secret `sandboxd-auth`, key `master` (`deploy/gen-secret.sh`, idempotent, `ROTATE=1`
  to replace). It reaches the orchestrator (`PI_SANDBOX_MASTER_KEY`) and the e2e driver and runner. It never reaches a
  sandbox or a bridge. Since [0016](0016-in-process-broker.md) the derived token is no longer in a child process at all:
  the env's broker, inside the orchestrator, holds the token of its own claim and talks to sandboxd. The process pi-env
  spawns is a relay (`env -i NAME=value... node relay.js`, `bridgeCommand` in `bridge-launcher.ts`) with only `PATH`,
  `HOME` and a few locale and Node variables, and no token in argv or environment. (Before 0016 the bridge was a child
  process that got `PI_SANDBOX_AUTH_TOKEN` through `env -i`, because an earlier launcher inherited the orchestrator's whole
  environment, master key included, and a same-uid child could read its `/proc/<pid>/environ`; the `env -i` start stays
  for the same reason.) The token is no longer visible to same-uid processes in the pod through a command line.
- **Re-derived, not stored.** The orchestrator derives the token whenever it opens a session's env, so a restart needs
  no state.

## How the claim env reaches the Pod (agent-sandbox v1.0.11, verified in the controller source and on the cluster)

- The SandboxTemplate must set `envVarsInjectionPolicy`. The default `Disallowed` rejects any claim with `spec.env`.
- `Allowed` appends variables the template does not define and rejects a claim that names one it does define.
  `Overrides` replaces the whole entry (including a `valueFrom`). We use **`Allowed` and no template definition**, so a
  claim can never replace a value the template pins.
- Claims with `spec.env` cold-start a Pod; the warm pool has `replicas: 0`, so nothing changes.
- **Fail closed.** The template keeps `--auth-token-sha256=$(SANDBOXD_AUTH_TOKEN_SHA256)` and no value for the variable.
  A claim created without the env makes a Pod whose argument is the literal `$(...)` text; sandboxd refuses to start
  (`auth token sha256: encoding/hex: invalid byte: U+0024`) and CrashLoops. Observed on c2. There is no path to a
  sandboxd without authentication.

## Migration of existing claims

The env is baked into the Pod when the Sandbox is created, and a claim's env cannot be changed afterwards. Pods
created before this change carry the old shared hash, so they cannot be moved to per-sandbox tokens. Choice: **one-time
recreate, with a clear error and no silent fallback.**

- `ensureLabeledClaim` compares the existing claim's `SANDBOXD_AUTH_TOKEN_SHA256` with the expected one and throws
  `SandboxClaim <name> has no matching SANDBOXD_AUTH_TOKEN_SHA256 ... delete the claim and its PVC to recreate it`.
  The same error appears after a master rotation.
- Recreating means deleting the claim and its workspace PVC (`workspace-<claim>`); the session's conversation state is
  in Postgres and is kept, the workspace files are lost. Session deletion through the API does this too.
- A shared-token fallback was rejected: it would keep the weakness this change removes.
- Secret keys `token` and `token-sha256` are removed by `deploy/gen-secret.sh`. A Pod from the old scheme that restarts
  can no longer start (its secretKeyRef is gone), which is the same outcome as a recreate.
- The static `deploy/sandbox-claim.yaml` (`sample-session`) is removed: a manifest cannot carry a per-claim hash. The
  Phase 1 suite creates and deletes its own claim `e2e-phase1`.

## Consequences

- A leaked token or hash opens one sandbox only. The master is the crown jewel: it can open every sandbox, so it stays
  out of sandboxes and bridges (e2e check in `tests/e2e/run-phase4.sh`, bridge env unit test).
- The e2e suites assert it: sandbox B's sandboxd rejects no token, A's token, A's hash and B's hash, and accepts B's
  token (`EVIDENCE per-sandbox-token` in the `isolation` test of Phase 3).
- Rotating the master recreates every sandbox's claim.
