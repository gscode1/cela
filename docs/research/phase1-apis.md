# Phase 1 API brief (stdio bridge + sandbox basics)

Researched 2026-11-15. Read-only research; no code was run (daemon binaries were only inspected with `file`).
Method: `gh` was NOT authenticated, so sources are `git clone --depth 1`, `npm view` / `npm pack`, `curl` of the public GitHub
releases API, and `registry.k8s.io` manifest queries. Clones live in the session scratchpad (`.../scratchpad/src/pi`, `.../scratchpad/src/as`).

Pinned refs used below:

| Repo | Ref | SHA |
|---|---|---|
| earendil-works/pi | `main` HEAD at clone time (package.json = 1.5.2) | `4f95fbe2f117d288610e937889ad03575777841c` (tag `v1.5.2` = `b4afdddf44e059c67ccf5097e5317d913521b470` per `git ls-remote`) |
| kubernetes-sigs/agent-sandbox | `main` HEAD at clone time (2026-11-13) | `454d3353e5c26c561dd6de389f32f7f285030e38` |
| kubernetes-sigs/agent-sandbox | latest release `v1.0.11` (published 2026-11-12) | tag object `406a1f53...`, commit `890de53a4dd18e35313173e6dc34d9559b1a9733` |

Source for agent-sandbox code citations is HEAD `454d335`. I spot-checked that `commands.start`, `in-cluster-service`, `examples/pi-code-agent` and
`packages/sandboxd/Dockerfile` also exist at tag `v1.0.11` (raw.githubusercontent.com). Other details were not diffed between the two refs.

---

## 1. Pi Durable

- npm `@earendil-works/pi-durable`: latest **1.5.2** (versions 1.5.0, 1.5.1, 1.5.2 exist; `npm view`). Repo path `packages/durable`, `package.json` version 1.5.2.
- Exports of interest (`packages/durable/package.json`): `.`, `./env`, `./env/node`, `./testing`.
- `ExecutionEnv` is `export interface ExecutionEnv extends FileSystem, Shell {}` in `packages/durable/src/env/index.ts:377`. `NodeExecutionEnv` is in `src/env/node.ts`.
  README (`packages/durable/README.md:558`): "A custom environment can check itself with `registerEnvConformance()` from `@earendil-works/pi-durable/testing`".
- `RemoteExecutionEnv` is NOT in pi-durable; it is in pi-env (`packages/env/src/remote-env.ts:354`, `class RemoteExecutionEnv implements ExecutionEnv`):
  ```ts
  export interface RemoteExecutionEnvOptions {
    connection: Connection; id: string; cwd: string;
    shellPath?: string; shellEnv?: Record<string,string>; watch?: RemoteWatchOptions;
  }
  ```
  `id` is the file namespace, e.g. `"pi-env:<name>"`.
- **Env conformance suite**: `registerEnvConformance` in `packages/durable/src/testing/runner.ts:28`, implementation `src/testing/env-conformance.ts`.
  Signature:
  ```ts
  registerEnvConformance(
    runner: { describe, expect, it },            // Vitest/Jest compatible
    name: string,
    withEnv: EnvConformanceProvider,             // async (use) => { ...; await use(env); ... cleanup }
    options?: { shell?, symlinks?, listFiles? }  // Pick<EnvConformanceOptions, ...>
  ): void
  ```
  Import path: `import { registerEnvConformance } from "@earendil-works/pi-durable/testing"`.
- How to run it against a custom env (pattern copied from `packages/env/test/conformance.test.ts`):
  ```ts
  import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
  import { describe, expect, it } from "vitest";
  registerEnvConformance({ describe, expect, it }, "SandboxEnv", async (use) => {
    const cwd = /* fresh dir inside the sandbox */;
    try { await use(new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd })); }
    finally { /* rm cwd */ }
  }, { listFiles: true });
  ```
  Then `npx vitest run <file>`. pi-env itself uses vitest 4.1.12 (`packages/env/package.json`). The cwd must exist on the machine where the daemon runs (the sandbox), not locally.
  Note: the provider is called per test case, so a long-lived `Connection` shared across cases (as pi-env's own test does) is the intended pattern.
- Unverified: exact list/number of conformance cases (not enumerated; see `env-conformance.ts` if needed). Per-case timeouts come from `testCase.timeoutMs`.

## 2. pi-env

- npm `@earendil-works/pi-env`: latest **1.5.2**. Dependencies pinned exactly: `@earendil-works/chord` 1.5.2, `@earendil-works/pi-durable` 1.5.2. `engines.node >=22.19.0`.
  Tarball ships `bin/pi-env-<os>-<arch>/pi-env` for darwin, linux, android, windows on x64 and arm64.
- **Daemon**: a Rust program (`packages/env/daemon`), binary named `pi-env`. It is NOT a Node program. Verified with `file` on the 1.5.2 tarball:
  - `bin/pi-env-linux-arm64/pi-env`: ELF aarch64, **statically linked**, stripped, about 2.1 MB.
  - `bin/pi-env-linux-x64/pi-env`: ELF x86-64 static-pie.
  CI builds them from `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` (`.github/workflows/env-daemons.yml`).
  So: **Node is not needed in the sandbox image; arm64 is supported.** Only a POSIX userland is needed: string commands run via configured `shellPath`, else `/bin/bash`, `which bash`, then `sh -c` (`packages/env/docs/semantics.md:46-47`), so the image should have bash or sh.
  Extra tools the Pi tools shell out to (git, ripgrep, etc.) are image concerns; UNVERIFIED which ones Pi Durable's tools need.
- **Start in stdio mode**: `pi-env serve --token <hex>` (`docs/protocol.md:3`, `daemon/src/main.rs:2`). stdin/stdout carry frames; stderr is diagnostics.
  First stdout line is `PI-ENV <token>\n` (sync marker); the client discards everything before it.
- **Wire protocol** (`packages/env/docs/protocol.md`, version 1). Every frame, both directions, all integers big-endian:
  ```
  u32 length      bytes after this field
  u8  type        1 request, 2 result, 3 error, 4 event, 5 cancel, 6 ping
  u32 id          request id (0 if none)
  u32 jsonLength
  json            UTF-8 object
  bytes           raw payload (remaining length - 9 - jsonLength)
  ```
  Max frame 16 MiB; client splits larger transfers. First request is `hello {protocol:1}`.
  Liveness: both sides send `ping` every 5 s; the daemon kills every process group it started and exits after 30 s without receiving bytes, **when its stdin ends**, or on SIGTERM/SIGINT/SIGHUP (`protocol.md:64`). The client treats 30 s of silence as a lost connection (`src/connection.ts`, `SILENCE_LIMIT_MS`).
  The client parser tolerates arbitrary chunk boundaries (it buffers chunks and peeks the 4-byte length; `Session.peek/consume`).
- **Client-side `Connection` is a concrete class, NOT an interface with a pluggable transport.** `packages/env/src/connection.ts`:
  ```ts
  export interface ConnectionOptions {
    command: readonly string[] | (() => Promise<readonly string[]>);   // argv of a LOCAL program
    onLog?: (text: string) => void;
  }
  export class Connection {
    constructor(options: ConnectionOptions);
    info(signal?: AbortSignal): Promise<RemoteInfo>;
    session(): Promise<number>;
    request(op: string, json: Json, options?: RequestOptions): Promise<Reply>;
    close(): void;
    kill(id: number, session: number): void;
  }
  ```
  It does `spawn(program, [...args, "serve", "--token", token], { stdio: ["pipe","pipe","pipe"] })` with Node `child_process` and uses `child.stdin`/`child.stdout` (private `#` fields; no subclass hook).
  **Consequence for the plan** (derived from source, not tested): a custom `Connection` implementing the same class shape is not possible without forking pi-env, because `RemoteExecutionEnv` types `connection: Connection` (a class with private fields, so structural substitution fails). The viable options are:
  (a) a local bridge executable passed as `command: ["node","bridge.mjs", ...]` that receives the appended `serve --token <hex>` args and pipes its own stdin/stdout to `sandbox.commands.start("/usr/local/bin/pi-env", ["serve","--token",hex])`; or
  (b) upstream an interface/transport option to pi-env. Option (a) works with the stock package. Mark as UNVERIFIED until the spike runs.
  `RemoteExecutionEnv` also uses `Connection` for `RemoteWatcher`, `openProcess`, `openTerminal` via the same `connection.request`.
- **Existing transports**: only the spawned-process transport. SSH = `connectSsh` / `sshConnection` / `sshArguments` (`src/ssh.ts`) which compute an `ssh ...` argv and hand it to `Connection`; local = `localDaemon()` / `new Connection({ command: [localDaemon()] })`; tests use a daemon path over a pipe (`PI_ENV_DAEMON` env var, `test/daemon.ts`). No socket transport and no built-in stdio-over-other-RPC transport found. SSH deploys the daemon by SHA-256 into `~/.pi/mobile/tools/pi-env` (README/ssh.ts; exact path from the `ConnectionOptions` doc comment).
- Env conformance for pi-env itself: `packages/env/test/conformance.test.ts`; builds daemon with `npm run build:daemon` (cargo) or uses prebuilt via `PI_ENV_DAEMON=/path/to/pi-env`. `test/ssh-external.test.ts` runs it over real SSH when `PI_ENV_SSH_HOST` is set.

## 3. kubernetes-sigs/agent-sandbox

### Release and install
- Latest release **v1.0.11** (2026-11-12; GitHub releases API). Assets: `sandbox.yaml`, `extensions.yaml`, `sandbox-with-extensions.yaml`.
  - `sandbox.yaml`: namespace `agent-sandbox-system`, controller Deployment (args `--leader-elect=true`), `sandboxes.agents.x-k8s.io` CRD.
  - `extensions.yaml`: CRDs `sandboxclaims`, `sandboxtemplates`, `sandboxwarmpools` (`*.extensions.agents.x-k8s.io`) plus a controller Deployment (extensions mode).
  - `sandbox-with-extensions.yaml`: everything in one file; controller args `--leader-elect=true --extensions`. Recommended by README (`README.md:107`).
  All CRDs are `v1beta1`, `served: true`, `storage: true`.
  ```sh
  kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.11/sandbox-with-extensions.yaml
  kubectl -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=90s
  ```
- Controller image `registry.k8s.io/agent-sandbox/agent-sandbox-controller:v1.0.11`: index has linux/amd64 and linux/arm64 (queried registry.k8s.io OCI index). Same for `registry.k8s.io/agent-sandbox/sandboxd:v1.0.11` (amd64+arm64). `registry.k8s.io/agent-sandbox/sandbox-router:v1.0.11` returned MANIFEST_UNKNOWN (router image name/tag not verified; only needed for router modes, not `in-cluster-service`).
  Build default platforms are `linux/amd64,linux/arm64` (`dev/tools/push-images`).

### Claim model (important mismatch with plan.md wording)
- In v1beta1 a **SandboxClaim references a SandboxWarmPool, not a SandboxTemplate**: `spec.warmPoolRef` is `required` (CRD in `extensions.yaml` v1.0.11; `extensions/api/v1beta1/sandboxclaim_types.go:110-112`). The SandboxWarmPool references the template via `spec.sandboxTemplateRef.name`. A warm pool can have `replicas: 0` (`Minimum=0`, default 1; `sandboxwarmpool_types.go:41-46`), so cold-start-only is expressible: UNVERIFIED that replicas 0 behaves as a pure template alias in practice.
- The TS SDK's `createSandbox(warmpool, ...)` always builds the claim with `spec: { warmPoolRef: { name: warmpool }, ...extras }` (`sandbox-client.ts:~1407`). So Phase 1 needs three objects: SandboxTemplate, SandboxWarmPool, SandboxClaim.
- `volumeClaimTemplates` on the claim force a cold start; they are validated against template `spec.volumeClaimTemplatesPolicy` (`Disallowed` default / `Allowed` / `Overrides`) (`sandboxtemplate_types.go:68-80`, `sandboxclaim_types.go`). Template-level `spec.volumeClaimTemplates` also exist (`SandboxBlueprint`, `api/v1beta1/sandbox_types.go:312`).
  PVC naming: "named after the template and the Sandbox, joined by a hyphen, owned by the Sandbox ... kept while suspended or retained after expiry; garbage collected when the Sandbox object is deleted" (`sandbox_types.go:296-311`). Sandbox's list is immutable after creation.
- `spec.service: true` is on the blueprint (template `spec.service`, `sandbox_types.go:321`): creates a headless Service; unset keeps an existing one but does not create new ones; status exposes `serviceFQDN`.
- `shutdownAfterSeconds` is an SDK option, not a CRD field: it sets claim `spec.lifecycle.shutdownTime` (absolute RFC3339, computed at call time) and `shutdownPolicy: "Delete"` (`sandbox-client.ts:~188-213`; README "Automatic expiration"). Claim `lifecycle.shutdownPolicy` default is Retain (`examples/warmpool-quickstart/sandbox-claim.yaml`).

### Minimal YAML (adapted from `examples/warmpool-quickstart/` and `examples/sandboxd-sandbox/sandbox-template.yaml` at HEAD 454d335)
```yaml
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxTemplate
metadata: { name: pi-env-template, namespace: default }
spec:
  service: true                       # headless Service, required for in-cluster-service
  volumeClaimTemplatesPolicy: Overrides   # or Allowed, so the claim may add a PVC
  podTemplate:
    spec:
      automountServiceAccountToken: false
      restartPolicy: OnFailure
      # runtimeClassName: gvisor        # present but commented out in upstream examples
      securityContext: { runAsNonRoot: true, fsGroup: 1000 }
      containers:
        - name: sandboxd
          image: <your image FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11 + pi-env>
          securityContext: { runAsUser: 1000, runAsGroup: 1000, allowPrivilegeEscalation: false, capabilities: { drop: [ALL] } }
          ports: [{ containerPort: 8080 }, { containerPort: 9090 }]
          readinessProbe: { httpGet: { path: /v1/health, port: 8080 } }
          volumeMounts: [{ name: workspace, mountPath: /workspace }]
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxWarmPool
metadata: { name: pi-env-pool, namespace: default }
spec:
  replicas: 0
  sandboxTemplateRef: { name: pi-env-template }
---
apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata: { name: session-abc, namespace: default }
spec:
  warmPoolRef: { name: pi-env-pool }
  lifecycle: { shutdownPolicy: Delete, shutdownTime: "2026-12-31T23:59:59Z" }
  volumeClaimTemplates:
    - metadata: { name: workspace }
      spec: { accessModes: [ReadWriteOnce], resources: { requests: { storage: 5Gi } } }
```
Not validated against a cluster; only the field names were checked against the CRD/Go types. The template and claim fields come from the cited upstream files; the pieces I merged (service + PVC policy + warm pool replicas 0) are UNVERIFIED as a working combination.
Upstream default NetworkPolicy: the managed template policy admits only sandbox-router ingress; for in-cluster-service the template must set `spec.networkPolicy.ingress` admitting the orchestrator on TCP 8080 and 9090, which replaces the default policy (`packages/sandboxd/USER_GUIDE.md:~478-481`, `sandboxd-sandbox/sandbox-template.yaml` header).

### sandboxd (the in-pod daemon)
- Go daemon, `packages/sandboxd` (`cmd/sandboxd`, `pkg/server`, `pkg/processmanager`, `spec/process/v1/process.proto`). gRPC ProcessService on 9090, REST files on 8080.
- **How it gets into the pod**: not a sidecar and not injected by the controller. Two documented topologies (`packages/sandboxd/USER_GUIDE.md:~268-300`, `examples/sandboxd-sandbox/deploy/`):
  - **A (default)**: the pod's runtime container IS sandboxd; image `registry.k8s.io/agent-sandbox/sandboxd:<tag>` (debian:bookworm-slim + procps + sandboxd, user 1000, `/workspace`; `packages/sandboxd/Dockerfile`). Commands run in that container's rootfs, so build `FROM` it and add tools (for us: `COPY pi-env`).
  - **B**: initContainer copies the static `sandboxd` binary into an emptyDir; your own image runs it as its command.
  - Docs warn that a separate sidecar container does NOT give commands access to the workload container's binaries. This is why `pi-env` must be in the same image as sandboxd.
  Examples reference `us-central1-docker.pkg.dev/k8s-staging-images/agent-sandbox/sandboxd:latest-main`; for a pin use the registry.k8s.io tag above.
- Auth: sandboxd flags `--auth-token-sha256 <hex of sha256(token)>` or `--auth-token-file`; `/v1/health` stays open. Client side the SDK takes `sandboxd.authToken` (in `SandboxClientOptions`), sent as `Authorization: Bearer` over in-cluster modes, plaintext on the pod network (README "Authentication"). USER_GUIDE recommends passing the digest in the pod args (not the token) and a per-sandbox token. The token never needs to be in the pod spec if the digest is used.
- Other flags: `--root-dir` default `/workspace`, `--stream-chunk-size` default 4096, `--listen-host`, `--grpc-port`, `--rest-port`.
- **cwd semantic**: `commands.start({cwd})` is relative to the sandbox root (`--root-dir`), absolute paths/escape rejected with permission_denied (README "Execution target"). pi-env's own `cwd` option is separate and absolute inside the sandbox (e.g. `/workspace/...`).

### TypeScript client
- Source: `clients/typescript/agentic-sandbox-client/` (package name `agentic-sandbox-client`, version 0.1.0, **`"private": true`**, not on npm: `npm view agentic-sandbox-client` 404). Entry `src/index.ts` exports `SandboxClient`, `Sandbox`, `ProcessHandle`, error classes, option types. Docs page `site/content/docs/typescript-client/_index.md` includes the package README.
- Build: `npm ci && npm run build` in that directory (`build` = `rm -rf dist && tsc`; `prepack` also builds; output `dist/index.js` + `.d.ts`; ES2024/NodeNext). `engines.node >=22`. devDependencies list `typescript ^7.0.2`, `vitest ^5.0.5`, biome. Not built by me: UNVERIFIED that it builds cleanly.
  Runtime deps `@kubernetes/client-node ^2.0.0`, `ws`. **`commands.run/start` need the optional peer deps** `@bufbuild/protobuf`, `@connectrpc/connect`, `@connectrpc/connect-node` (peerDependenciesMeta optional; README/commands.ts say start "requires the same optional dependencies as run()"; there is a `process-missing-dependency` test). OpenTelemetry peers are optional.
- API (`src/sandbox-client.ts`, `src/types.ts`):
  ```ts
  new SandboxClient({ kubeConfig?, namespace?, sandboxReadyTimeout?, sandboxd?: { connectivity?, authToken?, routerNamespace?, ... }, logger?, quiet?, enableTracing? })
  client.createSandbox(warmpool: string, namespace?: string, opts?: CreateSandboxOptions): Promise<Sandbox>
  //   CreateSandboxOptions: sandboxReadyTimeout, labels, shutdownAfterSeconds, podLabels, podAnnotations,
  //                          volumeClaimTemplates, env, claimName, adoptExisting
  client.getSandbox(claimName: string, namespace?: string, opts?: { resolveTimeout?: number; waitForReady?: boolean }): Promise<Sandbox>
  client.getSandboxByName(name, namespace?, opts?)      // core Sandbox without a claim
  client.deleteSandbox(claimName, namespace?) ; deleteAll() ; listAllSandboxes(namespace?, labelSelector?)
  ```
  `getSandbox` returns the cached handle, else re-attaches by claim name (docs: "adoptExisting ... for example when a process restarts"). `createSandbox({claimName, adoptExisting:true})` is the documented create-or-attach path. A named claim is never deleted by a failed create. `sandbox.close()` releases connections only; `deleteSandbox` deletes the claim.
- **`in-cluster-service`**: `new SandboxClient({ sandboxd: { connectivity: "in-cluster-service" } })`; dials `status.serviceFQDN`; requires the orchestrator to run in-cluster and `spec.service: true`; throws `SandboxNoServiceError` otherwise. `port-forward` (the default) does not work on gVisor/Kata (README "Connectivity"). Handle exposes `sandbox.podIP`, `sandbox.serviceFQDN`.
- **`commands.start()`** (`src/commands.ts:~460-490`):
  ```ts
  start(command: string, args?: readonly string[], opts?: StartOptions): Promise<ProcessHandle>;
  start(command: string, opts?: StartOptions): Promise<ProcessHandle>;
  interface StartOptions { env?, cwd?, pty?: {cols,rows}, timeoutMs?, signal?: AbortSignal,
                           onStdout?(chunk: Uint8Array): void, onStderr?(chunk: Uint8Array): void }
  class ProcessHandle { pid; events: AsyncIterable<ProcessEvent>; wait(): Promise<{exitCode}>;
    write(data: string | Uint8Array, opts?): Promise<void>; closeStdin(opts?); signal(sig, opts?); kill(opts?); resize(size, opts?); close(): Promise<void> }
  type ProcessEvent = {type:"stdout",data:Uint8Array} | {type:"stderr",data:Uint8Array} | {type:"exit",exitCode:number}
  ```
  argv, no shell. Lifetime: **the process is tied to its gRPC stream; closing the handle, aborting the signal, `sandbox.close()` or a lost connection makes sandboxd SIGKILL the whole process group; no detach, no reattach** (README "Interactive processes"; `process.go` `killProcessGroupOnContextDone`). This matches plan.md's "interrupted commands" decision, and means an orchestrator crash also kills pi-env and all its children (consistent with the daemon's own stdin-EOF behaviour).
  `timeoutMs` only bounds time-to-started (default 60000). `write()` is not given a per-process timeout beyond `ProcessCallOptions.timeoutMs` (default 60000 per call).

### Existing Pi example
- `examples/pi-code-agent/` (`Dockerfile`, `sandbox.yaml`, `README.md`, `run-test-kind.sh`; docs mirror `site/content/docs/use-cases/examples/pi-code-agent/_index.md`). It runs the **interactive Pi coding-agent TUI inside a Sandbox** (`node:24-bookworm-slim`, `npm i -g @earendil-works/pi-coding-agent@0.84.1`, `kubectl attach -it`, plain `Sandbox` CRD, two PVCs, API key via Secret). It does NOT use sandboxd, pi-env, SandboxClaim, Pi Durable or an outside orchestrator, so it is "Pi inside" rather than "orchestrator outside, tools inside". Good place to put the Phase 5 example next to it.

## 4. Open question: is `commands.start()` stdio suitable for a framed binary protocol?

Evidence from source (HEAD 454d335). Conclusion: **plausible, no source-level blocker found, but not tested; several caveats the bridge must handle. Everything below about suitability is inference; empirical status is UNVERIFIED.**

Binary-safe, no text transcoding:
- Proto: `StartResponse{ oneof event { InitEvent init=1; bytes stdout=2; bytes stderr=3; ExitEvent exit=4 } }`, `WriteStdinRequest{ int32 process_id=1; oneof payload { bytes input=2; Empty eof=3 } }` (`packages/sandboxd/spec/process/v1/process.proto`). Protobuf `bytes`, not strings.
- Server (`pkg/server/process.go`, `Start`): without `pty`, stdout and stderr are separate `os.Pipe()`s and stdin is a pipe; so no tty line discipline/echo/CRLF mangling. With `pty` set output is merged and stdin is a terminal: do NOT use pty. Each `Read` into a `streamChunkSize` buffer (default **4096 bytes**, flag `--stream-chunk-size`) is immediately copied and `stream.Send`'d (no batching, no base64); stdout and stderr readers run in separate goroutines under a send mutex, so stdout/stderr interleave relative to each other but each stream stays ordered. Exit event is sent after readers drain (with a grace timeout `waitForReaders`).
- Client (`src/commands.ts` ProcessHandle): output delivered as `Uint8Array` ("raw bytes since a multi-byte character can straddle two chunks"); README: "Nothing is buffered on the SDK side: until [a consumer] is in use the stream is not read, and the process blocks once its pipe fills" (natural backpressure; callers must attach `onStdout` immediately; the callback path starts `pump()` in the constructor).
  pi-env's parser handles frames split at arbitrary chunk boundaries (4 KiB chunks reassemble fine; `connection.ts` `#onData`).

Caveats / risks:
1. **stdin goes through unary `WriteStdin` RPCs, one per chunk** (`process.go:649-676`; `STDIN_CHUNK_BYTES = 1 MiB` in `src/constants.ts:62`; "large payloads are sent in sequential chunks"). Ordering is guaranteed only if the bridge awaits each `write()` before issuing the next. pi-env's `Connection` does `child.stdin.write` synchronously for each frame, so the bridge must queue and serialize writes (single promise chain). Concurrent un-awaited `write()` calls on HTTP/2 could reorder: UNVERIFIED but a real hazard.
   Latency is one RPC round trip per write; per-frame cost matters for chatty small frames (pings, many small file ops). Not measured.
2. A failed `write()` leaves "an unknown prefix already delivered" (`ProcessHandle.write` doc), which corrupts a frame stream. The bridge must treat any write error as a fatal connection loss, tear down, and let `Connection` restart (it already restarts lazily and fails in-flight requests with `lost: true`).
3. `write()` default timeout 60 s per call (shared across chunks of one write); a full stdin pipe blocks the RPC server-side (`proc.Stdin.Write` is blocking inside the handler).
4. Frames up to 16 MiB (pi-env) vs gRPC default 4 MiB message limit: SDK chunks stdin at 1 MiB so inbound is fine; outbound stdout chunks are 4 KiB so fine. The `maxCommandOutputSize`/`readMaxBytes` limit applies to `run()` (`process.ts:300`), not to `start()` streams as far as I could see; UNVERIFIED.
5. Process exit: closing stdin (`closeStdin()` => `eof` payload) lets pi-env exit; killing the handle SIGKILLs the process group, so pi-env cannot clean up its children itself; the sandboxd group kill covers pi-env's process group but pi-env puts commands in their own process groups (`exec` "its own process group", protocol.md); whether `SIGKILL` of pi-env's group also reaps those child groups is UNVERIFIED and matters for the Phase 3 "process is dead in the sandbox" test. pi-env only kills child groups on its own exit paths (stdin end/SIGTERM/30 s silence), and the SDK offers `signal("SIGTERM")`/`closeStdin()` for a graceful stop: prefer `closeStdin()` then `wait()` on shutdown.
6. Keepalive: pi-env pings every 5 s and gives up after 30 s silence; the long-lived gRPC server stream across `in-cluster-service` DNS should satisfy that unless an intermediary idles it: UNVERIFIED (`--http-idle-timeout` 60 s applies to HTTP/REST idle connections).
7. No test in the upstream SDK/e2e suite feeds random binary through `start()`; the stdin tests use `cat` and `sh` with text (`test/e2e/clients/typescript/test-e2e-typescript-sdk.test.ts:746-770`). The multi-megabyte random-bytes tests use the REST file API, not `start()`. So binary cleanliness of this path is only argued from the code, not demonstrated.
8. The SDK states `signal` errors only occur after process exit with codes like `internal`; handle `not_found`/`internal` after exit when closing.

Suggested first experiment (cheap, decisive): in a sandbox started with `sandboxd`, `start("cat")`, write 64 MiB of random bytes in 1 MiB chunks and a concurrent reader, compare SHA-256; then `start("/usr/local/bin/pi-env", ["serve","--token",T])` through a local bridge executable and run `registerEnvConformance`.

## Blockers / flags for Phase 1
- `Connection` has no transport abstraction: the plan's "custom `Connection`" needs either a local bridge executable used as `ConnectionOptions.command`, or an upstream change to pi-env. (Plan text in sections 3-4 should say this.)
- Claims reference a SandboxWarmPool; plan.md's "SandboxTemplate + named SandboxClaim" needs a (possibly zero-replica) SandboxWarmPool in between. The SDK's `createSandbox` takes the warm pool name.
- TS SDK is private/unpublished: vendor from `clients/typescript/agentic-sandbox-client` at `v1.0.11` (commit `890de53a...`) or a later pin; needs optional connect-es peer deps for `commands.start`.
- pi-env must live in the same image/container as sandboxd (topology A: `FROM registry.k8s.io/agent-sandbox/sandboxd:v1.0.11`; or B). The sandboxd runtime image is debian-slim with shell and coreutils, so bash/sh exists for string commands (UNVERIFIED that `bash` is present; sh is).
- gVisor `runtimeClassName` is only a commented-out hint in upstream examples; nothing upstream confirms the in-cluster-service + gVisor path beyond README statements. NetworkPolicy must admit the orchestrator on 8080 and 9090.
- Not resolved: pi-env child-process group cleanup when sandboxd SIGKILLs pi-env (see caveat 5).
