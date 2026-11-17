import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chartsDir } from "./support/helm.js";

// The values tests/e2e/run.sh gives the pi-durable chart (tests/e2e/chart-values.py) must pass the chart's schema in
// every shape of a run, so a change to either side fails here and not on a cluster.
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
const root = resolve(import.meta.dirname, "../../..");
const digest = `sha256:${"c".repeat(64)}`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-values-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const values = (shards: number, env: Record<string, string> = {}): string => {
  const out = execFileSync(
    "python3",
    [join(root, "tests/e2e/chart-values.py"), "pi-e2e-ab12cd-", String(shards)],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? "",
        ORCH_IMAGE: `ghcr.io/example/pi-orchestrator@${digest}`,
        INGEST_IMAGE: "pi-ingest:0.1.0-abc1234",
        SANDBOX_IMAGE: `registry.example:5000/team/pi-sandbox:t@${digest}`,
        ...env,
      },
    },
  );
  const file = join(dir, "values.json");
  writeFileSync(file, out);
  return file;
};
const render = (file: string): string =>
  execFileSync("helm", ["template", "rel", join(chartsDir, "pi-durable"), "-n", "ns", "-f", file], {
    encoding: "utf8",
    timeout: 60_000,
  });

describe("tests/e2e/chart-values.py", () => {
  it("renders through the chart for one and two shards", () => {
    for (const shards of [1, 2]) {
      const text = render(values(shards));
      expect(text.match(/kind: Deployment/g)).toHaveLength(shards + 1);
      expect(text).toContain('value: "http://onecli.onecli:10255"');
      expect(text).toContain("pi-e2e-ab12cd-");
    }
  });

  it("splits image references into repository, tag and digest", () => {
    const parsed = JSON.parse(readFileSync(values(1), "utf8"));
    expect(parsed.images.orchestrator).toEqual({
      repository: "ghcr.io/example/pi-orchestrator",
      tag: "",
      digest,
    });
    expect(parsed.images.ingest).toEqual({
      repository: "pi-ingest",
      tag: "0.1.0-abc1234",
      digest: "",
    });
    // A registry port is not a tag.
    expect(parsed.images.sandbox).toEqual({
      repository: "registry.example:5000/team/pi-sandbox",
      tag: "t",
      digest,
    });
  });

  it("sets the workspace storage class from SANDBOX_STORAGE_CLASS, else STORAGE_CLASS, else leaves the default", () => {
    const sc = (env: Record<string, string>) =>
      JSON.parse(readFileSync(values(1, env), "utf8")).sandbox.storageClass;
    expect(sc({})).toBe("");
    expect(sc({ STORAGE_CLASS: "data" })).toBe("data");
    expect(sc({ STORAGE_CLASS: "data", SANDBOX_STORAGE_CLASS: "scratch" })).toBe("scratch");
  });

  it("adds database.tls only with DB_TLS=1, and the chart renders it", () => {
    expect(JSON.parse(readFileSync(values(1), "utf8")).database.tls).toBeUndefined();
    expect(
      JSON.parse(readFileSync(values(1, { DB_TLS: "0" }), "utf8")).database.tls,
    ).toBeUndefined();
    const file = values(1, { DB_TLS: "1" });
    expect(JSON.parse(readFileSync(file, "utf8")).database.tls).toEqual({
      mode: "verify-full",
      existingSecret: "pi-db-tls-ca",
      caKey: "ca.crt",
    });
    const text = render(file);
    expect(text).toContain("PI_DURABLE_DATABASE_TLS_MODE");
    expect(text).toContain("pi-db-tls-ca");
  });

  it("refuses an image without a tag or a digest", () => {
    expect(() => values(1, { ORCH_IMAGE: "pi-orchestrator" })).toThrow();
  });
});
