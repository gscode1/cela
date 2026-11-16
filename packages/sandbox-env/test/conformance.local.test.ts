import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Connection, RemoteExecutionEnv, localDaemon } from "@earendil-works/pi-env";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { connectSandboxEnv } from "../src/index.ts";
import { localStart } from "./local-start.ts";

// Baseline: pi-env's own darwin/linux daemon, straight and through our bridge (with a local
// process standing in for sandboxd). A failure in the second but not the first points at the bridge.
const variants: [string, readonly string[]][] = [
  ["local pi-env daemon", [localDaemon()]],
  [
    "local pi-env daemon through the bridge",
    [process.execPath, resolve(import.meta.dirname, "local-bridge.ts")],
  ],
];

// The production path: the in-process broker plus the relay that pi-env's Connection spawns, with a local process
// standing in for sandboxd.
const brokered = connectSandboxEnv({
  claimName: "pi-conv-conformance",
  namespace: "test",
  cwd: tmpdir(),
  id: "pi-env:local-broker",
  relayCommand: [process.execPath, resolve(import.meta.dirname, "../src/relay.ts")],
  startProcess: localStart(),
  envBinary: localDaemon(),
});
afterAll(() => brokered.close());

const connections: [string, Connection][] = [
  ...variants.map(([name, command]): [string, Connection] => [name, new Connection({ command })]),
  ["local pi-env daemon through the broker and relay", brokered.connection],
];

for (const [name, connection] of connections) {
  afterAll(() => connection.close());
  registerEnvConformance(
    { describe, expect, it },
    name,
    async (use) => {
      const cwd = mkdtempSync(join(tmpdir(), "sandbox-env-local-"));
      try {
        await use(
          new RemoteExecutionEnv({
            connection,
            id: "pi-env:local",
            cwd,
            watch: { pollIntervalMs: 100 },
          }),
        );
      } finally {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
    { listFiles: true },
  );
}
