import { defineConfig } from "@playwright/test";

/**
 * The same specs against two local ingest servers on a fake in-memory settings table (e2e/local-server.mjs): one
 * with the console, one without. Needs `pnpm build` first (admin-ui and ingest) and a Chromium
 * (`pnpm exec playwright install chromium`). Ports are fixed and local to this config; change them with
 * CONSOLE_LOCAL_PORT and CONSOLE_LOCAL_OFF_PORT if they clash.
 */
const on = Number(process.env.CONSOLE_LOCAL_PORT ?? 18480);
const off = Number(process.env.CONSOLE_LOCAL_OFF_PORT ?? 18481);
process.env.CONSOLE_ADMIN_TOKEN = "local-admin-token";
process.env.CONSOLE_NONADMIN_TOKEN = "local-owner-token";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  webServer: [
    {
      command: "node e2e/local-server.mjs",
      env: { PORT: String(on), WITH_CONSOLE: "1" },
      url: `http://127.0.0.1:${String(on)}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: "node e2e/local-server.mjs",
      env: { PORT: String(off), WITH_CONSOLE: "0" },
      url: `http://127.0.0.1:${String(off)}/healthz`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "enabled",
      testMatch: "console.spec.ts",
      use: { baseURL: `http://127.0.0.1:${String(on)}`, trace: "retain-on-failure" },
    },
    {
      name: "disabled",
      testMatch: "console-disabled.spec.ts",
      use: { baseURL: `http://127.0.0.1:${String(off)}` },
    },
  ],
});
