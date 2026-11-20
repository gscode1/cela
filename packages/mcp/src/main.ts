#!/usr/bin/env node
/** Stdio entry point. stdout is the MCP transport: log to stderr only, and never print the token. */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { ConfigError, parseConfig } from "./config.js";
import { createServer } from "./server.js";

let config;
try {
  config = parseConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`cela-mcp: ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

await createServer(config).connect(new StdioServerTransport());
