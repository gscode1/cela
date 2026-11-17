import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cgroupMemoryFiles, readMemoryCurrent } from "../src/memory-current.ts";

describe("cgroupMemoryFiles", () => {
  it("reads the root file under a private cgroup v2 namespace", () => {
    expect(cgroupMemoryFiles("0::/\n")).toEqual(["/sys/fs/cgroup/memory.current"]);
  });

  it("reads this process's own cgroup, never the root, when the host v2 tree is visible", () => {
    expect(cgroupMemoryFiles("0::/kubepods.slice/pod1/cri-abc.scope\n")).toEqual([
      "/sys/fs/cgroup/kubepods.slice/pod1/cri-abc.scope/memory.current",
    ]);
  });

  it("tries the v1 memory controller path, then the controller root a runtime mounts for the container", () => {
    const text = "12:cpu,cpuacct:/kubepods/pod1/abc\n9:memory:/kubepods/pod1/abc\n";
    expect(cgroupMemoryFiles(text)).toEqual([
      "/sys/fs/cgroup/memory/kubepods/pod1/abc/memory.usage_in_bytes",
      "/sys/fs/cgroup/memory/memory.usage_in_bytes",
    ]);
  });

  it("prefers the v1 memory controller on a hybrid host", () => {
    const text = "9:memory:/\n0::/kubepods/pod1/abc\n";
    expect(cgroupMemoryFiles(text)).toEqual(["/sys/fs/cgroup/memory/memory.usage_in_bytes"]);
  });

  it("finds nothing without a memory controller", () => {
    expect(cgroupMemoryFiles("")).toEqual([]);
    expect(cgroupMemoryFiles("3:cpu:/x\n")).toEqual([]);
  });
});

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
