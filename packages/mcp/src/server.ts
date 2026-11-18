import { McpServer } from "@modelcontextprotocol/server";
import { SessionApi } from "./api.js";
import type { McpConfig } from "./config.js";
import { registerTools, type ToolOptions } from "./tools.js";

export const SERVER_NAME = "pi-durable";
// Keep in step with package.json; a test checks it.
export const SERVER_VERSION = "0.0.0";

export function createServer(
  config: McpConfig,
  api: SessionApi = new SessionApi({ apiUrl: config.apiUrl, token: config.token }),
  opts: ToolOptions = {},
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, api, config, opts);
  return server;
}
