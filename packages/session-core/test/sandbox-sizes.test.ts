import { describe, expect, it } from "vitest";
import { chooseSandboxSize, parseSandboxSizes } from "../src/index.ts";
import type { SandboxSizes } from "../src/index.ts";

const SIZES = JSON.stringify({
  s: {
    resources: {
      requests: { cpu: "100m", memory: "128Mi" },
      limits: { cpu: "250m", memory: "256Mi" },
    },
    workspaceSize: "1Gi",
    ephemeralStorage: "1Gi",
    warmPoolReplicas: 0,
  },
  l: {
    resources: { requests: { cpu: 1, memory: "2Gi" }, limits: { cpu: 2, memory: "4Gi" } },
    workspaceSize: "10Gi",
    ephemeralStorage: "4Gi",
    warmPoolReplicas: 1,
  },
});

describe("parseSandboxSizes", () => {
  it("reads the chart's JSON, sorted by name, numbers as quantities", () => {
    expect(parseSandboxSizes({ PI_SANDBOX_SIZES: SIZES, PI_SANDBOX_DEFAULT_SIZE: "s" })).toEqual({
      defaultSize: "s",
      sizes: [
        {
          name: "l",
          requests: { cpu: "1", memory: "2Gi" },
          limits: { cpu: "2", memory: "4Gi" },
          workspaceSize: "10Gi",
          ephemeralStorage: "4Gi",
        },
        {
          name: "s",
          requests: { cpu: "100m", memory: "128Mi" },
          limits: { cpu: "250m", memory: "256Mi" },
          workspaceSize: "1Gi",
          ephemeralStorage: "1Gi",
        },
      ],
    });
  });

  it("is undefined when neither variable is set: a deployment without sizes", () => {
    expect(parseSandboxSizes({})).toBeUndefined();
  });

  it.each([
    [{ PI_SANDBOX_SIZES: SIZES }, "set together"],
    [{ PI_SANDBOX_DEFAULT_SIZE: "s" }, "set together"],
    [{ PI_SANDBOX_SIZES: "{", PI_SANDBOX_DEFAULT_SIZE: "s" }, "JSON object"],
    [{ PI_SANDBOX_SIZES: "[]", PI_SANDBOX_DEFAULT_SIZE: "s" }, "JSON object"],
    [{ PI_SANDBOX_SIZES: "{}", PI_SANDBOX_DEFAULT_SIZE: "s" }, "at least one"],
    [{ PI_SANDBOX_SIZES: '{"Big":{}}', PI_SANDBOX_DEFAULT_SIZE: "Big" }, "not a size name"],
    [{ PI_SANDBOX_SIZES: SIZES, PI_SANDBOX_DEFAULT_SIZE: "m" }, "is not one of"],
  ])("refuses %j", (env, message) => {
    expect(() => parseSandboxSizes(env)).toThrow(message);
  });
});

describe("chooseSandboxSize", () => {
  const sizes: SandboxSizes = {
    defaultSize: "s",
    sizes: ["l", "m", "s"].map((name) => ({
      name,
      requests: {},
      limits: {},
      workspaceSize: "1Gi",
      ephemeralStorage: "1Gi",
    })),
  };

  it("takes the request, else the profile's size, else the deployment default", () => {
    expect(chooseSandboxSize(sizes, {}, undefined)).toEqual({ size: "s" });
    expect(chooseSandboxSize(sizes, { sandboxSize: "m" }, undefined)).toEqual({ size: "m" });
    expect(chooseSandboxSize(sizes, { sandboxSizes: ["l"] }, "l")).toEqual({ size: "l" });
  });

  it("lets a caller ask only for the profile's default or one of its sandboxSizes", () => {
    expect(chooseSandboxSize(sizes, {}, "s")).toEqual({ size: "s" });
    expect(chooseSandboxSize(sizes, {}, "l")).toEqual({
      error: 'sandboxSize "l" is not allowed by the profile (allowed: s)',
    });
    expect(chooseSandboxSize(sizes, { sandboxSize: "m", sandboxSizes: ["l"] }, "s")).toEqual({
      error: 'sandboxSize "s" is not allowed by the profile (allowed: l, m)',
    });
  });

  it("refuses a size this deployment does not define, also one the profile names", () => {
    expect(chooseSandboxSize(sizes, { sandboxSize: "xl" }, undefined)).toEqual({
      error: 'sandboxSize "xl" is not defined in this deployment',
    });
    expect(chooseSandboxSize(sizes, { sandboxSizes: ["xxl"] }, "xxl")).toEqual({
      error: 'sandboxSize "xxl" is not defined in this deployment',
    });
  });

  it("refuses a request that is not a size name", () => {
    for (const bad of [3, "", "Big", null]) {
      expect(chooseSandboxSize(sizes, {}, bad)).toEqual({
        error: "sandboxSize must be a size name",
      });
    }
  });

  it("without sizes gives no size, and refuses anything that asks for one", () => {
    expect(chooseSandboxSize(undefined, {}, undefined)).toEqual({ size: null });
    expect(chooseSandboxSize(undefined, {}, "s")).toEqual({
      error: "this deployment defines no sandbox sizes",
    });
    expect(chooseSandboxSize(undefined, { sandboxSize: "s" }, undefined)).toEqual({
      error: "this deployment defines no sandbox sizes",
    });
  });
});
