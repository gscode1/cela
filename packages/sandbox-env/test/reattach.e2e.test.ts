// Cluster-only, driven in phases by tests/e2e/run-phase1.sh (PI_SANDBOX_E2E=1 plus the bridge env
// contract, see src/config.ts). Each phase is a separate process, because the point is that a fresh
// runner reattaches to the claim by name:
//   PI_E2E_PHASE=write  write a marker file through the env, then exit
//   PI_E2E_PHASE=read   (fresh runner) read the marker back
//   PI_E2E_PHASE=after-pod-loss  (Pod was deleted and recreated) probe until the env works, read the marker
// PI_E2E_RUN_ID names the marker so reruns never see each other's files.
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import { connectSandboxEnv } from "../src/index.ts";

const enabled = process.env.PI_SANDBOX_E2E === "1";
const phase = process.env.PI_E2E_PHASE ?? "";
const runId = process.env.PI_E2E_RUN_ID ?? "manual";
const marker = `/workspace/e2e-reattach-${runId}.txt`;
const content = `reattach-marker ${runId}\n`;

describe.skipIf(!enabled)("sandbox-env reattach", () => {
  const sandbox = connectSandboxEnv({
    claimName: process.env.PI_SANDBOX_CLAIM ?? "",
    namespace: process.env.PI_SANDBOX_NAMESPACE ?? "",
    cwd: "/workspace",
    id: "pi-env:reattach",
    bridgeCommand: [process.execPath, resolve(import.meta.dirname, "../dist/cli.js")],
  });
  afterAll(() => sandbox.close());

  it.runIf(phase === "write")("writes a file through the env", async () => {
    const written = await sandbox.env.writeFile(marker, content, BACKGROUND_CONTEXT);
    expect(written.ok).toBe(true);
  });

  it.runIf(phase === "read")("reads the file back from a fresh runner", async () => {
    const read = await sandbox.env.readTextFile(marker, BACKGROUND_CONTEXT);
    expect(read).toEqual({ ok: true, value: content });
  });

  // Timeout covers the worst case DNS staleness plus a cold bridge start on every attempt.
  it.runIf(phase === "after-pod-loss")(
    "works again after the Pod was recreated, with the PVC intact",
    async () => {
      const started = performance.now();
      const log: string[] = [];
      let readBack: string | undefined;
      for (let attempt = 1; attempt <= 40 && readBack === undefined; attempt++) {
        const t0 = performance.now();
        const read = await sandbox.env.readTextFile(marker, BACKGROUND_CONTEXT);
        const ms = Math.round(performance.now() - t0);
        const at = Math.round((performance.now() - started) / 100) / 10;
        if (read.ok) readBack = read.value;
        log.push(
          `attempt ${String(attempt)} at +${String(at)}s took ${String(ms)}ms: ${read.ok ? "ok" : String(read.error)}`,
        );
        if (!read.ok) await new Promise((r) => setTimeout(r, 1000));
      }
      // The observation phase1 asks for: did the first call fail, how long until it worked.
      console.log(`DNS-STALENESS ${log.join(" | ")}`);
      expect(readBack).toBe(content);
    },
    180_000,
  );
});
