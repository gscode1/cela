import { deriveSandboxToken } from "@pi-durable-k8s/sandbox-env";
import { describe, expect, it } from "vitest";
import { bridgeCommand, bridgeEnv } from "../src/bridge-launcher.ts";

const MASTER = "master-key-value";
const TOKEN = deriveSandboxToken(MASTER, "pi-conv-7");

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
      TOKEN,
    );
    expect(kept).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp",
      KUBERNETES_SERVICE_HOST: "10.96.0.1",
      PI_SANDBOX_AUTH_TOKEN: TOKEN,
    });
  });

  it("never lets the master key reach the bridge", () => {
    const kept = bridgeEnv({ PATH: "/usr/bin", PI_SANDBOX_MASTER_KEY: MASTER }, TOKEN);
    expect(Object.keys(kept)).not.toContain("PI_SANDBOX_MASTER_KEY");
    expect(Object.values(kept)).not.toContain(MASTER);
  });

  it("fails closed without a token", () => {
    expect(() => bridgeEnv({ PATH: "/usr/bin" }, "")).toThrow(/token/);
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
      TOKEN,
    );
    expect(Object.keys(kept).sort()).toEqual(["PATH", "PI_SANDBOX_AUTH_TOKEN"]);
  });
});

describe("bridgeCommand", () => {
  it("starts the bridge itself through env -i, so no process the bridge can read holds the master key", () => {
    const argv = bridgeCommand(
      { PATH: "/usr/bin", PI_SANDBOX_MASTER_KEY: MASTER, PI_API_TOKENS: "alice:secret" },
      TOKEN,
      "/code/app/cli.js",
    );
    expect(argv.slice(0, 2)).toEqual(["/usr/bin/env", "-i"]);
    expect(argv.slice(2, 4).sort()).toEqual([`PATH=/usr/bin`, `PI_SANDBOX_AUTH_TOKEN=${TOKEN}`]);
    expect(argv.at(-1)).toBe("/code/app/cli.js");
    expect(argv.join("\n")).not.toContain(MASTER);
    expect(argv.join("\n")).not.toContain("alice:secret");
  });

  it("passes a program path with URL-special characters through unchanged", () => {
    const cli = "/srv/a#b?c d/cli.js";
    expect(bridgeCommand({ PATH: "/usr/bin" }, TOKEN, cli).at(-1)).toBe(cli);
  });

  it("resolves the real bridge program by default", () => {
    expect(bridgeCommand({}, TOKEN).at(-1)).toMatch(/cli\.js$/);
  });
});
