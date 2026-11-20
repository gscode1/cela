#!/usr/bin/env node
/**
 * Smoke test of a packaged MCP adapter: runs the given command as a stdio MCP server with a fake environment, sends
 * initialize and tools/list as newline-delimited JSON-RPC, and checks the server name, version and tool names.
 * Listing tools does not call the API, so the unreachable PI_API_URL is never contacted.
 *
 *   node smoke.mjs <expected-version> <command> [args...]
 *   node smoke.mjs 1.0.0 npx -y ./cela-mcp-1.0.0.tgz
 */
import { spawn } from "node:child_process";

const [expectedVersion, command, ...args] = process.argv.slice(2);
if (expectedVersion === undefined || command === undefined) {
  console.error("usage: smoke.mjs <expected-version> <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, PI_API_URL: "http://127.0.0.1:9", PI_API_TOKEN: "smoke-test-token" },
});

const pending = new Map();
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line === "") continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 120_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error !== undefined)
        reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

child.on("exit", (code) => {
  if (code !== null && code !== 0) {
    console.error(`smoke: server exited with code ${code}`);
    process.exit(1);
  }
});

try {
  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const { tools } = await request(2, "tools/list", {});
  const names = tools.map((t) => t.name).sort();
  const wanted = [
    "cancel",
    "delete_session",
    "get_session",
    "run_task",
    "send_message",
    "start_session",
    "wait",
  ];
  if (init.serverInfo?.name !== "cela" || init.serverInfo?.version !== expectedVersion) {
    throw new Error(`unexpected serverInfo ${JSON.stringify(init.serverInfo)}`);
  }
  if (JSON.stringify(names) !== JSON.stringify(wanted))
    throw new Error(`unexpected tools ${JSON.stringify(names)}`);
  console.log(
    `smoke ok: ${init.serverInfo.name} ${init.serverInfo.version}, tools: ${names.join(", ")}`,
  );
  child.kill();
  process.exit(0);
} catch (error) {
  console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  child.kill();
  process.exit(1);
}
