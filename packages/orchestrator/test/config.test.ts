import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { poolConfig } from "../src/storage.ts";
import { claimNameFor } from "../src/sandboxes.ts";

const env = {
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
  POD_NAME: "pi-orchestrator-abc",
};

describe("config timers", () => {
  it("rejects a seconds setting that overflows a timer delay", () => {
    for (const name of [
      "PI_SWEEP_INTERVAL_SECONDS",
      "PI_SWEEP_GRACE_SECONDS",
      "PI_SANDBOX_IDLE_EVICT_SECONDS",
      "PI_SANDBOX_IDLE_SUSPEND_SECONDS",
    ]) {
      expect(() => loadConfig({ ...env, [name]: "2592000" })).toThrow(new RegExp(name));
    }
    expect(loadConfig({ ...env, PI_SWEEP_INTERVAL_SECONDS: "2147483" }).sweep.intervalMs).toBe(
      2_147_483_000,
    );
  });
});

describe("config", () => {
  it("requires the database URL and API tokens and defaults the rest", () => {
    expect(() => loadConfig({})).toThrow(/PI_DURABLE_DATABASE_URL/);
    expect(() => loadConfig({ PI_DURABLE_DATABASE_URL: "x" })).toThrow(/PI_API_TOKENS/);
    expect(loadConfig(env)).toMatchObject({
      namespace: "pi-durable-poc",
      warmPool: "pi-env-pool",
      port: 8081,
      control: false,
      testFaults: false,
    });
  });

  it("sets keepalive and timeouts so a silent drop fails closed instead of hanging", () => {
    expect(poolConfig(loadConfig(env))).toMatchObject({
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      statement_timeout: 30_000,
      max: 1,
      application_name: "pi-orchestrator-abc",
    });
  });

  it("names claims from the conversation id as valid DNS-1123 names", () => {
    expect(claimNameFor(42)).toBe("pi-conv-42");
    expect(claimNameFor(42)).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  });

  it("defaults the sandbox idle handling and the sweep, and reads them in seconds", () => {
    expect(loadConfig(env)).toMatchObject({
      sandbox: { idleEvictMs: 120_000, idleSuspendMs: 1_800_000 },
      sweep: { intervalMs: 300_000, graceMs: 600_000, maxActions: 10 },
    });
    expect(
      loadConfig({
        ...env,
        PI_SANDBOX_IDLE_EVICT_SECONDS: "30",
        PI_SANDBOX_IDLE_SUSPEND_SECONDS: "90",
        PI_SWEEP_INTERVAL_SECONDS: "15",
        PI_SWEEP_GRACE_SECONDS: "45",
        PI_SWEEP_MAX_ACTIONS: "3",
      }),
    ).toMatchObject({
      sandbox: { idleEvictMs: 30_000, idleSuspendMs: 90_000 },
      sweep: { intervalMs: 15_000, graceMs: 45_000, maxActions: 3 },
    });
  });

  it("rejects idle and sweep settings that cannot work", () => {
    expect(() => loadConfig({ ...env, PI_SANDBOX_IDLE_SUSPEND_SECONDS: "60" })).toThrow(
      /must not be below/,
    );
    expect(() => loadConfig({ ...env, PI_SANDBOX_IDLE_SUSPEND_SECONDS: "-1" })).toThrow(
      /whole number/,
    );
    expect(() => loadConfig({ ...env, PI_SWEEP_GRACE_SECONDS: "1.5" })).toThrow(/whole number/);
    expect(() => loadConfig({ ...env, PI_SWEEP_MAX_ACTIONS: "0" })).toThrow(/1 or more/);
    expect(loadConfig({ ...env, PI_SANDBOX_IDLE_SUSPEND_SECONDS: "0" }).sandbox.idleSuspendMs).toBe(
      0,
    );
  });
});
