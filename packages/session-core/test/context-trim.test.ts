import { describe, expect, it } from "vitest";
import {
  CONTEXT_TRIMS,
  contextTrimOf,
  defaultContextTrim,
  isContextTrim,
  validateProfileDefinition,
} from "../src/index.js";

describe("contextTrim (docs/decisions/0067-trim-context.md)", () => {
  it("is off, images or full, and nothing else", { timeout: 5_000 }, () => {
    expect([...CONTEXT_TRIMS]).toEqual(["off", "images", "full"]);
    expect(isContextTrim("images")).toBe(true);
    expect(isContextTrim("all")).toBe(false);
    expect(isContextTrim(true)).toBe(false);
  });

  it("is valid in a profile definition and refused when unknown", { timeout: 5_000 }, () => {
    for (const value of CONTEXT_TRIMS) {
      expect(validateProfileDefinition({ contextTrim: value })).toEqual({ contextTrim: value });
    }
    const message = "contextTrim must be one of off, images, full";
    expect(validateProfileDefinition({ contextTrim: "most" })).toBe(message);
    expect(validateProfileDefinition({ contextTrim: 1 })).toBe(message);
  });

  it("defaults to images", { timeout: 5_000 }, () => {
    expect(defaultContextTrim()).toBe("images");
  });

  it("takes the profile's own value over the default of the flavour", { timeout: 5_000 }, () => {
    expect(contextTrimOf({})).toBe("images");
    expect(contextTrimOf(undefined)).toBe("images");
    expect(contextTrimOf({ contextTrim: "off" })).toBe("off");
    expect(contextTrimOf({ contextTrim: "full" })).toBe("full");
  });
});
