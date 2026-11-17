import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Ingest serves the build under /console/ (packages/ingest/src/console.ts); asset URLs must match.
  base: "/console/",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: {
    // `vite dev` proxies the API to a locally running ingest (see the README of the package).
    proxy: { "/admin": process.env.PI_INGEST_URL ?? "http://127.0.0.1:8080" },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
