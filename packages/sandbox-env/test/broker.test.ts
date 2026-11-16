import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { localDaemon } from "@earendil-works/pi-env";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteProcess, StartProcess } from "../src/bridge.ts";
import { startBroker } from "../src/broker.ts";
import { connectSandboxEnv } from "../src/index.ts";
import type { SandboxEnv } from "../src/index.ts";
import { localStart } from "./local-start.ts";

const relay = [process.execPath, resolve(import.meta.dirname, "../src/relay.ts")];
const open: SandboxEnv[] = [];

function env(
  claimName: string,
  startProcess: StartProcess = localStart(),
  authToken?: string,
): SandboxEnv {
  const made = connectSandboxEnv({
    claimName,
    namespace: "test",
    cwd: "/tmp",
    id: `pi-env:${claimName}`,
    relayCommand: relay,
    startProcess,
    envBinary: localDaemon(),
    ...(authToken === undefined ? {} : { authToken }),
  });
  open.push(made);
  return made;
}

interface Ran {
  ok: boolean;
  code: string | undefined;
  stdout: string;
}

async function run(sandbox: SandboxEnv, command: string, signal?: AbortSignal): Promise<Ran> {
  let stdout = "";
  const context =
    signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT);
  const result = await sandbox.env.exec(
    ["sh", "-c", command],
    {
      onOutput: (text, _context, info) => {
        if (info.stream === "stdout") stdout += text;
      },
    },
    context,
  );
  return { ok: result.ok, code: result.ok ? undefined : result.error.code, stdout };
}

afterEach(() => {
  for (const made of open.splice(0)) made.close();
});

describe("broker socket", () => {
  it("lives in a 0700 directory that close() removes", () => {
    const broker = startBroker({ start: localStart(), command: "unused" });
    expect(statSync(broker.dir).mode & 0o777).toBe(0o700);
    broker.close();
    expect(existsSync(broker.dir)).toBe(false);
    broker.close(); // idempotent
  });

  it("is removed when the env closes", async () => {
    const sandbox = env("pi-conv-dir");
    expect((await run(sandbox, "echo hi")).ok).toBe(true);
    expect(statSync(sandbox.brokerDir).mode & 0o777).toBe(0o700);
    sandbox.close();
    expect(existsSync(sandbox.brokerDir)).toBe(false);
  });

  it("closes a connection with a wrong nonce and never calls start", async () => {
    let started = 0;
    const broker = startBroker({
      start: () => {
        started++;
        return Promise.reject(new Error("must not start"));
      },
      command: "unused",
    });
    try {
      await broker.ready;
      broker.issueNonce();
      for (const role of ["log", "data"]) {
        const socket = connect({ path: broker.socketPath });
        const chunks: Buffer[] = [];
        socket.on("data", (chunk: Buffer) => chunks.push(chunk));
        socket.on("error", () => undefined);
        socket.write(
          `${JSON.stringify({ nonce: "wrong", role, args: ["serve", "--token", "x"] })}\n`,
        );
        await new Promise<void>((done) => socket.once("close", () => done()));
        expect(Buffer.concat(chunks).toString()).toBe("");
      }
      expect(started).toBe(0);
    } finally {
      broker.close();
    }
  });

  it("accepts a nonce once", async () => {
    const broker = startBroker({ start: localStart(), command: "sh" });
    try {
      await broker.ready;
      const nonce = broker.issueNonce();
      const header = (role: string) => `${JSON.stringify({ nonce, role, args: ["-c", "true"] })}\n`;
      // `serve` is required as the first argument; the broker refuses anything else even with a good nonce.
      const log = connect({ path: broker.socketPath });
      log.on("error", () => undefined);
      log.write(header("log"));
      await new Promise<void>((done) => log.once("data", () => done()));
      const data = connect({ path: broker.socketPath });
      data.on("error", () => undefined);
      data.write(header("data"));
      await new Promise<void>((done) => data.once("close", () => done()));
    } finally {
      broker.close();
    }
  });
});

describe("relay", () => {
  it("has no token in its argv or environment", async () => {
    const sandbox = env("pi-conv-token", localStart(), "SECRET-SANDBOXD-TOKEN");
    expect((await run(sandbox, "echo hi")).ok).toBe(true);
    const pids = execFileSync("pgrep", ["-f", "relay.ts.*pi-conv-token"], { encoding: "utf8" })
      .split("\n")
      .filter((pid) => pid !== "");
    expect(pids.length).toBeGreaterThan(0);
    for (const pid of pids) {
      const argv = execFileSync("ps", ["-ww", "-o", "command=", "-p", pid], { encoding: "utf8" });
      expect(argv).toContain("--claim pi-conv-token");
      expect(argv).not.toContain("SECRET-SANDBOXD-TOKEN");
      const environ = `/proc/${pid}/environ`;
      if (existsSync(environ)) expect(readFileSync(environ, "utf8")).not.toContain("SECRET");
    }
  });
});

describe("two envs in one process", () => {
  it("aborting an exec on one leaves the other completing", async () => {
    const a = env("pi-conv-a");
    const b = env("pi-conv-b");
    expect((await run(a, "echo warm")).ok).toBe(true);
    expect((await run(b, "echo warm")).ok).toBe(true);
    const abort = new AbortController();
    const slowA = run(a, "sleep 30", abort.signal);
    const slowB = run(b, "sleep 1; echo b-done");
    setTimeout(() => abort.abort(), 300);
    expect((await slowA).code).toBe("aborted");
    const doneB = await slowB;
    expect(doneB.stdout).toContain("b-done");
    // A is still usable afterwards (the abort kills the command, not the connection).
    expect((await run(a, "echo again")).ok).toBe(true);
  }, 30_000);

  it("a start that throws on A leaves B unaffected, and A respawns", async () => {
    let attempts = 0;
    const flaky: StartProcess = (command, args, handlers) => {
      if (++attempts === 1) return Promise.reject(new Error("sandbox unreachable"));
      return localStart()(command, args, handlers);
    };
    const a = env("pi-conv-throw-a", flaky);
    const b = env("pi-conv-throw-b");
    expect((await run(b, "echo b1")).ok).toBe(true);
    expect((await run(a, "echo a1")).ok).toBe(false);
    expect((await run(b, "echo b2")).ok).toBe(true);
    const retried = await run(a, "echo a2");
    expect(retried.stdout).toContain("a2");
    expect(attempts).toBe(2);
  }, 30_000);

  it("a lost stream on A leaves B unaffected, and A respawns", async () => {
    const lose: Array<(reason: Error) => void> = [];
    const losing: StartProcess = async (command, args, handlers) => {
      const real = await localStart()(command, args, handlers);
      const lost = new Promise<{ exitCode: number }>((_resolve, reject) => lose.push(reject));
      const proc: RemoteProcess = { ...real, wait: () => Promise.race([real.wait(), lost]) };
      return proc;
    };
    const a = env("pi-conv-lost-a", losing);
    const b = env("pi-conv-lost-b");
    expect((await run(a, "echo a1")).ok).toBe(true);
    expect((await run(b, "echo b1")).ok).toBe(true);
    const slowB = run(b, "sleep 1; echo b-done");
    lose[0]?.(new Error("stream reset"));
    const doneB = await slowB;
    expect(doneB.stdout).toContain("b-done");
    // Connection notices the relay exit and respawns it on the next call; give the loss a moment to land.
    let retried = await run(a, "echo a2");
    for (let i = 0; i < 5 && !retried.ok; i++) retried = await run(a, "echo a2");
    expect(retried.stdout).toContain("a2");
    expect(lose.length).toBeGreaterThanOrEqual(2);
  }, 45_000);
});
