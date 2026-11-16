#!/usr/bin/env node
import { runBridge } from "./bridge.js";
import { parseBridgeArgs } from "./config.js";
import { sandboxStart } from "./sandbox-client.js";

async function main(): Promise<number> {
  let config;
  try {
    config = parseBridgeArgs(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`bridge: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  return runBridge({
    start: sandboxStart(config.target),
    command: config.command,
    args: config.args,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}

// Set the code and let the loop drain: process.exit() could cut off buffered stdout.
// A gRPC channel may keep the loop alive, so exit explicitly after a short grace period.
void main().then((code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 200).unref();
});
