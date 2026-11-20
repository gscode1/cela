// Runs in the cluster only: PI_SANDBOX_E2E=1 plus the bridge env contract (see src/config.ts):
//   PI_SANDBOX_CLAIM, PI_SANDBOX_NAMESPACE, PI_SANDBOX_AUTH_TOKEN (if sandboxd needs one),
//   PI_SANDBOX_CONNECTIVITY (default in-cluster-service).
// Build first (`pnpm --filter @cela/sandbox-env build`): the relay runs from dist/.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import { connectSandboxEnv } from "../src/index.ts";

const enabled = process.env.PI_SANDBOX_E2E === "1";

describe.skipIf(!enabled)("sandbox-env e2e", () => {
  const sandbox = connectSandboxEnv({
    claimName: process.env.PI_SANDBOX_CLAIM ?? "",
    namespace: process.env.PI_SANDBOX_NAMESPACE ?? "",
    cwd: "/workspace",
    id: "pi-env:e2e",
    // The broker runs in this process and needs the token; the relay child gets none.
    ...(process.env.PI_SANDBOX_AUTH_TOKEN ? { authToken: process.env.PI_SANDBOX_AUTH_TOKEN } : {}),
    relayCommand: [process.execPath, resolve(import.meta.dirname, "../dist/relay.js")],
  });
  afterAll(() => sandbox.close());

  registerEnvConformance(
    { describe, expect, it },
    "SandboxEnv over commands.start()",
    async (use) => {
      // The cwd must exist inside the sandbox, so a fresh one is made through the env itself.
      const dir = `/workspace/conformance-${randomUUID()}`;
      const made = await sandbox.env.createDir(dir, { recursive: true }, BACKGROUND_CONTEXT);
      expect(made.ok).toBe(true);
      sandbox.env.cwd = dir;
      try {
        await use(sandbox.env);
      } finally {
        sandbox.env.cwd = "/workspace";
        await sandbox.env.remove(dir, { recursive: true, force: true }, BACKGROUND_CONTEXT);
      }
    },
    { listFiles: true },
  );
});
