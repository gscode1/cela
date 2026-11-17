import { describe, expect, it } from "vitest";
import {
  BASE_RESERVE_BYTES,
  PER_BRIDGE_BYTES,
  bridgeCapFields,
  capField,
  memoryLimitBytes,
  resolveBridgeCap,
} from "../src/bridge-cap.ts";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

describe("resolveBridgeCap", () => {
  it("derives (limit - 256 MiB) / 24 MiB, rounded down, for unset and auto", () => {
    const table: [number, number][] = [
      [512 * MIB, 10],
      [GIB, 32],
      [2 * GIB, 74],
      [4 * GIB, 160],
      [8 * GIB, 330],
    ];
    for (const [limit, max] of table) {
      for (const setting of [undefined, "auto"])
        expect(resolveBridgeCap(setting, limit)).toEqual({ max, source: "derived" });
    }
  });

  it("keeps one slot when the limit is at or below the reserve", () => {
    for (const limit of [BASE_RESERVE_BYTES, BASE_RESERVE_BYTES + PER_BRIDGE_BYTES - 1, 64 * MIB])
      expect(resolveBridgeCap(undefined, limit)).toEqual({ max: 1, source: "derived" });
  });

  it("is unlimited with no memory limit", () => {
    expect(resolveBridgeCap(undefined, undefined)).toEqual({ max: Infinity, source: "unlimited" });
    expect(resolveBridgeCap("auto", undefined)).toEqual({ max: Infinity, source: "unlimited" });
  });

  it("takes 0 as unlimited and a whole number as given, whatever the limit", () => {
    expect(resolveBridgeCap("0", 2 * GIB)).toEqual({ max: Infinity, source: "unlimited" });
    expect(resolveBridgeCap("7", 2 * GIB)).toEqual({ max: 7, source: "explicit" });
    expect(resolveBridgeCap("500", undefined)).toEqual({ max: 500, source: "explicit" });
  });

  it("refuses anything else", () => {
    for (const bad of ["-1", "1.5", "many", "", " 3", "0x10", "1e3", "Auto", "9".repeat(20)])
      expect(() => resolveBridgeCap(bad, GIB)).toThrow(/PI_MAX_OPEN_BRIDGES/);
  });
});

describe("memoryLimitBytes", () => {
  it("treats 0, undefined and the kernel's 'unset' values as no limit", () => {
    for (const none of [0, undefined, -1, NaN, Infinity, 2 ** 63, 2 ** 64 - 1, 9223372036854771712])
      expect(memoryLimitBytes(none)).toBeUndefined();
  });

  it("keeps a real limit", () => {
    expect(memoryLimitBytes(2 * GIB)).toBe(2 * GIB);
    expect(memoryLimitBytes(1024 * GIB)).toBe(1024 * GIB);
  });
});

describe("bridge-cap log fields", () => {
  it("serialises an unlimited cap and warns only when there is no limit", () => {
    expect(capField(Infinity)).toBe("unlimited");
    expect(capField(74)).toBe(74);
    const none = bridgeCapFields(Infinity, "unlimited", undefined);
    expect(none).toMatchObject({ level: "warn", max: "unlimited", memoryLimitBytes: null });
    const chosen = bridgeCapFields(Infinity, "unlimited", 2 * GIB);
    expect(chosen).not.toHaveProperty("level");
    expect(bridgeCapFields(74, "derived", 2 * GIB)).toEqual({
      max: 74,
      source: "derived",
      memoryLimitBytes: 2 * GIB,
      reserveBytes: BASE_RESERVE_BYTES,
      perBridgeBytes: PER_BRIDGE_BYTES,
    });
  });
});
