import { describe, expect, it } from "vitest";
import { isStale, runtimeName, runtimeText, summarizeIsolation } from "@/lib/api/status";
import type { ShardStatus } from "@/lib/api/status";

const shard = (over: Partial<ShardStatus> = {}): ShardStatus => ({
  shard: 0,
  configuredRuntime: "gvisor",
  observedRuntime: "gvisor",
  networkPolicy: "enforced",
  networkPolicyCheckedAt: null,
  networkPolicyDetail: null,
  updatedAt: "2026-11-17T00:00:00.000Z",
  ...over,
});

describe("runtime text", () => {
  it("tells null (not observed) from the empty string (node default)", () => {
    expect(runtimeText(shard({ configuredRuntime: "", observedRuntime: null })).text).toBe(
      "not observed yet",
    );
    expect(runtimeText(shard({ configuredRuntime: "", observedRuntime: "" })).text).toBe(
      "node default",
    );
    expect(runtimeText(shard()).text).toBe("gvisor");
  });

  it("shows both values only on a mismatch", () => {
    const mismatch = runtimeText(shard({ observedRuntime: "" }));
    expect(mismatch).toEqual({ text: "configured gvisor, observed node default", mismatch: true });
    expect(runtimeText(shard()).mismatch).toBe(false);
  });

  it("names runtimes for a sentence", () => {
    expect(runtimeName("gvisor")).toBe("gVisor");
    expect(runtimeName("kata")).toBe("kata");
    expect(runtimeName("")).toBe("the node default runtime");
  });
});

describe("isolation summary", () => {
  it("is healthy only when every shard enforces and runs what is configured", () => {
    expect(summarizeIsolation([shard()])).toMatchObject({ healthy: true, runtimes: ["gvisor"] });
    expect(summarizeIsolation([]).healthy).toBe(false);
  });

  it("names the shard and the problem, but only when there are several shards", () => {
    const one = summarizeIsolation([shard({ networkPolicy: "not-enforced" })]);
    expect(one.problems).toEqual(["network isolation is not enforced."]);
    const two = summarizeIsolation([
      shard(),
      shard({ shard: 1, observedRuntime: "", networkPolicy: "unknown" }),
    ]);
    expect(two.healthy).toBe(false);
    expect(two.problems).toEqual([
      "Shard 1: configured gvisor, observed node default.",
      "Shard 1: network isolation has not been checked since the last start.",
    ]);
  });

  it("treats a running probe as neither healthy nor a problem", () => {
    expect(summarizeIsolation([shard({ networkPolicy: "running" })])).toMatchObject({
      healthy: false,
      checking: true,
      problems: [],
    });
  });

  it("calls a check stale after a day", () => {
    const now = new Date("2026-11-17T12:00:00Z");
    expect(isStale("2026-11-17T00:00:00Z", now)).toBe(false);
    expect(isStale("2026-11-15T00:00:00Z", now)).toBe(true);
  });
});
