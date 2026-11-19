import { defineConfig } from "@playwright/test";

/**
 * The same specs against local ingest servers on session-core's in-memory fake database (e2e/local-server.mjs):
 * one with the console, one without, and two with the in-memory catalog fake in front (e2e/fake-admin.mjs), one in
 * `console.catalogs: manage` and one in `readOnly` mode. The catalog specs and the playground spec (the fake scripts the session API too) run on those two only. Needs `pnpm build` first (admin-ui and ingest) and a Chromium
 * (`pnpm exec playwright install chromium`). Ports are fixed and local to this config; change them with
 * CONSOLE_LOCAL_PORT and CONSOLE_LOCAL_OFF_PORT if they clash.
 */
const on = Number(process.env.CONSOLE_LOCAL_PORT ?? 18480);
const off = Number(process.env.CONSOLE_LOCAL_OFF_PORT ?? 18481);
const catalogs = Number(process.env.CONSOLE_LOCAL_CATALOGS_PORT ?? 18483);
const readOnly = Number(process.env.CONSOLE_LOCAL_READONLY_PORT ?? 18482);
process.env.CONSOLE_ADMIN_TOKEN = "local-admin-token";
process.env.CONSOLE_NONADMIN_TOKEN = "local-owner-token";

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  // The specs share one fake database and some of them change global settings.
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  webServer: [
    {
      command: "node --disable-warning=ExperimentalWarning e2e/local-server.mjs",
      env: { PORT: String(on), WITH_CONSOLE: "1" },
      url: `http://127.0.0.1:${String(on)}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: "node --disable-warning=ExperimentalWarning e2e/local-server.mjs",
      env: { PORT: String(off), WITH_CONSOLE: "0" },
      url: `http://127.0.0.1:${String(off)}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: "node --disable-warning=ExperimentalWarning e2e/local-server.mjs",
      env: { PORT: String(catalogs), WITH_CONSOLE: "1", FAKE_ADMIN: "1" },
      url: `http://127.0.0.1:${String(catalogs)}/healthz`,
      reuseExistingServer: false,
    },
    {
      command: "node --disable-warning=ExperimentalWarning e2e/local-server.mjs",
      env: { PORT: String(readOnly), WITH_CONSOLE: "1", CATALOGS: "readOnly", FAKE_ADMIN: "1" },
      url: `http://127.0.0.1:${String(readOnly)}/healthz`,
      reuseExistingServer: false,
    },
  ],
  projects: [
    {
      name: "catalogs",
      testMatch: ["catalogs.spec.ts", "playground.spec.ts", "status.spec.ts"],
      use: { baseURL: `http://127.0.0.1:${String(catalogs)}`, trace: "retain-on-failure" },
    },
    {
      name: "catalogs-readonly",
      testMatch: "catalogs-readonly.spec.ts",
      use: { baseURL: `http://127.0.0.1:${String(readOnly)}`, trace: "retain-on-failure" },
    },
    {
      name: "enabled",
      testMatch: ["console.spec.ts", "settings.spec.ts", "profiles.spec.ts"],
      use: { baseURL: `http://127.0.0.1:${String(on)}`, trace: "retain-on-failure" },
    },
    {
      name: "disabled",
      testMatch: "console-disabled.spec.ts",
      use: { baseURL: `http://127.0.0.1:${String(off)}` },
    },
  ],
});
