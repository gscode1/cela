import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ADAPTER = "@gscode1/pi-durable-postgres";

interface Manifest {
  dependencies?: Record<string, string>;
}

describe("Postgres adapter dependency", () => {
  // ADR 0033: a range, a tag, a file path or a git reference would let the adapter change without a
  // reviewed version bump here, and the lockfile integrity would no longer name one published release.
  it("is pinned to one exact published version", { timeout: 10_000 }, () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as Manifest;
    expect(manifest.dependencies?.[ADAPTER]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is locked with a registry integrity hash", { timeout: 10_000 }, () => {
    const lock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const entry = new RegExp(
      `^  '${ADAPTER}@\\d+\\.\\d+\\.\\d+':\\n    resolution: \\{integrity: sha512-[A-Za-z0-9+/=]+\\}`,
      "m",
    );
    expect(lock).toMatch(entry);
  });
});
