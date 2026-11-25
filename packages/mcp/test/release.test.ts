/**
 * Invariants of the release packaging (ADR 0051): the npm package and the MCPB bundle must stay in step, and the
 * bundle's settings must produce an environment that parseConfig accepts. The manifest is validated by the pinned
 * `@anthropic-ai/mcpb` itself, the same code `mcpb validate` and `mcpb pack` run.
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  getMcpConfigForManifest,
  MANIFEST_SCHEMAS,
  type McpbManifestAny,
} from "@anthropic-ai/mcpb";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createServer, SERVER_VERSION } from "../src/server.js";

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
}

const pkg = readJson("package.json") as {
  private?: boolean;
  version: string;
  files: string[];
  bin: Record<string, string>;
  engines: { node: string };
  dependencies: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const manifestData = readJson("manifest.json");
const manifest = MANIFEST_SCHEMAS["0.3"].parse(manifestData) as McpbManifestAny;

/** The environment Claude Desktop hands the server for these settings, per the reference substitution of mcpb. */
async function renderEnv(
  userConfig: Record<string, string | number | boolean>,
): Promise<Record<string, string>> {
  const rendered = await getMcpConfigForManifest({
    manifest,
    extensionPath: "/bundle",
    systemDirs: {},
    userConfig,
    pathSeparator: "/",
  });
  return rendered?.env ?? {};
}

const required = { api_url: "https://cela.example.test", api_token: "session-token" };

describe("release packaging", { timeout: 20_000 }, () => {
  it("keeps one version in package.json, the manifest and the server", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(SERVER_VERSION).toBe(pkg.version);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("packs a self-contained npm package", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.files).toEqual(["dist"]);
    expect(pkg.bin).toEqual({ "cela-mcp": "dist/main.js" });
    expect(pkg.engines.node).toBe(">=22.19.0");
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/server", "zod"]);
    const specs = [pkg.dependencies, pkg.optionalDependencies, pkg.peerDependencies].flatMap((d) =>
      Object.values(d ?? {}),
    );
    expect(
      specs.filter(
        (s) => s.startsWith("workspace:") || s.startsWith("file:") || s.startsWith("link:"),
      ),
    ).toEqual([]);
    expect(manifest.server.entry_point).toBe(pkg.bin["cela-mcp"]);
  });

  it("maps every setting to an environment variable and uses every setting", () => {
    const env = manifest.server.mcp_config.env ?? {};
    const refs = Object.values(env).map((v) => /^\$\{user_config\.(\w+)\}$/.exec(v)?.[1]);
    expect(refs.every((r) => r !== undefined)).toBe(true);
    expect([...refs].sort()).toEqual(Object.keys(manifest.user_config ?? {}).sort());
    expect(Object.keys(env).sort()).toEqual([
      "PI_API_ADMIN_TOKEN",
      "PI_API_TOKEN",
      "PI_API_URL",
      "PI_MCP_ADMIN",
      "PI_MCP_ADMIN_DANGEROUS",
      "PI_MCP_ADMIN_WRITES",
      "PI_MCP_MAX_SESSIONS",
    ]);
  });

  it("keeps both tokens sensitive and gives every optional setting a default", () => {
    const cfg = manifest.user_config ?? {};
    expect(cfg.api_token?.sensitive).toBe(true);
    expect(cfg.admin_token?.sensitive).toBe(true);
    // An optional setting without a default is left as a literal ${user_config.x} by the reference substitution.
    for (const [key, option] of Object.entries(cfg)) {
      if (option.required !== true) expect(option.default, key).not.toBeUndefined();
    }
  });

  it("starts with only the required settings filled in", async () => {
    const config = parseConfig(await renderEnv(required));
    expect(config).toMatchObject({
      apiUrl: "https://cela.example.test",
      token: "session-token",
      maxSessions: 20,
    });
    expect(config.admin).toBeUndefined();
  });

  it("turns on admin mode, writes and dangerous tools from the settings", async () => {
    const env = await renderEnv({
      ...required,
      admin_enabled: true,
      admin_token: "admin-token",
      admin_writes: true,
      admin_dangerous: true,
      max_sessions: 5,
    });
    expect(parseConfig(env)).toMatchObject({
      maxSessions: 5,
      admin: { token: "admin-token", writes: true, dangerous: true },
    });
  });

  it("keeps writes and dangerous tools off unless their settings are on", async () => {
    const env = await renderEnv({
      ...required,
      admin_enabled: true,
      admin_token: "admin-token",
      admin_writes: true,
    });
    expect(parseConfig(env).admin).toEqual({
      token: "admin-token",
      writes: true,
      dangerous: false,
    });
    const reads = await renderEnv({ ...required, admin_enabled: true, admin_token: "admin-token" });
    expect(parseConfig(reads).admin).toEqual({
      token: "admin-token",
      writes: false,
      dangerous: false,
    });
    // The dangerous tier needs the writes tier, as at the command line.
    const only = await renderEnv({
      ...required,
      admin_enabled: true,
      admin_token: "admin-token",
      admin_dangerous: true,
    });
    expect(() => parseConfig(only)).toThrow("PI_MCP_ADMIN_DANGEROUS requires PI_MCP_ADMIN_WRITES");
  });

  it("asks for the admin token when admin mode has none", async () => {
    const env = await renderEnv({ ...required, admin_enabled: true });
    expect(() => parseConfig(env)).toThrow("PI_API_ADMIN_TOKEN");
  });

  it("lists the session tools the server registers", async () => {
    const server = createServer(
      parseConfig({ PI_API_URL: required.api_url, PI_API_TOKEN: required.api_token }),
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(b);
    try {
      const registered = (await client.listTools()).tools.map((t) => t.name).sort();
      expect((manifest.tools ?? []).map((t) => t.name).sort()).toEqual(registered);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
