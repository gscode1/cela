# 0016: An in-process broker and a thin relay replace the per-session bridge process

Status: accepted, 2026-11-16 (issue #59, slice 1). Builds on [0001](0001-per-sandbox-sandboxd-token.md),
[0003](0003-recycle-pod-on-interrupt.md) and [0004](0004-idle-suspend.md) (the cap addendum).

## Context

pi-env's `Connection` can only spawn a local argv and talk to it over stdio, so each session's hop to its sandbox was a
Node process of its own (`cli.js`). Each loaded the vendored SDK, `@kubernetes/client-node` and connect-es: about 95 MiB
against 11 MiB for a bare Node process, and about 430 ms of import time locally, many seconds at 250m CPU. That drove the
start gate, the cap on open bridges and the cold-start part of every first tool call. sandboxd and the network were not
the cost. No ADR requires the separate process.

## Decision

- **Broker.** `packages/sandbox-env/src/broker.ts`: each env owns a unix-socket server inside the orchestrator, in a fresh
  0700 temp directory that `close()` removes. It serves a connection by running the unchanged `runBridge` over the socket
  with the SDK's `commands.start()` as `start`. The sandboxd token is held there, in the orchestrator process.
- **Relay.** `packages/sandbox-env/src/relay.ts`: the program pi-env's `Connection` spawns (`node dist/relay.js`, through
  `env -i`, found next to `index.js` like the old `cli.js`). It imports only `node:net`, pipes stdin/stdout to the socket,
  prints the broker's log lines on stderr and exits when the socket closes. Its argv is `--socket <path> --nonce <n>
  --claim <name>` plus pi-env's `serve --token <hex>`; `--claim` stays because `bridge-rss` finds the process by it.
  It has no token in argv or environment.
- **Two connections, no mux.** The relay opens a `log` connection (the broker's stderr: `bridge: ready`, failures, remote
  stderr), waits for the broker's ack, then a `data` connection (the pi-env byte stream). Each starts with one JSON header
  line `{nonce, role, args}`. Nothing is framed after that.
- **Nonce.** One per relay spawn (`Connection` calls `command()` for each), single use, and issuing a new one voids the
  last. A wrong nonce is closed without an answer. The 0700 directory is the main protection; the nonce stops a leftover
  or stale relay from taking the connection.
- **One connection at a time per env.** A new `data` connection first aborts the previous one (`runBridge` has an abort
  signal now) and waits for its task. When the stream or socket is lost `runBridge` returns, the broker closes both
  sockets, the relay exits, `Connection` respawns it and it connects again. No reconnect code beyond what ADR 0003 found.
  Addendum (#122): before each respawn (not the first spawn) `connectSandboxEnv` waits until the Sandbox is Ready again.
  pi-env gives a spawned relay 30 s of silence, and a Pod replacement under load took longer, so the wait has to come
  before the spawn. It also comes before the start gate, so an env waiting for its Pod holds no other env's start.
- **Containment.** Every connection's task is wrapped: a rejection or throw destroys only its own sockets, and every
  socket carries an `error` listener. The `bridge: ready` line is still written, so the `bridge-ready` timing phase and
  the start gate work as before.
- **Unchanged.** `Sandboxes` (ADR 0003 and 0004, the FIFO slot queue, `PI_MAX_OPEN_BRIDGES`, 12 then and derived from the memory limit since [0018](0018-derived-bridge-cap.md)) and `StartGate`.
  The cap now bounds relay processes and in-process handles; whether to raise it, and whether to delete `StartGate`, is for
  later and should come from the #58 numbers.
- **SDK auto-cleanup stays off.** `SandboxClient.enableAutoCleanup()` installs process-wide SIGINT/SIGTERM handlers that
  delete claims. Nothing calls it, and `isolation.test.ts` fails if anything outside the vendored SDK does.

## Rejected

- **(b) One shared child process multiplexing all sessions.** It needs a mux protocol and makes one process a single point
  of failure for every session.
- **(c) Cheaper per-session processes.** They would still load the Kubernetes client, so the memory and start cost stay.
- **(a2)** A small pi-env patch making the spawn injectable would remove the process entirely. Only if the relay still
  matters after this.

## Risks

- SDK faults and event-loop load now land in the orchestrator: a blocked loop delays every session's stdio, and an
  uncaught exception thrown outside a promise from SDK code would no longer kill one bridge only.
- One sandbox's output must not fill the shared process: the SDK's output is pulled one chunk at a time and the next
  is read only once the relay's socket drains, so a slow reader stalls the sandbox's process, not the orchestrator. A
  start that does not wait is cut off at 16 MiB queued per stream (#199).
- A start may take 30 s, the time pi-env gives a silent relay, and is abandoned when the relay goes, so a hung one
  cannot hold the env's next connection (#200).
- The memory per in-process handle (gRPC channel and Kubernetes client per `start`) is unmeasured. Compare `bridge`,
  `sandbox-to-exec`, `bridge-rss` (now the relay) and orchestrator RSS at 12 and 50 sessions with
  [docs/metrics.md](../metrics.md).
- The relay's exit code is 0 or 1 by whether the data socket errored; pi-env only needs the exit.

## Measured (2026-11-16, the example test cluster, throwaway e2e namespaces, same four phase 4 tests, 5 cold + 1 resumed turn)

| | before (per-session bridge) | after (relay + broker) |
| --- | --- | --- |
| `bridge` span, cold p50 / p90 | 1.8 s / 2.3 s | 0.26 s / 0.9 s |
| per-session process RSS | about 126 MiB | about 44 MiB (bare Node in the container) |
| orchestrator main process RSS, idle | 175 MiB (main) | 160 MiB |

`claim` (Pod ready, about 16–20 s) still dominates `sandbox-to-exec`, so time to first command barely moves. The
memory under load (12 and 50 open sessions, main process RSS per in-process handle) is not measured yet; do that
before raising `PI_MAX_OPEN_BRIDGES`.
