import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events: string[] = [];
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
vi.mock("@pi-durable-k8s/sandbox-env", () => ({
  ENV: { masterKey: "PI_SANDBOX_MASTER_KEY" },
  SANDBOXD_TOKEN_SHA256_ENV: "SANDBOXD_AUTH_TOKEN_SHA256",
  deriveSandboxToken: () => "token",
  sandboxTokenSha256: () => "hash",
  ...sandboxEnv,
}));

import { loadConfig } from "../src/config.ts";
import { Sandboxes } from "../src/sandboxes.ts";

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
    PI_API_TOKENS: "alice:0123456789abcdef0123",
    ...extra,
  });

/** Lets the settle/replace promises run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

let execResults: unknown[];
let closed: number;
let ledger: { calls: string[]; fn: (id: number, on: boolean) => Promise<void> };

beforeEach(() => {
  events.length = 0;
  execResults = [];
  closed = 0;
  process.env.PI_SANDBOX_MASTER_KEY = "master";
  for (const fn of [...Object.values(kube), ...Object.values(sandboxEnv)]) fn.mockReset();
  kube.ensureLabeledClaim.mockResolvedValue(undefined);
  kube.resumeIfSuspended.mockImplementation(() => {
    events.push("resume-check");
    return Promise.resolve(false);
  });
  kube.recyclePod.mockImplementation((_ns: string, pod: string) => {
    events.push(`recycle ${pod}`);
    return Promise.resolve(true);
  });
  kube.listSandboxes.mockResolvedValue([]);
  sandboxEnv.ensureClaim.mockImplementation(() => {
    events.push("ensure-claim");
    return Promise.resolve();
  });
  sandboxEnv.connectSandboxEnv.mockImplementation(() => ({
    env: {
      exec: () => Promise.resolve(execResults.shift() ?? { ok: true, value: { exitCode: 0 } }),
      readFile: () => Promise.resolve({ ok: true, value: "x" }),
    },
    close: () => {
      closed += 1;
    },
  }));
  const calls: string[] = [];
  ledger = {
    calls,
    fn: (id, on) => {
      calls.push(`${String(id)}:${String(on)}`);
      return Promise.resolve();
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

const make = (extra: Record<string, string> = {}) =>
  new Sandboxes(config(extra), () => Promise.resolve("session-key"), { execInFlight: ledger.fn });
const exec = (sandboxes: Sandboxes, id = 5) =>
  (sandboxes.lazyEnv(id) as unknown as { exec: (c: string) => Promise<unknown> }).exec("true");

describe("recycle on interrupt", () => {
  it("replaces the Pod after an aborted command, then the next call opens a fresh env on the new Pod", async () => {
    const sandboxes = make();
    execResults.push({ ok: false, error: { code: "aborted" } });
    await exec(sandboxes);
    await flush();
    expect(kube.recyclePod).toHaveBeenCalledWith("pi-durable-poc", "pi-conv-5");
    expect(closed).toBe(1);
    expect(ledger.calls).toEqual(["5:true", "5:false"]);
    await exec(sandboxes);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(2);
    sandboxes.stop();
  });

  it("recycles after a timeout and after a call that threw, but not after a normal exit", async () => {
    const sandboxes = make();
    await exec(sandboxes, 1);
    await flush();
    expect(kube.recyclePod).not.toHaveBeenCalled();
    expect(ledger.calls).toEqual(["1:true", "1:false"]);

    execResults.push({ ok: false, error: { code: "timeout" } });
    await exec(sandboxes, 2);
    await flush();
    expect(kube.recyclePod).toHaveBeenCalledWith("pi-durable-poc", "pi-conv-2");

    sandboxEnv.connectSandboxEnv.mockImplementationOnce(() => ({
      env: { exec: () => Promise.reject(new Error("connection lost")) },
      close: () => undefined,
    }));
    await expect(exec(sandboxes, 3)).rejects.toThrow("connection lost");
    await flush();
    expect(kube.recyclePod).toHaveBeenCalledWith("pi-durable-poc", "pi-conv-3");
    sandboxes.stop();
  });

  it("does not recycle for file operations, and records nothing for them", async () => {
    const sandboxes = make();
    await (
      sandboxes.lazyEnv(4) as unknown as { readFile: (p: string) => Promise<unknown> }
    ).readFile("/x");
    await flush();
    expect(kube.recyclePod).not.toHaveBeenCalled();
    expect(ledger.calls).toEqual([]);
    sandboxes.stop();
  });

  it("keeps the in-flight record when the recycle fails, so the next start retries it", async () => {
    const sandboxes = make();
    kube.recyclePod.mockRejectedValueOnce(new Error("api down"));
    execResults.push({ ok: false, error: { code: "aborted" } });
    await exec(sandboxes);
    await flush();
    expect(ledger.calls).toEqual(["5:true"]);
    sandboxes.stop();
  });

  it("retries a failed recycle before the next call and then runs it in the new Pod", async () => {
    const sandboxes = make();
    kube.recyclePod.mockRejectedValueOnce(new Error("api down"));
    execResults.push({ ok: false, error: { code: "aborted" } });
    await exec(sandboxes);
    await flush();
    expect(kube.recyclePod).toHaveBeenCalledTimes(1);
    await exec(sandboxes);
    expect(kube.recyclePod).toHaveBeenCalledTimes(2);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(2); // the retry closed the old env
    expect(ledger.calls).toEqual(["5:true", "5:false", "5:true", "5:false"]);
    sandboxes.stop();
  });

  it("fails the call instead of running it in the old Pod while the recycle keeps failing", async () => {
    const sandboxes = make();
    kube.recyclePod.mockRejectedValue(new Error("api down"));
    execResults.push({ ok: false, error: { code: "aborted" } });
    await exec(sandboxes);
    await flush();
    execResults.push({ ok: true, value: { exitCode: 0 } });
    await expect(exec(sandboxes)).rejects.toThrow("could not be recycled");
    expect(execResults).toHaveLength(1); // never reached an env
    kube.recyclePod.mockResolvedValue(true);
    await exec(sandboxes); // the next call retries, succeeds and proceeds
    expect(execResults).toHaveLength(0);
    sandboxes.stop();
  });

  it("recycles at start the sandboxes that had a command in flight, before any call proceeds", async () => {
    const sandboxes = make();
    let release: () => void = () => undefined;
    kube.recyclePod.mockImplementation(
      () => new Promise<boolean>((resolve) => (release = () => resolve(true))),
    );
    sandboxes.recycleAtStart([8]);
    const call = exec(sandboxes, 8);
    await flush();
    expect(sandboxEnv.connectSandboxEnv).not.toHaveBeenCalled(); // the call waits for the new Pod
    release();
    await call;
    expect(ledger.calls).toContain("8:false");
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(1);
    sandboxes.stop();
  });
});

describe("idle suspend and resume", () => {
  it("resumes a suspended sandbox before waiting for it to be Ready", async () => {
    const sandboxes = make();
    kube.resumeIfSuspended.mockImplementation(() => {
      events.push("resume");
      return Promise.resolve(true);
    });
    await exec(sandboxes);
    expect(events.indexOf("resume")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("resume")).toBeLessThan(events.indexOf("ensure-claim"));
    sandboxes.stop();
  });

  it("suspends a sandbox only after it was idle for the threshold, closing its env first", async () => {
    vi.useFakeTimers();
    const sandboxes = make({
      PI_SANDBOX_IDLE_EVICT_SECONDS: "60",
      PI_SANDBOX_IDLE_SUSPEND_SECONDS: "120",
    });
    kube.listSandboxes.mockResolvedValue([
      { name: "pi-conv-5", mode: "Running", podTerminated: false },
    ]);
    kube.suspendSandbox.mockImplementation(() => {
      events.push("suspend");
      return Promise.resolve(true);
    });
    await exec(sandboxes, 5);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(kube.suspendSandbox).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(kube.suspendSandbox).toHaveBeenCalledWith("pi-durable-poc", "pi-conv-5");
    expect(closed).toBeGreaterThanOrEqual(1);
    sandboxes.stop();
  });

  it("does not suspend a sandbox with a call in flight, and not at all when the threshold is 0", async () => {
    vi.useFakeTimers();
    const off = make({ PI_SANDBOX_IDLE_SUSPEND_SECONDS: "0" });
    kube.listSandboxes.mockResolvedValue([
      { name: "pi-conv-6", mode: "Running", podTerminated: false },
    ]);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(kube.listSandboxes).not.toHaveBeenCalled();
    off.stop();

    const sandboxes = make({
      PI_SANDBOX_IDLE_EVICT_SECONDS: "10",
      PI_SANDBOX_IDLE_SUSPEND_SECONDS: "60",
    });
    let finish: () => void = () => undefined;
    execResults.push(
      new Promise<unknown>((resolve) => (finish = () => resolve({ ok: true, value: {} }))),
    );
    const running = exec(sandboxes, 6);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(kube.suspendSandbox).not.toHaveBeenCalled();
    finish();
    await running;
    sandboxes.stop();
  });
});

describe("credentials replaced under an open env", () => {
  it("closes the env and opens a new one (with the current shellEnv) before the next call", async () => {
    let stale = false;
    const sandboxes = new Sandboxes(config(), () => Promise.resolve("session-key"), {
      envStale: () => stale,
    });
    await exec(sandboxes);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(1);
    await exec(sandboxes);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(1);
    expect(closed).toBe(0);

    stale = true;
    await exec(sandboxes);
    expect(closed).toBe(1);
    expect(sandboxEnv.connectSandboxEnv).toHaveBeenCalledTimes(2);
    sandboxes.stop();
  });
});

describe("bridge cap", () => {
  /** Records which claim each env belongs to, in open order, and which were closed. */
  const opened: string[] = [];
  const closedClaims: string[] = [];
  beforeEach(() => {
    opened.length = 0;
    closedClaims.length = 0;
    sandboxEnv.connectSandboxEnv.mockImplementation((options: { claimName: string }) => {
      opened.push(options.claimName);
      return {
        env: {
          exec: () => Promise.resolve(execResults.shift() ?? { ok: true, value: { exitCode: 0 } }),
        },
        close: () => closedClaims.push(options.claimName),
      };
    });
  });

  /** An exec held open until `finish` runs. */
  const held = () => {
    let finish: () => void = () => undefined;
    execResults.push(new Promise<unknown>((resolve) => (finish = () => resolve({ ok: true }))));
    return () => finish();
  };
  const execWith = (sandboxes: Sandboxes, id: number, abortSignal?: AbortSignal) =>
    (
      sandboxes.lazyEnv(id) as unknown as {
        exec: (
          c: string,
          o: undefined,
          ctx: { abortSignal: AbortSignal | undefined },
        ) => Promise<unknown>;
      }
    ).exec("true", undefined, { abortSignal });

  it("defaults to 12 and refuses a value below 1", () => {
    expect(config().sandbox.maxOpenBridges).toBe(12);
    expect(config({ PI_MAX_OPEN_BRIDGES: "3" }).sandbox.maxOpenBridges).toBe(3);
    for (const bad of ["0", "-1", "1.5", "many"])
      expect(() => config({ PI_MAX_OPEN_BRIDGES: bad })).toThrow(/PI_MAX_OPEN_BRIDGES/);
  });

  it("evicts the least recently used idle env to make room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "2" });
    for (const id of [1, 2, 1]) {
      await exec(sandboxes, id);
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(opened).toEqual(["pi-conv-1", "pi-conv-2"]);
    await exec(sandboxes, 3);
    await flush();
    expect(opened).toEqual(["pi-conv-1", "pi-conv-2", "pi-conv-3"]);
    expect(closedClaims).toEqual(["pi-conv-2"]);
    sandboxes.stop();
  });

  it("makes a call wait while every env is in use, serves waiters in order, and never evicts a busy env", async () => {
    const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "1" });
    const finishOne = held();
    const one = exec(sandboxes, 1);
    await flush();
    const finishTwo = held();
    const two = exec(sandboxes, 2);
    const three = exec(sandboxes, 3);
    await flush();
    expect(opened).toEqual(["pi-conv-1"]);
    expect(closedClaims).toEqual([]);

    finishOne();
    await one;
    await flush();
    expect(opened).toEqual(["pi-conv-1", "pi-conv-2"]); // 3 arrived after 2
    expect(closedClaims).toEqual(["pi-conv-1"]);

    finishTwo();
    await two;
    await three;
    expect(opened).toEqual(["pi-conv-1", "pi-conv-2", "pi-conv-3"]);
    sandboxes.stop();
  });

  it("drops a waiter whose signal aborts, without opening for it or blocking the next one", async () => {
    const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "1" });
    const finishOne = held();
    const one = exec(sandboxes, 1);
    await flush();
    const abort = new AbortController();
    const two = execWith(sandboxes, 2, abort.signal);
    const three = exec(sandboxes, 3);
    await flush();
    abort.abort();
    await expect(two).rejects.toThrow("aborted while waiting");
    await expect(execWith(sandboxes, 4, AbortSignal.abort())).rejects.toThrow("aborted while");

    finishOne();
    await one;
    await three;
    expect(opened).toEqual(["pi-conv-1", "pi-conv-3"]);
    sandboxes.stop();
  });

  it("frees the slot when an open fails, and the next waiter gets it", async () => {
    const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "1" });
    let fail: (error: Error) => void = () => undefined;
    sandboxEnv.ensureClaim.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    );
    const one = exec(sandboxes, 1);
    await flush();
    const two = exec(sandboxes, 2);
    await flush();
    expect(opened).toEqual([]);
    fail(new Error("claim never ready"));
    await expect(one).rejects.toThrow("claim never ready");
    await two;
    expect(opened).toEqual(["pi-conv-2"]);
    sandboxes.stop();
  });

  it("does not evict an env whose open is still under way, and a failed open then raises nothing unhandled", async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "1" });
      let fail: (error: Error) => void = () => undefined;
      sandboxEnv.ensureClaim.mockImplementationOnce(
        () => new Promise<void>((_resolve, reject) => (fail = reject)),
      );
      const one = sandboxes.ensure(1); // direct caller: no call in flight, so inUse is 0
      one.catch(() => undefined);
      await flush();
      const two = sandboxes.ensure(2);
      await flush();
      expect(opened).toEqual([]); // 2 waits; 1 was not evicted
      fail(new Error("claim never ready"));
      await expect(one).rejects.toThrow("claim never ready");
      await two;
      await flush();
      expect(opened).toEqual(["pi-conv-2"]);
      expect(unhandled).toEqual([]);
      sandboxes.stop();
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("removes a waiter's abort listener once it is served", async () => {
    const sandboxes = make({ PI_MAX_OPEN_BRIDGES: "1" });
    const finishOne = held();
    const one = exec(sandboxes, 1);
    await flush();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const two = execWith(sandboxes, 2, abort.signal);
    await flush();
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(remove).not.toHaveBeenCalled();
    finishOne();
    await one;
    await two;
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0]?.[1]);
    sandboxes.stop();
  });
});
