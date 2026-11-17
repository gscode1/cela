import { readFile } from "node:fs/promises";

export interface MemorySample {
  bytes: number;
  /** `cgroup` counts the whole container, relays included; `rss` is this process alone (no cgroup file readable). */
  source: "cgroup" | "rss";
}

const ROOT = "/sys/fs/cgroup";

/**
 * The memory files of this process's own cgroup, from the text of /proc/self/cgroup, in the order to try. The mount
 * at /sys/fs/cgroup is not always rooted at our cgroup: with a host cgroup namespace it is the host tree, and its root
 * file would count every workload on the node. So the root file is used only where it is ours: cgroup v2 with path
 * "/" (a private namespace), or cgroup v1 as a fallback, because runtimes bind-mount the container's own cgroup at the
 * controller root while /proc/self/cgroup still shows the host path.
 */
export function cgroupMemoryFiles(procSelfCgroup: string): string[] {
  const lines = procSelfCgroup.split("\n").filter((line) => line.length > 0);
  const v2 = lines.find((line) => line.startsWith("0::"));
  if (v2 !== undefined) {
    const path = v2.slice(3);
    return path === "/" ? [`${ROOT}/memory.current`] : [`${ROOT}${path}/memory.current`];
  }
  for (const line of lines) {
    const [, controllers = "", path = ""] = line.split(":");
    if (!controllers.split(",").includes("memory")) continue;
    const root = `${ROOT}/memory/memory.usage_in_bytes`;
    return path === "/" ? [root] : [`${ROOT}/memory${path}/memory.usage_in_bytes`, root];
  }
  return [];
}

async function ownCgroupFiles(): Promise<string[]> {
  try {
    return cgroupMemoryFiles(await readFile("/proc/self/cgroup", "utf8"));
  } catch {
    return []; // Not Linux.
  }
}

/** Container memory in use, for fitting a base and a per-bridge slope (docs/metrics.md). Never throws. */
export async function readMemoryCurrent(files?: readonly string[]): Promise<MemorySample> {
  for (const file of files ?? (await ownCgroupFiles())) {
    try {
      const bytes = Number((await readFile(file, "utf8")).trim());
      if (Number.isFinite(bytes) && bytes > 0) return { bytes, source: "cgroup" };
    } catch {
      // Not this file; try the next.
    }
  }
  return { bytes: process.memoryUsage.rss(), source: "rss" };
}
