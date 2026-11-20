import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kube = vi.hoisted(() => ({
  deleteClaimAndPvc: vi.fn(),
  ensureLabeledClaim: vi.fn(),
  listSandboxes: vi.fn(),
  recyclePod: vi.fn(),
  resumeIfSuspended: vi.fn(),
  suspendSandbox: vi.fn(),
}));
const sandboxEnv = vi.hoisted(() => ({
  connectSandboxEnv: vi.fn(),
  ensureClaim: vi.fn(),
}));
vi.mock("../src/kube.ts", () => kube);
vi.mock("@cela/sandbox-env", () => ({
  ENV: { masterKey: "PI_SANDBOX_MASTER_KEY" },
  SANDBOXD_TOKEN_SHA256_ENV: "SANDBOXD_AUTH_TOKEN_SHA256",
  deriveSandboxToken: () => "token",
  sandboxTokenSha256: () => "hash",
  ...sandboxEnv,
}));

import { loadConfig } from "../src/config.ts";
import { Sandboxes } from "../src/sandboxes.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});

/** What the fake env did, in order: `prepare`, then each operation. */
let log: string[];
let closed: number;

beforeEach(() => {
  log = [];
  closed = 0;
  process.env.PI_SANDBOX_MASTER_KEY = "master";
  for (const fn of [...Object.values(kube), ...Object.values(sandboxEnv)]) fn.mockReset();
  kube.ensureLabeledClaim.mockResolvedValue(undefined);
  kube.resumeIfSuspended.mockResolvedValue(false);
  kube.recyclePod.mockResolvedValue(true);
  kube.listSandboxes.mockResolvedValue([]);
  sandboxEnv.ensureClaim.mockResolvedValue(undefined);
  sandboxEnv.connectSandboxEnv.mockImplementation(() => ({
    env: {
      id: "real-env",
      readFile: () => {
        log.push("readFile");
        return Promise.resolve({ ok: true, value: "x" });
      },
      exec: () => {
        log.push("exec");
        return Promise.resolve({ ok: true, value: { exitCode: 0 } });
      },
    },
    close: () => {
      closed += 1;
    },
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const make = (prepareEnv: (id: number, env: unknown) => Promise<void>) =>
  new Sandboxes(config, () => Promise.resolve("session-key"), { prepareEnv });
const call = (sandboxes: Sandboxes, method: "readFile" | "exec", id = 5): Promise<unknown> =>
  (sandboxes.lazyEnv(id) as unknown as Record<string, () => Promise<unknown>>)[method]?.() ??
  Promise.reject(new Error("no such method"));

describe("the env's prepare hook (skills are written before the first operation)", () => {
  it("runs once, before the first operation, for concurrent first tool calls, which all wait for it", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sandboxes = make(async () => {
      log.push("prepare-start");
      await gate;
      log.push("prepare-done");
    });
    const calls = [
      call(sandboxes, "readFile"),
      call(sandboxes, "exec"),
      call(sandboxes, "readFile"),
    ];
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing ran on the env while the bundle was being written.
    expect(log).toEqual(["prepare-start"]);
    release();
    await Promise.all(calls);
    expect(log.slice(0, 2)).toEqual(["prepare-start", "prepare-done"]);
    expect(log.filter((entry) => entry === "prepare-start")).toHaveLength(1);
    expect(log.slice(2).sort()).toEqual(["exec", "readFile", "readFile"]);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(1);
    sandboxes.stop();
  });

  it("runs again on every new env: after an interrupted command recycles the Pod, the files are written again", async () => {
    const prepared: number[] = [];
    const sandboxes = make((id) => {
      prepared.push(id);
      return Promise.resolve();
    });
    sandboxEnv.connectSandboxEnv.mockImplementationOnce(() => ({
      env: { exec: () => Promise.resolve({ ok: false, error: { code: "aborted" } }) },
      close: () => {
        closed += 1;
      },
    }));
    await call(sandboxes, "exec");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(kube.recyclePod).toHaveBeenCalledTimes(1);
    expect(prepared).toEqual([5]);
    await call(sandboxes, "readFile");
    expect(prepared).toEqual([5, 5]);
    sandboxes.stop();
  });

  it("a failing prepare closes the env, fails the call, is not cached and is tried again by the next call", async () => {
    let attempts = 0;
    const sandboxes = make(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error("skill bundle is corrupt"))
        : Promise.resolve();
    });
    await expect(call(sandboxes, "readFile")).rejects.toThrow("skill bundle is corrupt");
    expect(closed).toBe(1);
    expect(log).toEqual([]);
    await call(sandboxes, "readFile");
    expect(attempts).toBe(2);
    expect(log).toEqual(["readFile"]);
    sandboxes.stop();
  });

  it("a chat-only session opens no sandbox and runs no hook: ending a run without a tool call touches nothing", async () => {
    const prepared: number[] = [];
    const sandboxes = make((id) => {
      prepared.push(id);
      return Promise.resolve();
    });
    sandboxes.lazyEnv(5);
    await (sandboxes.lazyEnv(5) as unknown as { cleanup: () => Promise<void> }).cleanup();
    expect(prepared).toEqual([]);
    expect(kube.ensureLabeledClaim).not.toHaveBeenCalled();
    expect(sandboxEnv.connectSandboxEnv).not.toHaveBeenCalled();
    sandboxes.stop();
  });
});

describe("isOpen (repo skills rescan only while the sandbox is open)", () => {
  it("is false until a call opens the env, true after, false again once it is closed, and asking opens nothing", async () => {
    const sandboxes = make(() => Promise.resolve());
    expect(sandboxes.isOpen(5)).toBe(false);
    sandboxes.lazyEnv(5);
    expect(sandboxes.isOpen(5)).toBe(false);
    expect(sandboxEnv.connectSandboxEnv).not.toHaveBeenCalled();
    await call(sandboxes, "readFile");
    expect(sandboxes.isOpen(5)).toBe(true);
    expect(sandboxes.isOpen(6)).toBe(false);
    await sandboxes.closeAll();
    expect(sandboxes.isOpen(5)).toBe(false);
    sandboxes.stop();
  });
});

describe("the claim's warm pool (sandbox sizes, docs/decisions/0030-sandbox-sizes.md)", () => {
  it("references the pool the warmPoolOf hook names for the session's size", async () => {
    const sandboxes = new Sandboxes(config, () => Promise.resolve("session-key"), {
      warmPoolOf: (id) => Promise.resolve(id === 5 ? "test-pool-l" : undefined),
    });
    await call(sandboxes, "readFile", 5);
    await call(sandboxes, "readFile", 6);
    expect(kube.ensureLabeledClaim.mock.calls.map((args) => args[2] as unknown)).toEqual([
      "test-pool-l",
      "test-pool",
    ]);
    expect(
      sandboxEnv.ensureClaim.mock.calls.map((args) => (args[0] as { warmPool: string }).warmPool),
    ).toEqual(["test-pool-l", "test-pool"]);
  });

  it("uses the configured unsized pool without the hook", async () => {
    await call(
      make(() => Promise.resolve()),
      "readFile",
      7,
    );
    expect(kube.ensureLabeledClaim.mock.calls[0]?.[2]).toBe("test-pool");
  });
});
