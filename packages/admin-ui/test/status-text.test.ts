import { describe, expect, it } from "vitest";
import { runtimeName, runtimeText, statusPollInterval } from "@/lib/api/status";
import type { ShardStatus } from "@/lib/api/status";

const shard = (over: Partial<ShardStatus> = {}): ShardStatus => ({
  shard: 0,
  configuredRuntime: "gvisor",
  observedRuntime: "gvisor",
  networkPolicy: "enforced",
  networkPolicyCheckedAt: null,
  networkPolicyDetail: null,
  probeRequestedAt: null,
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

describe("status polling", () => {
  it("polls while a probe runs or a request waits for shard 0, and stops after", () => {
    expect(statusPollInterval(undefined)).toBe(false);
    expect(statusPollInterval([shard()])).toBe(false);
    expect(statusPollInterval([shard({ networkPolicy: "running" })])).toBe(3_000);
    // Re-check asked: the state is still the old verdict until the orchestrator takes the request.
    const asked = [shard({ probeRequestedAt: "2026-11-18T00:00:00.000Z" })];
    expect(statusPollInterval(asked)).toBe(3_000);
  });
});
