import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bridgeRssByClaim,
  claimOfCmdline,
  parentPidOf,
  parseVmRssBytes,
} from "../src/bridge-rss.ts";

const STATUS = (ppid: number, rssKb?: number) =>
  `Name:\tnode\nPPid:\t${String(ppid)}\n${rssKb === undefined ? "" : `VmRSS:\t   ${String(rssKb)} kB\n`}Threads:\t11\n`;

describe("parsing /proc", () => {
  it("reads VmRSS in bytes, and nothing when it is missing", () => {
    expect(parseVmRssBytes(STATUS(1, 102_400))).toBe(102_400 * 1024);
    expect(parseVmRssBytes(STATUS(1))).toBeUndefined();
  });

  it("reads the parent pid", () => {
    expect(parentPidOf(STATUS(42))).toBe(42);
    expect(parentPidOf("Name:\tx\n")).toBeUndefined();
  });

  it("reads the claim from a NUL-separated command line", () => {
    expect(claimOfCmdline("/usr/bin/node\0cli.js\0--claim\0pi-conv-3\0--namespace\0ns\0")).toBe(
      "pi-conv-3",
    );
    expect(claimOfCmdline("/usr/bin/node\0other.js\0")).toBeUndefined();
    expect(claimOfCmdline("node\0--claim\0")).toBeUndefined();
  });
});

describe("bridgeRssByClaim", () => {
  let proc: string;
  beforeEach(async () => {
    proc = await mkdtemp(join(tmpdir(), "proc-"));
  });
  afterEach(async () => {
    await rm(proc, { recursive: true, force: true });
  });

  async function fake(pid: string, status: string, cmdline: string): Promise<void> {
    await mkdir(join(proc, pid));
    await writeFile(join(proc, pid, "status"), status);
    await writeFile(join(proc, pid, "cmdline"), cmdline);
  }

  it("returns the RSS of the parent's bridge children by claim", async () => {
    await fake("100", STATUS(10, 90_000), "node\0cli.js\0--claim\0pi-conv-1\0");
    await fake("101", STATUS(10, 110_000), "node\0cli.js\0--claim\0pi-conv-2\0");
    await fake("102", STATUS(11, 5_000), "node\0cli.js\0--claim\0pi-conv-9\0"); // another parent
    await fake("103", STATUS(10, 5_000), "sh\0-c\0true\0"); // not a bridge
    await fake("104", STATUS(10), "node\0--claim\0pi-conv-4\0"); // no VmRSS
    await mkdir(join(proc, "self"));
    const rss = await bridgeRssByClaim(10, proc);
    expect([...rss]).toEqual([
      ["pi-conv-1", 90_000 * 1024],
      ["pi-conv-2", 110_000 * 1024],
    ]);
  });

  it("is empty when /proc is unavailable", async () => {
    expect((await bridgeRssByClaim(10, join(proc, "missing"))).size).toBe(0);
  });
});
