import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { poolConfig } from "../src/storage.ts";
import {
  ONECLI_IDENTIFIER_MAX,
  ONECLI_NAME_PREFIX_MAX,
  mcpAgentIdentifier,
} from "../src/onecli-names.ts";
import { claimNameFor } from "../src/lifecycle.ts";

const env = {
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
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

describe("config: OneCLI name prefix", () => {
  it("defaults to pi-session- and accepts a short lowercase prefix ending in a dash", () => {
    expect(loadConfig(env).repos.namePrefix).toBe("pi-session-");
    expect(loadConfig({ ...env, PI_ONECLI_NAME_PREFIX: "pi-e2e-ab12-" }).repos.namePrefix).toBe(
      "pi-e2e-ab12-",
    );
  });

  it("accepts the longest prefix whose MCP agent still fits OneCLI's 50 characters, and no longer one", () => {
    const longest = `${"a".repeat(ONECLI_NAME_PREFIX_MAX - 1)}-`;
    expect(ONECLI_NAME_PREFIX_MAX).toBe(12);
    expect(mcpAgentIdentifier(randomUUID(), longest).length).toBe(ONECLI_IDENTIFIER_MAX);
    expect(loadConfig({ ...env, PI_ONECLI_NAME_PREFIX: longest }).repos.namePrefix).toBe(longest);
    expect(() => loadConfig({ ...env, PI_ONECLI_NAME_PREFIX: `a${longest}` })).toThrow(
      /PI_ONECLI_NAME_PREFIX.*12 characters/,
    );
  });

  it("rejects anything else", () => {
    for (const bad of [
      "",
      "pi-session",
      "Pi-",
      "pi_e2e-",
      "pi e2e-",
      "-",
      `${"a".repeat(12)}-`,
      `${"a".repeat(40)}-`,
    ])
      expect(() => loadConfig({ ...env, PI_ONECLI_NAME_PREFIX: bad })).toThrow(
        /PI_ONECLI_NAME_PREFIX/,
      );
  });
});

describe("config", () => {
  it("requires the database URL and API tokens and defaults the rest", () => {
    expect(() => loadConfig({})).toThrow(/PI_DURABLE_DATABASE_URL/);
    expect(() =>
      loadConfig({
        PI_ORCH_NAMESPACE: "test-ns",
        PI_ORCH_WARMPOOL: "test-pool",
        PI_ONECLI_GATEWAY: "http://gateway:10255",
        PI_ONECLI_API: "http://gateway-api:10256",
        PI_DURABLE_DATABASE_URL: "x",
      }),
    ).toThrow(/PI_API_TOKENS/);
    expect(loadConfig(env)).toMatchObject({
      namespace: "test-ns",
      warmPool: "test-pool",
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

  it("passes the database TLS settings to the adapter's pool and drops sslmode from the URI", () => {
    const tlsEnv = {
      ...env,
      PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app?sslmode=verify-full",
      PI_DURABLE_DATABASE_TLS_MODE: "verify-full",
    };
    const options = poolConfig(loadConfig(tlsEnv));
    expect(options).toMatchObject({
      connectionString: "postgres://u:p@db:5432/app",
      ssl: { rejectUnauthorized: true },
    });
    expect(poolConfig(loadConfig(env))).not.toHaveProperty("ssl");
    expect(() => loadConfig({ ...env, PI_DURABLE_DATABASE_TLS_MODE: "require" })).toThrow(
      /PI_DURABLE_DATABASE_TLS_MODE/,
    );
  });

  it("names claims from the conversation id as valid DNS-1123 names", () => {
    expect(claimNameFor(0, 42)).toBe("pi-conv-42");
    expect(claimNameFor(0, 42)).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
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

describe("required install configuration", () => {
  it("names each missing or empty install variable", () => {
    for (const name of [
      "PI_ORCH_NAMESPACE",
      "PI_ORCH_WARMPOOL",
      "PI_ONECLI_GATEWAY",
      "PI_ONECLI_API",
    ]) {
      for (const value of [undefined, "", "   "]) {
        expect(() => loadConfig({ ...env, [name]: value })).toThrow(`${name} is required`);
      }
    }
  }, 5_000);

  it("uses PGHOST when the database URI omits a host", () => {
    expect(
      loadConfig({ ...env, PI_DURABLE_DATABASE_URL: "postgres:///app", PGHOST: "database" }).onecli
        .noProxy,
    ).toContain("database");
  }, 5_000);
});

describe("config: egress proxy", () => {
  it("is off unless PI_EGRESS_PROXY_URL is set", () => {
    expect(loadConfig(env).egressProxyUrl).toBeUndefined();
    expect(loadConfig({ ...env, PI_EGRESS_PROXY_URL: " " }).egressProxyUrl).toBeUndefined();
  });

  it("takes http://host:port without credentials or a path", () => {
    expect(
      loadConfig({ ...env, PI_EGRESS_PROXY_URL: "http://pi-egress-proxy.ns.svc:3128" })
        .egressProxyUrl,
    ).toBe("http://pi-egress-proxy.ns.svc:3128");
    for (const bad of [
      "pi-egress-proxy:3128",
      "https://p:3128",
      "http://u:p@p:3128",
      "http://p:3128/x",
    ]) {
      expect(() => loadConfig({ ...env, PI_EGRESS_PROXY_URL: bad }), bad).toThrow(
        /PI_EGRESS_PROXY_URL/,
      );
    }
  });
});

describe("feed retention (ADR 0058)", () => {
  it("defaults to 7 days and refuses values that are not whole hours up to a year", () => {
    expect(loadConfig(env).feedRetentionHours).toBe(168);
    expect(loadConfig({ ...env, PI_FEED_RETENTION_HOURS: "24" }).feedRetentionHours).toBe(24);
    for (const bad of ["0", "1.5", "8761", "x"]) {
      expect(() => loadConfig({ ...env, PI_FEED_RETENTION_HOURS: bad }), bad).toThrow(
        /PI_FEED_RETENTION_HOURS/,
      );
    }
  });
});
