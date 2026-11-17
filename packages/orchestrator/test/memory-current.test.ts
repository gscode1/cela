import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readMemoryCurrent } from "../src/memory-current.ts";

describe("readMemoryCurrent", () => {
  it("reads the first cgroup file that holds a number", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mem-"));
    const v1 = join(dir, "usage");
    await writeFile(v1, "123456\n");
    expect(await readMemoryCurrent([join(dir, "missing"), v1])).toEqual({
      bytes: 123456,
      source: "cgroup",
    });
  });

  it("falls back to this process's RSS and says so", async () => {
    const sample = await readMemoryCurrent(["/nonexistent/memory.current"]);
    expect(sample.source).toBe("rss");
    expect(sample.bytes).toBeGreaterThan(0);
  });
});
