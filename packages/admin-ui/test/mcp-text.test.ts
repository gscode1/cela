import { describe, expect, it } from "vitest";
import {
  fromTyped,
  hostOf,
  nonDefaultLimits,
  OUTPUT_FIELD,
  scaledProblem,
  TIMEOUT_FIELD,
  toTyped,
} from "@/lib/api/mcp";
import type { McpHistoryEntry } from "@/lib/api/mcp";
import { describeMcpChange } from "@/lib/mcp-history";

describe("MCP limits for people", () => {
  it("converts between typed seconds or KB and the stored values", () => {
    expect(toTyped(60_000, 1000)).toBe("60");
    expect(toTyped(1_500, 1000)).toBe("1.5");
    expect(fromTyped("1.5", 1000)).toBe(1500);
    expect(fromTyped("24", 1024)).toBe(24_576);
    expect(fromTyped("abc", 1024)).toBeUndefined();
  });

  it("checks the ranges in the units the operator types", () => {
    expect(scaledProblem(TIMEOUT_FIELD, "90")).toBeUndefined();
    expect(scaledProblem(TIMEOUT_FIELD, "301")).toBe("Timeout must be from 1 to 300 seconds");
    expect(scaledProblem(OUTPUT_FIELD, "25")).toBe("Max output must be from 1 to 24 KB");
    expect(scaledProblem(OUTPUT_FIELD, "x")).toMatch(/must be a number/);
  });

  it("mentions a limit only when it is not the default", () => {
    expect(nonDefaultLimits({ timeoutMs: 60_000, maxOutputBytes: 24_576 })).toEqual([]);
    expect(nonDefaultLimits({ timeoutMs: 90_000, maxOutputBytes: 49_152 / 4 })).toEqual([
      { label: "Timeout", value: "90 s" },
      { label: "Max output", value: "12 KB" },
    ]);
  });

  it("shows the host of a URL", () => {
    expect(hostOf("https://mcp.example.com:8443/mcp?x=1")).toBe("mcp.example.com:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });

  it("describes a history entry with field names and units, and leaves onecliSecret out", () => {
    const base = {
      url: "https://a.example.com/mcp",
      enabled: true,
      readOnly: true,
      timeoutMs: 60_000,
      maxOutputBytes: 24_576,
      onecliSecret: null,
    };
    const entry: McpHistoryEntry = {
      id: "1",
      changedAt: "2026-11-17T00:00:00.000Z",
      changedBy: "alice",
      name: "a",
      action: "update",
      old: base,
      new: { ...base, timeoutMs: 90_000, readOnly: false, onecliSecret: "x" },
    };
    expect(describeMcpChange(entry)).toBe(
      "Access: read-only → can change state; Timeout: 60 s → 90 s",
    );
  });
});
