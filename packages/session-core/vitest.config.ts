import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Feed visibility uses the cluster-wide snapshot xmin: migrations in another test database can hold it back.
    fileParallelism: process.env.CELA_TEST_DATABASE_URL === undefined,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
