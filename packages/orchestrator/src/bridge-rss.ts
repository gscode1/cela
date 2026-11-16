import { readFile, readdir } from "node:fs/promises";

/** `VmRSS` of a `/proc/<pid>/status` text, in bytes; undefined when the line is missing (a kernel thread, a non-Linux file). */
export function parseVmRssBytes(status: string): number | undefined {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  return match?.[1] === undefined ? undefined : Number(match[1]) * 1024;
}

/** The value after `--claim` in a `/proc/<pid>/cmdline` (NUL-separated), which is how a relay (since ADR 0016, the process pi-env spawns per env) names its sandbox. */
export function claimOfCmdline(cmdline: string): string | undefined {
  const args = cmdline.split("\0");
  const at = args.indexOf("--claim");
  const claim = at < 0 ? undefined : args[at + 1];
  return claim === undefined || claim === "" ? undefined : claim;
}

/** Parent pid from a `/proc/<pid>/status` text. */
export function parentPidOf(status: string): number | undefined {
  const match = /^PPid:\s+(\d+)$/m.exec(status);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * RSS in bytes of every relay process that is a child of `parent`, by claim name. Linux only: elsewhere `/proc` is
 * missing and the result is empty. pi-env does not expose the child's pid, so relays are found by their command line;
 * `bridgeCommand` execs the relay directly, so the child is the relay itself.
 */
export async function bridgeRssByClaim(
  parent: number = process.pid,
  proc = "/proc",
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  let entries: string[];
  try {
    entries = await readdir(proc);
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = await readFile(`${proc}/${entry}/status`, "utf8");
      if (parentPidOf(status) !== parent) continue;
      const claim = claimOfCmdline(await readFile(`${proc}/${entry}/cmdline`, "utf8"));
      const rss = parseVmRssBytes(status);
      if (claim !== undefined && rss !== undefined) result.set(claim, rss);
    } catch {
      // The process exited between the listing and the read.
    }
  }
  return result;
}
