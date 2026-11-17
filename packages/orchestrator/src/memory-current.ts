import { readFile } from "node:fs/promises";

export interface MemorySample {
  bytes: number;
  /** `cgroup` counts the whole container, relays included; `rss` is this process alone (no cgroup file readable). */
  source: "cgroup" | "rss";
}

/** cgroup v2 first, then v1. */
const CGROUP_FILES = [
  "/sys/fs/cgroup/memory.current",
  "/sys/fs/cgroup/memory/memory.usage_in_bytes",
] as const;

/** Container memory in use, for fitting a base and a per-bridge slope (docs/metrics.md). Never throws. */
export async function readMemoryCurrent(
  files: readonly string[] = CGROUP_FILES,
): Promise<MemorySample> {
  for (const file of files) {
    try {
      const bytes = Number((await readFile(file, "utf8")).trim());
      if (Number.isFinite(bytes) && bytes > 0) return { bytes, source: "cgroup" };
    } catch {
      // Not this cgroup version, or not Linux.
    }
  }
  return { bytes: process.memoryUsage.rss(), source: "rss" };
}
