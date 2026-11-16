import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packagesDir = resolve(import.meta.dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("vendored SDK isolation", () => {
  it("is imported only by sandbox-env/src/sandbox-client.ts", () => {
    const importers = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "vendor")
      .flatMap((entry) => sourceFiles(join(packagesDir, entry.name)))
      .filter((file) => /from\s+["']agentic-sandbox-client["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(packagesDir.length + 1));
    expect(importers).toEqual(["sandbox-env/src/sandbox-client.ts"]);
  }, 15_000);
});

describe("relay and SDK auto-cleanup", () => {
  const src = resolve(import.meta.dirname, "../src");

  it("relay.ts imports only node:net and mentions no token or SDK", () => {
    const code = readFileSync(join(src, "relay.ts"), "utf8");
    const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
    expect(imports).toEqual(["node:net", "node:net"]);
    expect(code).not.toMatch(/authToken|AUTH_TOKEN|agentic-sandbox-client|SandboxClient/);
  });

  it("nothing outside the vendored SDK enables its process-wide auto-cleanup handlers", () => {
    // The SDK's auto-cleanup installs SIGINT/SIGTERM handlers that delete claims; in-process clients are long lived.
    const callers = readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "vendor")
      .flatMap((entry) => sourceFiles(join(packagesDir, entry.name)))
      .filter((file) => new RegExp("enable" + "AutoCleanup").test(readFileSync(file, "utf8")));
    expect(callers.map((file) => file.slice(packagesDir.length + 1))).toEqual([]);
  }, 15_000);
});
