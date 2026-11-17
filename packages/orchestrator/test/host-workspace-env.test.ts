import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kube = vi.hoisted(() => ({
  deleteClaimAndPvc: vi.fn(),
  ensureLabeledClaim: vi.fn(),
  listSandboxes: vi.fn(),
  recyclePod: vi.fn(),
  resumeIfSuspended: vi.fn(),
  suspendSandbox: vi.fn(),
}));
const sandboxEnv = vi.hoisted(() => ({ connectSandboxEnv: vi.fn(), ensureClaim: vi.fn() }));
vi.mock("../src/kube.ts", () => kube);
vi.mock("@pi-durable-k8s/sandbox-env", () => ({
  ENV: { masterKey: "PI_SANDBOX_MASTER_KEY" },
  SANDBOXD_TOKEN_SHA256_ENV: "SANDBOXD_AUTH_TOKEN_SHA256",
  deriveSandboxToken: () => "token",
  sandboxTokenSha256: () => "hash",
  ...sandboxEnv,
}));

import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});

let host: Host | undefined;
beforeEach(() => {
  process.env.PI_SANDBOX_MASTER_KEY = "master";
  for (const fn of [...Object.values(kube), ...Object.values(sandboxEnv)]) fn.mockReset();
  kube.ensureLabeledClaim.mockResolvedValue(undefined);
  kube.resumeIfSuspended.mockResolvedValue(false);
  kube.recyclePod.mockResolvedValue(true);
  sandboxEnv.ensureClaim.mockResolvedValue(undefined);
  sandboxEnv.connectSandboxEnv.mockImplementation(() => ({
    env: { exec: () => Promise.resolve({ ok: false, error: { code: "aborted" } }) },
    close: () => undefined,
  }));
});
afterEach(async () => {
  await host?.close().catch(() => undefined);
});

describe("Host.workspaceEnv", () => {
  it("runs the repo clone through the tracked env: an interrupted clone command recycles the Pod", async () => {
    const calls: string[] = [];
    host = await Host.open(
      new MemoryStorage(),
      config,
      () => undefined,
      () => Promise.resolve("session"),
      {
        execInFlight: (id, on) => {
          calls.push(`${String(id)}:${String(on)}`);
          return Promise.resolve();
        },
      },
    );
    const env = await host.workspaceEnv(7);
    await (env as unknown as { exec: (c: string) => Promise<unknown> }).exec("git clone");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(["7:true", "7:false"]);
    expect(kube.recyclePod).toHaveBeenCalledWith("test-ns", "pi-conv-7");
  });
});

describe("Host.startSession", () => {
  it("deletes the claim it created when the session cannot be started", async () => {
    sandboxEnv.connectSandboxEnv.mockImplementation(() => {
      throw new Error("bridge failed");
    });
    kube.deleteClaimAndPvc.mockResolvedValue(undefined);
    host = await Host.open(
      new MemoryStorage(),
      config,
      () => undefined,
      () => Promise.resolve("control-key"),
    );
    await expect(host.startSession({ steps: [] })).rejects.toThrow("bridge failed");
    expect(kube.ensureLabeledClaim).toHaveBeenCalledTimes(1);
    expect(kube.deleteClaimAndPvc).toHaveBeenCalledTimes(1);
    expect(kube.deleteClaimAndPvc.mock.calls[0]?.[2]).toBe("control-key");
  });
});
