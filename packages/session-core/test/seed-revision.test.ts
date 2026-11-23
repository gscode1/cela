import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const DIR = new URL("../migrations/", import.meta.url);
/** The migration that added `revision` to inbox.profiles (ADR 0023); earlier files predate the column. */
const REVISIONS_ADDED = "017_revisions_and_source.sql";
/** 034 shipped without the bump; 037 repairs it and the file stays as written (migrations are append-only). */
const KNOWN_UNBUMPED = new Set(["034_coding_packages.sql"]);

/** A seed migration that moves a profile to a new version is a write that changes something (ADR 0023). */
describe("seed migrations that set a profile's current_version", () => {
  it("also bump revision, so the lost-update guard sees the change", async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".sql")).sort();
    const offenders: string[] = [];
    for (const file of files) {
      if (file <= REVISIONS_ADDED || KNOWN_UNBUMPED.has(file)) continue;
      const sql = (await readFile(new URL(file, DIR), "utf8")).replace(/--.*$/gm, "");
      for (const stmt of sql.split(";")) {
        if (!/\bupdate\s+inbox\.profiles\b/i.test(stmt) || !/\bcurrent_version\s*=/i.test(stmt))
          continue;
        if (!/\brevision\s*=\s*revision\s*\+\s*1\b/i.test(stmt)) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  }, 10_000);

  it("keeps the known exception list to migration 034 and its repair in place", async () => {
    const files = await readdir(DIR);
    expect(files).toContain("037_coding_revision_bump.sql");
    expect(KNOWN_UNBUMPED.size).toBe(1);
  }, 10_000);
});
