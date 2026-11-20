import { deriveSandboxToken } from "@cela/sandbox-env";
import { describe, expect, it } from "vitest";
import { bridgeCommand, bridgeEnv } from "../src/bridge-launcher.ts";

const MASTER = "master-key-value";
const TOKEN = deriveSandboxToken(MASTER, "pi-conv-7");

describe("bridgeEnv", () => {
  it("keeps PATH and HOME and drops every secret, the Kubernetes endpoint and any token", () => {
    const kept = bridgeEnv({
      PATH: "/usr/bin",
      HOME: "/tmp",
      KUBERNETES_SERVICE_HOST: "10.96.0.1",
      PI_SANDBOX_MASTER_KEY: MASTER,
      PI_SANDBOX_AUTH_TOKEN: TOKEN,
      PI_DURABLE_DATABASE_URL: "postgres://u:p@db/app",
      PI_API_TOKENS: "alice:secret-token-value",
      SOMETHING_ELSE: "x",
    });
    expect(kept).toEqual({ PATH: "/usr/bin", HOME: "/tmp" });
  });

  it("never passes the OneCLI agent token or any proxy setting on to the relay", () => {
    const kept = bridgeEnv({
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
    });
    expect(Object.keys(kept)).toEqual(["PATH"]);
  });
});

describe("bridgeCommand", () => {
  it("starts the relay itself through env -i, with no token in argv or environment and no master key", () => {
    const argv = bridgeCommand(
      {
        PATH: "/usr/bin",
        PI_SANDBOX_MASTER_KEY: MASTER,
        PI_SANDBOX_AUTH_TOKEN: TOKEN,
        PI_API_TOKENS: "alice:secret",
      },
      "/code/app/relay.js",
    );
    expect(argv).toEqual([
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin",
      process.execPath,
      "/code/app/relay.js",
    ]);
    expect(argv.join("\n")).not.toContain(TOKEN);
    expect(argv.join("\n")).not.toContain(MASTER);
    expect(argv.join("\n")).not.toContain("alice:secret");
    expect(argv.join("\n")).not.toContain("AUTH_TOKEN");
  });

  it("passes a program path with URL-special characters through unchanged", () => {
    const relay = "/srv/a#b?c d/relay.js";
    expect(bridgeCommand({ PATH: "/usr/bin" }, relay).at(-1)).toBe(relay);
  });

  it("resolves the real relay program by default", () => {
    expect(bridgeCommand({}).at(-1)).toMatch(/relay\.js$/);
  });
});
