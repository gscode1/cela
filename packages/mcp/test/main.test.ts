/**
 * A ConfigError must reach the client: Claude Desktop hides stderr, so the first request gets a JSON-RPC error.
 * Spawns the built entry point (`pnpm check` builds before it tests).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
const SECRET = "dummy-secret-token-value";

interface Run {
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}

function run(input: string[], closeStdin: boolean): Promise<Run> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [entry], {
      env: {
        PATH: process.env.PATH ?? "",
        PI_API_URL: "https://cela.example.test",
        PI_API_TOKEN: SECRET,
        PI_MCP_ADMIN: "true",
        PI_API_ADMIN_TOKEN: SECRET,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ stdout, stderr, code, ms: Date.now() - started }));
    for (const line of input) child.stdin.write(`${line}\n`);
    if (closeStdin) child.stdin.end();
  });
}

describe("config error handling", { timeout: 15_000 }, () => {
  it("answers the first request with a JSON-RPC error and exits 1", async () => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    });
    const notification = JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
    const r = await run([notification, init], false);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const res = JSON.parse(lines[0] as string) as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(res.jsonrpc).toBe("2.0");
    expect(res.id).toBe(7);
    expect(res.error.code).toBe(-32603);
    expect(res.error.message).toContain("cela-mcp configuration error");
    expect(res.error.message).toContain("PI_API_ADMIN_TOKEN");
    expect(r.stdout).not.toContain(SECRET);
    expect(r.stderr).toContain("PI_API_ADMIN_TOKEN");
    expect(r.stderr).not.toContain(SECRET);
    expect(r.code).toBe(1);
  });

  it("exits 1 when stdin closes without a message", async () => {
    const r = await run([], true);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(5000);
  });

  it("exits 1 after the timeout when no request arrives", async () => {
    const r = await run([], false);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
  });
});
