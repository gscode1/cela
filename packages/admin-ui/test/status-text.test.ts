import { describe, expect, it } from "vitest";
import { configuredRuntimeText, observedRuntimeText } from "@/lib/api/status";

describe("runtime text", () => {
  it("tells null (not observed) from the empty string (node default)", () => {
    expect(observedRuntimeText(null)).toBe("not observed yet");
    expect(observedRuntimeText("")).toBe("node default (no runtimeClassName)");
    expect(observedRuntimeText("gvisor")).toBe("gvisor");
    expect(observedRuntimeText(null)).not.toBe(observedRuntimeText(""));
    expect(configuredRuntimeText("")).toBe("none set (node default)");
  });
});
