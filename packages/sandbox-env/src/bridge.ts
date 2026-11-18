import type { Readable, Writable } from "node:stream";

/** A process started inside a sandbox. Implemented by sandbox-client.ts and by test fakes. */
export interface RemoteProcess {
  /** Resolves when the bytes are delivered. A rejection leaves an unknown prefix delivered. */
  write(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  /** Tears the stream down; sandboxd kills the process group. Idempotent. */
  close(): Promise<void>;
}

/**
 * Receive the remote output. The returned promise settles once the chunk is handed on and the next may follow: a start
 * that awaits it before reading more passes the reader's back-pressure on to sandboxd.
 */
export interface OutputHandlers {
  onStdout(chunk: Uint8Array): Promise<void>;
  onStderr(chunk: Uint8Array): Promise<void>;
}

export type StartProcess = (
  command: string,
  args: readonly string[],
  handlers: OutputHandlers,
) => Promise<RemoteProcess>;

/** Written to the bridge's stderr once the remote process is running. */
export const BRIDGE_READY = "bridge: ready";

export interface BridgeOptions {
  start: StartProcess;
  command: string;
  args: readonly string[];
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** Ends the bridge as a fatal loss (the in-process broker uses it when the relay's socket is gone). */
  signal?: AbortSignal;
  /** How long `start` may take; a handle that comes later is closed. Default {@link START_TIMEOUT_MS}. */
  startTimeoutMs?: number;
}

/** pi-env gives a spawned relay 30 s to speak before it kills it, so a slower start is lost anyway. */
export const START_TIMEOUT_MS = 30_000;

/**
 * Output queued in one of our streams, past which the bridge fails. The broker runs in the shared orchestrator, so a
 * sandbox that writes faster than its relay reads must not grow memory without bound. A start that awaits the output
 * handlers never gets near it; the cap is for one that does not.
 */
export const MAX_QUEUED_OUTPUT_BYTES = 16 * 1024 * 1024;

type Outcome =
  { kind: "exit"; exitCode: number } | { kind: "stdin-done" } | { kind: "fatal"; reason: string };

/** Remote codes outside 1..255 (signal deaths, negatives) must still read as failure. */
function toExitCode(exitCode: number): number {
  if (exitCode === 0) return 0;
  return Number.isInteger(exitCode) && exitCode > 0 && exitCode <= 255 ? exitCode : 1;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function flush(stream: Writable): Promise<void> {
  return new Promise((resolve) => stream.write(new Uint8Array(0), () => resolve()));
}

/** Settles on `drain`, or when the stream can never drain, so a waiting producer is not stuck. */
function drained(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };
    stream.on("drain", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * Pipes stdin to the remote process and its stdout to ours, byte for byte, and returns the exit code
 * the bridge should exit with. Stdin writes are awaited one at a time: the SDK sends each as its own
 * RPC, and concurrent RPCs could reorder bytes inside a pi-env frame. Any write failure or stream
 * loss is fatal because a half-delivered frame cannot be repaired; pi-env's Connection restarts us.
 */
export async function runBridge(options: BridgeOptions): Promise<number> {
  const { stdin, stdout, stderr } = options;
  let ended = false;
  let overflow!: (outcome: Outcome) => void;
  const overflowed = new Promise<Outcome>((resolve) => {
    overflow = resolve;
  });
  // One wait per stream, shared by every chunk behind it: a start that does not await must not pile up listeners.
  const waits = new Map<Writable, Promise<void>>();
  const forward = (stream: Writable, name: string, chunk: Uint8Array): Promise<void> => {
    // Output that arrives once the bridge is over (a late start, the stream's tail) has no reader.
    if (ended) return Promise.resolve();
    if (stream.write(chunk)) return Promise.resolve();
    if (stream.writableLength > MAX_QUEUED_OUTPUT_BYTES) {
      overflow({
        kind: "fatal",
        reason: `${name} reader too slow: over ${String(MAX_QUEUED_OUTPUT_BYTES)} bytes queued`,
      });
    }
    let wait = waits.get(stream);
    if (wait === undefined) {
      wait = drained(stream).finally(() => waits.delete(stream));
      waits.set(stream, wait);
    }
    return wait;
  };
  const aborted = new Promise<Outcome>((resolve) => {
    const abort = (): void => resolve({ kind: "fatal", reason: "connection closed" });
    if (options.signal?.aborted === true) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
  });

  // The broker serves an env's connections one after another, so a start that hangs (the Sandbox not Ready, sandboxd
  // unreachable) must not hold the next connection: race it against the abort and a timeout.
  const starting = (async () =>
    options.start(options.command, options.args, {
      onStdout: (chunk) => forward(stdout, "stdout", chunk),
      onStderr: (chunk) => forward(stderr, "stderr", chunk),
    }))();
  const timeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
  const timeout = delay(timeoutMs);
  const started = await Promise.race([
    starting.then(
      (proc) => ({ proc }),
      (error: unknown) => ({ reason: describe(error) }),
    ),
    timeout.promise.then(() => ({ reason: `timed out after ${String(timeoutMs)} ms` })),
    aborted.then(() => ({ reason: "connection closed" })),
  ]);
  timeout.cancel();
  if (!("proc" in started)) {
    ended = true;
    // A handle that comes after we gave up still holds a remote process and an SDK connection.
    starting.then((proc) => proc.close()).catch(() => undefined);
    stderr.write(`bridge: cannot start ${options.command}: ${started.reason}\n`);
    return 1;
  }
  const proc = started.proc;
  // Tells the parent that the cold start (the CPU-heavy part) is over; see StartGate.
  stderr.write(`${BRIDGE_READY}\n`);

  const exited = proc.wait().then(
    (result): Outcome => ({ kind: "exit", exitCode: toExitCode(result.exitCode) }),
    (error: unknown): Outcome => ({
      kind: "fatal",
      reason: `remote stream lost: ${describe(error)}`,
    }),
  );
  const outputFailed = new Promise<Outcome>((resolve) =>
    stdout.once("error", (error) =>
      resolve({ kind: "fatal", reason: `stdout write failed: ${describe(error)}` }),
    ),
  );
  const pumped = (async (): Promise<Outcome> => {
    try {
      for await (const chunk of stdin) {
        await proc.write(chunk as Uint8Array);
      }
      await proc.closeStdin();
      return { kind: "stdin-done" };
    } catch (error) {
      return { kind: "fatal", reason: `stdin write failed: ${describe(error)}` };
    }
  })();

  let outcome = await Promise.race([exited, pumped, outputFailed, overflowed, aborted]);
  if (outcome.kind === "stdin-done") {
    // Stdin ended cleanly: pi-env exits on EOF, so wait for it.
    outcome = await Promise.race([exited, outputFailed, overflowed, aborted]);
  }
  try {
    if (outcome.kind === "fatal") {
      stderr.write(`bridge: ${outcome.reason}\n`);
      return 1;
    }
    if (outcome.kind === "exit") await flush(stdout);
    return outcome.kind === "exit" ? outcome.exitCode : 1;
  } finally {
    ended = true;
    await proc.close().catch(() => undefined);
  }
}
