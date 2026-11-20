#!/usr/bin/env node
/** Stdio entry point. stdout is the MCP transport: log to stderr only, and never print the token. */
import { createInterface } from "node:readline";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ConfigError, parseConfig } from "./config.js";
import { createServer } from "./server.js";

/** How long to wait for the client's first request before giving up. */
const CONFIG_ERROR_WAIT_MS = 5000;

/**
 * Some clients (Claude Desktop) hide stderr and only log "transport closed". So answer the first request, normally
 * `initialize`, with a JSON-RPC error that carries the reason, then exit. Plain framing, no SDK server: the
 * message names only the variable, never a value.
 */
function failWithConfigError(message: string): void {
  process.stderr.write(`cela-mcp: ${message}\n`);
  const lines = createInterface({ input: process.stdin });
  // unref: the timer alone must never keep the process alive.
  const timer = setTimeout(() => process.exit(1), CONFIG_ERROR_WAIT_MS);
  timer.unref();
  const exit = (): never => process.exit(1);
  lines.on("close", exit);
  lines.on("line", (line) => {
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    } catch {
      return; // not JSON: keep waiting
    }
    if (typeof id !== "string" && typeof id !== "number") return; // notification
    const response = {
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: `cela-mcp configuration error: ${message}` },
    };
    process.stdout.write(`${JSON.stringify(response)}\n`, exit);
  });
}

let config;
try {
  config = parseConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    failWithConfigError(error.message);
  } else {
    throw error;
  }
}

if (config) await createServer(config).connect(new StdioServerTransport());
