import { describe, expect, it } from "vitest";
import { fieldLabel } from "@/lib/field-labels";
import { formatTime } from "@/lib/time";

describe("formatTime", () => {
  const now = new Date("2026-11-17T12:00:00Z");
  it("is relative within a day", () => {
    expect(formatTime("2026-11-17T11:59:50Z", now)).toBe("just now");
    expect(formatTime("2026-11-17T11:55:00Z", now)).toBe("5 min ago");
    expect(formatTime("2026-11-17T09:00:00Z", now)).toBe("3 h ago");
  });
  it("is a local date after a day and keeps unparsable input", () => {
    expect(formatTime("2026-11-10T12:00:00Z", now)).not.toContain("ago");
    expect(formatTime("not a time", now)).toBe("not a time");
  });
});

describe("fieldLabel", () => {
  it("names known fields and falls back to the key", () => {
    expect(fieldLabel("defaultModel")).toBe("Default model");
    expect(fieldLabel("somethingNew")).toBe("somethingNew");
  });
});
