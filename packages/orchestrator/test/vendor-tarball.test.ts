import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const vendorDir = new URL("../../../vendor/", import.meta.url);

describe("vendored Postgres adapter", () => {
  it("matches the sha256 recorded in vendor/README.md", { timeout: 10_000 }, () => {
    const readme = readFileSync(new URL("README.md", vendorDir), "utf8");
    const recorded = /^sha256: `([0-9a-f]{64})`$/m.exec(readme)?.[1];
    expect(recorded, "vendor/README.md has no 'sha256: `<hex>`' line").toBeDefined();
    const actual = createHash("sha256")
      .update(readFileSync(new URL("netzlabor-pi-durable-postgres-0.2.0.tgz", vendorDir)))
      .digest("hex");
    expect(actual).toBe(recorded);
  });
});
