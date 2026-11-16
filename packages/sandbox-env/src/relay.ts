#!/usr/bin/env node
// The process pi-env's Connection spawns for a sandbox env. It loads nothing but node:net: no SDK, no token. It pipes
// stdio to the orchestrator's broker (broker.ts) and prints the log lines the broker sends on stderr. Node must be able
// to run this file as TypeScript in tests, so it imports no sibling module: the header and ack below mirror broker.ts.
import { connect } from "node:net";
import type { Socket } from "node:net";

const LOG_ACK = "ok\n";
const LOG_DRAIN_MS = 1_000;

function fail(message: string): never {
  process.stderr.write(`bridge: ${message}\n`);
  process.exit(1);
}

// argv: --socket <path> --nonce <nonce> --claim <name> [--namespace ..] serve --token <hex>. `--claim` only names the
// sandbox for the orchestrator's bridge-rss, which finds this process by it.
function parseArgs(argv: readonly string[]): { socket: string; nonce: string; args: string[] } {
  const flags = new Map<string, string>();
  let i = 0;
  for (; i < argv.length && argv[i]?.startsWith("--"); i += 2) {
    const value = argv[i + 1];
    if (value === undefined) fail(`${argv[i] ?? "flag"} needs a value`);
    flags.set(argv[i] as string, value);
  }
  const socket = flags.get("--socket");
  const nonce = flags.get("--nonce");
  if (socket === undefined || nonce === undefined) fail("--socket and --nonce are required");
  return { socket, nonce, args: argv.slice(i) };
}

function open(path: string, header: object): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      socket.on("error", () => undefined); // later errors end in `close`
      socket.write(`${JSON.stringify(header)}\n`);
      resolve(socket);
    });
  });
}

function acked(log: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const onData = (chunk: Buffer): void => {
      seen += chunk.toString("utf8");
      if (seen.length < LOG_ACK.length) return;
      log.off("data", onData);
      if (!seen.startsWith(LOG_ACK)) {
        reject(new Error("broker refused the connection"));
        return;
      }
      const rest = seen.slice(LOG_ACK.length);
      if (rest !== "") process.stderr.write(rest);
      resolve();
    };
    log.on("data", onData);
    log.once("close", () => reject(new Error("broker refused the connection")));
  });
}

async function main(): Promise<void> {
  const { socket, nonce, args } = parseArgs(process.argv.slice(2));
  // The log connection first: the broker acks it, and only then may a data connection claim the same nonce.
  const log = await open(socket, { nonce, role: "log", args });
  await acked(log);
  log.pipe(process.stderr, { end: false });
  const data = await open(socket, { nonce, role: "data", args });

  let failed = false;
  data.on("error", () => {
    failed = true;
  });
  process.stdin.on("error", () => data.destroy());
  process.stdout.on("error", () => data.destroy());
  process.stdin.pipe(data);
  data.pipe(process.stdout, { end: false });
  data.once("close", () => {
    // Give the log connection a moment to deliver its last lines, then flush and leave.
    const leave = (): void => {
      process.stderr.write("", () => process.stdout.write("", () => process.exit(failed ? 1 : 0)));
    };
    if (log.destroyed) leave();
    else {
      log.once("close", leave);
      setTimeout(leave, LOG_DRAIN_MS).unref();
    }
  });
}

main().catch((error: unknown) => {
  fail(`relay cannot connect: ${error instanceof Error ? error.message : String(error)}`);
});
