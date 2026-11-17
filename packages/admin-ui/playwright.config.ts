import { defineConfig } from "@playwright/test";

/**
 * The console suite against a deployed ingest (tests/e2e/run.sh console, which port-forwards it):
 *   CONSOLE_BASE_URL, CONSOLE_ADMIN_TOKEN, CONSOLE_NONADMIN_TOKEN, and CONSOLE_EXPECT=enabled|disabled (default enabled).
 * Not part of `pnpm check`: it needs a browser (`pnpm exec playwright install chromium`).
 */
const disabled = process.env.CONSOLE_EXPECT === "disabled";

export default defineConfig({
  testDir: "e2e",
  testMatch: disabled ? "console-disabled.spec.ts" : "console.spec.ts",
  timeout: 30_000,
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: process.env.CONSOLE_BASE_URL, trace: "retain-on-failure" },
});
