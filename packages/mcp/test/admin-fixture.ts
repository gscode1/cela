import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { parseConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

/** Shared by the admin tool tests (admin-<domain>.test.ts): a connected client of a server in admin mode. */
export const base = { PI_API_URL: "https://example.test", PI_API_TOKEN: "session-secret" };
export const adminEnv = { ...base, PI_MCP_ADMIN: "true", PI_API_ADMIN_TOKEN: "admin-secret" };
export const writesEnv = { ...adminEnv, PI_MCP_ADMIN_WRITES: "true" };
export const dangerousEnv = { ...writesEnv, PI_MCP_ADMIN_DANGEROUS: "true" };

/** Starts a server for `env`, runs `run` with a client connected to it and always closes both. */
export async function withClient<T>(
  env: Record<string, string>,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createServer(parseConfig(env));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await server.connect(a);
  await client.connect(b);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}
