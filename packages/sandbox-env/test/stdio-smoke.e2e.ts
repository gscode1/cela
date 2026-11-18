// Cluster-only smoke test: 64 MiB of random bytes through commands.start("cat"), SHA-256 round trip.
// Uses the bridge's own sandboxStart, so it exercises the production path (and the SDK stays
// imported by src/sandbox-client.ts only). Run from the runner pod, with the bridge env contract
// from src/config.ts set: node --experimental-strip-types test/stdio-smoke.e2e.ts
import { createHash, randomBytes } from "node:crypto";
import { sandboxStart } from "../src/sandbox-client.ts";

const MIB = 1024 * 1024;
const TOTAL = 64 * MIB;
const authToken = process.env.PI_SANDBOX_AUTH_TOKEN;

const received = createHash("sha256");
let receivedBytes = 0;
const proc = await sandboxStart({
  claimName: process.env.PI_SANDBOX_CLAIM ?? "",
  namespace: process.env.PI_SANDBOX_NAMESPACE ?? "",
  connectivity: "in-cluster-service",
  ...(authToken ? { authToken } : {}),
})("cat", [], {
  onStdout: (chunk) => {
    received.update(chunk);
    receivedBytes += chunk.length;
    return Promise.resolve();
  },
  onStderr: () => Promise.resolve(),
});

const sent = createHash("sha256");
const began = performance.now();
for (let offset = 0; offset < TOTAL; offset += MIB) {
  const chunk = randomBytes(MIB);
  sent.update(chunk);
  await proc.write(chunk);
}
await proc.closeStdin();
const { exitCode } = await proc.wait();
const seconds = (performance.now() - began) / 1000;
await proc.close();

const sentHex = sent.digest("hex");
const receivedHex = received.digest("hex");
const ok = exitCode === 0 && receivedBytes === TOTAL && sentHex === receivedHex;
console.log(
  `smoke: ${ok ? "PASS" : "FAIL"} exit=${String(exitCode)} bytes=${String(receivedBytes)}/${String(TOTAL)} ` +
    `sha256 ${sentHex === receivedHex ? "match" : `mismatch ${sentHex} vs ${receivedHex}`} ` +
    `time=${seconds.toFixed(2)}s round-trip=${(TOTAL / MIB / seconds).toFixed(1)} MiB/s ` +
    `(each direction)`,
);
process.exit(ok ? 0 : 1);
