import { createHash, randomBytes } from "node:crypto";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_QUEUED_OUTPUT_BYTES, runBridge } from "../src/bridge.ts";
import type { RemoteProcess } from "../src/bridge.ts";
import { localStart } from "./local-start.ts";

function collect(stream: PassThrough): () => Buffer {
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks);
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function chunked(data: Buffer, size: number): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += size) parts.push(data.subarray(i, i + size));
  return Readable.from(parts, { objectMode: false });
}

describe("runBridge", () => {
  it("round-trips 8 MiB of random bytes through cat unchanged", async () => {
    const payload = randomBytes(8 * 1024 * 1024);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = collect(stdout);
    const code = await runBridge({
      start: localStart(),
      command: "cat",
      args: [],
      // Odd chunk size so frames never align with the 4 KiB / 1 MiB boundaries of the real path.
      stdin: chunked(payload, 60_001),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const received = out();
    expect(received.length).toBe(payload.length);
    expect(sha256(received)).toBe(sha256(payload));
  }, 30_000);

  it("keeps remote stderr off stdout", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const out = collect(stdout);
    const err = collect(stderr);
    const code = await runBridge({
      start: localStart({ command: "sh", args: ["-c", "echo out; echo err >&2"] }),
      command: "ignored",
      args: [],
      stdin: Readable.from([]),
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(out().toString()).toBe("out\n");
    expect(err().toString()).toBe("bridge: ready\nerr\n");
  }, 15_000);

  it("exits non-zero and kills the remote process when a stdin write fails", async () => {
    let closed = false;
    const stderr = new PassThrough();
    const err = collect(stderr);
    const code = await runBridge({
      start: localStart({
        command: "cat",
        args: [],
        write: async (_data, real, call) => {
          if (call === 2) throw new Error("rpc unavailable");
          await real();
        },
        onClose: () => {
          closed = true;
        },
      }),
      command: "cat",
      args: [],
      stdin: chunked(randomBytes(1024 * 1024), 4096),
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).not.toBe(0);
    expect(closed).toBe(true);
    expect(err().toString()).toContain("rpc unavailable");
  }, 15_000);

  it("never has two stdin writes in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const stdout = new PassThrough();
    collect(stdout);
    const code = await runBridge({
      start: localStart({
        command: "cat",
        args: [],
        write: async (_data, real) => {
          maxInFlight = Math.max(maxInFlight, ++inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          await real();
          inFlight--;
        },
      }),
      command: "cat",
      args: [],
      stdin: chunked(randomBytes(64 * 1024), 1024),
      stdout,
      stderr: new PassThrough(),
    });
    expect(code).toBe(0);
    expect(maxInFlight).toBe(1);
  }, 15_000);

  it("propagates the remote exit code after stdin ends", async () => {
    const code = await runBridge({
      start: localStart({ command: "sh", args: ["-c", "cat >/dev/null; exit 7"] }),
      command: "ignored",
      args: [],
      stdin: Readable.from([Buffer.from("x")]),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(code).toBe(7);
  }, 15_000);

  it("propagates the remote exit code while stdin is still open", async () => {
    const code = await runBridge({
      start: localStart({ command: "sh", args: ["-c", "exit 3"] }),
      command: "ignored",
      args: [],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(code).toBe(3);
  }, 15_000);

  it("maps a signal death to a non-zero code", async () => {
    const code = await runBridge({
      start: localStart({ command: "sh", args: ["-c", "kill -9 $$"] }),
      command: "ignored",
      args: [],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    expect(code).toBe(1);
  }, 15_000);

  it("holds the remote process back while stdout is not read, instead of queuing its output", async () => {
    // A reader that never reads: everything the bridge does not hold back piles up in its write queue.
    const stdout = new Writable({ highWaterMark: 64 * 1024, write: () => undefined });
    const stop = new AbortController();
    const done = runBridge({
      start: localStart({ command: "sh", args: ["-c", "exec yes 0123456789abcdef"] }),
      command: "ignored",
      args: [],
      stdin: new PassThrough(),
      stdout,
      stderr: new PassThrough(),
      signal: stop.signal,
    });
    // `yes` writes GiB per second when nothing holds it back.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const queued = stdout.writableLength;
    stop.abort();
    expect(await done).toBe(1);
    expect(queued).toBeGreaterThan(0);
    expect(queued).toBeLessThan(1024 * 1024);
  }, 15_000);

  it("fails when a start that ignores back-pressure queues more than the cap", async () => {
    const stdout = new Writable({ highWaterMark: 64 * 1024, write: () => undefined });
    const stderr = new PassThrough();
    const err = collect(stderr);
    let closed = false;
    const code = await runBridge({
      start: (_command, _args, handlers) => {
        const chunk = new Uint8Array(1024 * 1024);
        const flood = setInterval(() => {
          for (let i = 0; i < 8; i++) void handlers.onStdout(chunk);
        }, 1);
        const proc: RemoteProcess = {
          write: () => Promise.resolve(),
          closeStdin: () => Promise.resolve(),
          wait: () => new Promise(() => undefined),
          close: () => {
            closed = true;
            clearInterval(flood);
            return Promise.resolve();
          },
        };
        return Promise.resolve(proc);
      },
      command: "ignored",
      args: [],
      stdin: new PassThrough(),
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(closed).toBe(true);
    expect(err().toString()).toContain("stdout reader too slow");
    // Bounded: the cap plus what one burst adds after it.
    expect(stdout.writableLength).toBeLessThan(MAX_QUEUED_OUTPUT_BYTES + 16 * 1024 * 1024);
  }, 15_000);

  it("gives up on a start that never resolves after the start timeout", async () => {
    const stderr = new PassThrough();
    const err = collect(stderr);
    const code = await runBridge({
      start: () => new Promise(() => undefined),
      command: "pi-env",
      args: ["serve"],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      startTimeoutMs: 100,
    });
    expect(code).toBe(1);
    expect(err().toString()).toContain("timed out after 100 ms");
  }, 15_000);

  it("gives up on a start that never resolves when the connection is aborted", async () => {
    const stderr = new PassThrough();
    const err = collect(stderr);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const code = await runBridge({
      start: () => new Promise(() => undefined),
      command: "pi-env",
      args: ["serve"],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
      signal: stop.signal,
    });
    expect(code).toBe(1);
    expect(err().toString()).toContain("connection closed");
  }, 15_000);

  it("closes a handle that a start delivers after the bridge gave up", async () => {
    let closeLate: () => void = () => undefined;
    const closedLate = new Promise<void>((resolve) => (closeLate = resolve));
    const code = await runBridge({
      start: () =>
        new Promise<RemoteProcess>((resolve) =>
          setTimeout(
            () =>
              resolve({
                write: () => Promise.resolve(),
                closeStdin: () => Promise.resolve(),
                wait: () => new Promise(() => undefined),
                close: () => {
                  closeLate();
                  return Promise.resolve();
                },
              }),
            200,
          ),
        ),
      command: "pi-env",
      args: ["serve"],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      startTimeoutMs: 20,
    });
    expect(code).toBe(1);
    await closedLate;
  }, 15_000);

  it("exits non-zero when the process cannot be started", async () => {
    const stderr = new PassThrough();
    const err = collect(stderr);
    const code = await runBridge({
      start: () => Promise.reject(new Error("claim not found")),
      command: "pi-env",
      args: ["serve"],
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr,
    });
    expect(code).toBe(1);
    expect(err().toString()).toContain("claim not found");
  }, 15_000);
});
