import { deriveSandboxToken } from "@pi-durable-k8s/sandbox-env";
import { describe, expect, it } from "vitest";
import { bridgeEnv, claimOf } from "../src/bridge-launcher.ts";

const MASTER = "master-key-value";

describe("bridgeEnv", () => {
  it("keeps the Kubernetes endpoint, adds its own claim's token and drops every other secret", () => {
    const kept = bridgeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/tmp",
        KUBERNETES_SERVICE_HOST: "10.96.0.1",
        PI_SANDBOX_MASTER_KEY: MASTER,
        PI_SANDBOX_AUTH_TOKEN: "stale-inherited-token",
        PI_DURABLE_DATABASE_URL: "postgres://u:p@db/app",
        PI_API_TOKENS: "alice:secret-token-value",
        SOMETHING_ELSE: "x",
      },
      "pi-conv-7",
    );
    expect(kept).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp",
      KUBERNETES_SERVICE_HOST: "10.96.0.1",
      PI_SANDBOX_AUTH_TOKEN: deriveSandboxToken(MASTER, "pi-conv-7"),
    });
  });

  it("never lets the master key (or anything derived from it but its own token) reach the bridge", () => {
    const kept = bridgeEnv({ PATH: "/usr/bin", PI_SANDBOX_MASTER_KEY: MASTER }, "pi-conv-7");
    expect(Object.keys(kept)).not.toContain("PI_SANDBOX_MASTER_KEY");
    expect(Object.values(kept)).not.toContain(MASTER);
    expect(kept.PI_SANDBOX_AUTH_TOKEN).not.toBe(deriveSandboxToken(MASTER, "pi-conv-8"));
  });

  it("fails closed without a master key", () => {
    expect(() => bridgeEnv({ PATH: "/usr/bin" }, "pi-conv-7")).toThrow(/PI_SANDBOX_MASTER_KEY/);
    expect(() => bridgeEnv({ PI_SANDBOX_MASTER_KEY: "" }, "pi-conv-7")).toThrow(
      /PI_SANDBOX_MASTER_KEY/,
    );
  });

  it("never passes the OneCLI agent token or any proxy setting on to a bridge", () => {
    const kept = bridgeEnv(
      {
        PATH: "/usr/bin",
        PI_SANDBOX_MASTER_KEY: MASTER,
        ONECLI_AGENT_TOKEN: "aoc_0123456789abcdef",
        HTTPS_PROXY: "http://x:aoc_0123456789abcdef@onecli.onecli:10255",
        HTTP_PROXY: "http://onecli.onecli:10255",
        NO_PROXY: ".svc",
        NODE_USE_ENV_PROXY: "1",
        OPENROUTER_API_KEY: "sk-real",
        ONECLI_API_KEY: "oc_admin",
        PI_GITHUB_APP_DIR: "/etc/pi-github-app",
      },
      "pi-conv-7",
    );
    expect(Object.keys(kept).sort()).toEqual(["PATH", "PI_SANDBOX_AUTH_TOKEN"]);
  });
});

describe("claimOf", () => {
  it("reads the --claim value the bridge is started with", () => {
    expect(claimOf(["--claim", "pi-conv-7", "--namespace", "ns", "serve"])).toBe("pi-conv-7");
  });

  it("rejects a missing or empty claim", () => {
    expect(() => claimOf(["--namespace", "ns", "serve"])).toThrow(/--claim/);
    expect(() => claimOf(["serve", "--claim"])).toThrow(/--claim/);
    expect(() => claimOf(["--claim", ""])).toThrow(/--claim/);
  });
});
