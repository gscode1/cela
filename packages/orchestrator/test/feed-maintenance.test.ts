import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeedMaintenanceLoop } from "../src/feed-maintenance.ts";

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    lines.push(String(chunk));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("FeedMaintenanceLoop (ADR 0058)", () => {
  it(
    "prunes, and warns only when an open transaction holds the feed back",
    { timeout: 5_000 },
    async () => {
      let pruned = 0;
      const loop = new FeedMaintenanceLoop({
        prune: () => Promise.resolve((pruned += 3)),
        lagSeconds: () => Promise.resolve(5),
      });
      await loop.run();
      expect(pruned).toBe(3);
      expect(lines.join("")).toContain("feed-pruned");
      expect(lines.join("")).not.toContain("feed-lag");

      const lagging = new FeedMaintenanceLoop({
        prune: () => Promise.resolve(0),
        lagSeconds: () => Promise.resolve(61),
      });
      await lagging.run();
      expect(lines.join("")).toContain("feed-lag");
    },
  );

  it("never throws, so a database hiccup does not end the loop", { timeout: 5_000 }, async () => {
    const loop = new FeedMaintenanceLoop({
      prune: () => Promise.reject(new Error("connection lost")),
      lagSeconds: () => Promise.resolve(0),
    });
    await expect(loop.run()).resolves.toBeUndefined();
    expect(lines.join("")).toContain("feed-maintenance-failed");
  });
});
