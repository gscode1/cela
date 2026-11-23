import { describe, expect, it } from "vitest";
import {
  checkProfileNames,
  parseSandboxRuntimes,
  sandboxRuntimeConflict,
  sandboxRuntimeOf,
  validateProfileDefinition,
} from "../src/index.js";
import type { SandboxRuntimes } from "../src/index.js";

const runtimes: SandboxRuntimes = {
  gvisorkvm: { runtimeClassName: "gvisor-kvm", insecure: false, flavours: ["default", "browser"] },
  runc: { runtimeClassName: "runc-sandbox", insecure: true, flavours: ["default"] },
};
const known = { tools: [], mcpServers: [], sandboxRuntimes: runtimes };

describe("sandboxRuntime in a profile definition", () => {
  it("round-trips and sits after sandboxFlavour in the key order", () => {
    const result = validateProfileDefinition({
      sandboxRuntime: "gvisorkvm",
      sandboxFlavour: "browser",
    });
    expect(result).toEqual({ sandboxFlavour: "browser", sandboxRuntime: "gvisorkvm" });
    expect(Object.keys(result as object)).toEqual(["sandboxFlavour", "sandboxRuntime"]);
  });

  it("is absent when not given", () => {
    expect(validateProfileDefinition({})).toEqual({});
  });

  it.each(["Runc", "run-c", "", "a".repeat(17), "1x", 3, null])("rejects %j", (value) => {
    expect(validateProfileDefinition({ sandboxRuntime: value })).toMatch(/sandboxRuntime must be/);
  });
});

describe("parseSandboxRuntimes", () => {
  const parse = (value: string | undefined) => parseSandboxRuntimes({ PI_SANDBOX_RUNTIMES: value });

  it("treats absent, blank and {} as none", () => {
    expect(parse(undefined)).toEqual({});
    expect(parse("  ")).toEqual({});
    expect(parse("{}")).toEqual({});
  });

  it("accepts the chart's shape", () => {
    expect(parse(JSON.stringify(runtimes))).toEqual(runtimes);
  });

  it.each([
    ["not json", "PI_SANDBOX_RUNTIMES must be a JSON object"],
    ["[]", "PI_SANDBOX_RUNTIMES must be a JSON object"],
    ["null", "PI_SANDBOX_RUNTIMES must be a JSON object"],
    ['{"Bad":{}}', 'PI_SANDBOX_RUNTIMES: "Bad" is not a runtime name'],
    ['{"default":{}}', '"default" is not a runtime name'],
    ['{"browser":{}}', '"browser" is not a runtime name'],
    ['{"x":1}', 'runtime "x" must be an object'],
    ['{"x":{"runtimeClassName":"","insecure":false,"flavours":["default"]}}', "runtimeClassName"],
    ['{"x":{"runtimeClassName":"c","flavours":["default"]}}', "insecure"],
    ['{"x":{"runtimeClassName":"c","insecure":"no","flavours":["default"]}}', "insecure"],
    ['{"x":{"runtimeClassName":"c","insecure":false,"flavours":[]}}', "flavours"],
    ['{"x":{"runtimeClassName":"c","insecure":false,"flavours":[1]}}', "flavours"],
    [
      '{"x":{"runtimeClassName":"c","insecure":false,"flavours":["default"],"extra":1}}',
      "unknown field",
    ],
  ])("rejects %s", (value, message) => {
    expect(() => parse(value)).toThrow(message);
  });
});

describe("sandboxRuntimeConflict", () => {
  it("has none for a profile without a runtime, whatever the deployment has", () => {
    expect(
      sandboxRuntimeConflict({ sandboxFlavour: "browser", networkMode: "direct" }, {}),
    ).toBeNull();
  });

  it("has none for a known runtime with a listed flavour", () => {
    expect(
      sandboxRuntimeConflict({ sandboxRuntime: "gvisorkvm", sandboxFlavour: "browser" }, runtimes),
    ).toBeNull();
    expect(
      sandboxRuntimeConflict({ sandboxRuntime: "runc", networkMode: "proxied" }, runtimes),
    ).toBeNull();
  });

  it("refuses an unknown runtime and names the chart key", () => {
    expect(sandboxRuntimeConflict({ sandboxRuntime: "nope" }, runtimes)).toMatch(
      /sandbox\.runtimes.*gvisorkvm, runc/,
    );
    expect(sandboxRuntimeConflict({ sandboxRuntime: "nope" }, {})).toMatch(
      /has not set sandbox\.runtimes/,
    );
    expect(sandboxRuntimeConflict({ sandboxRuntime: "constructor" }, runtimes)).toMatch(
      /not defined/,
    );
  });

  it("refuses a flavour the entry does not list", () => {
    expect(
      sandboxRuntimeConflict({ sandboxRuntime: "runc", sandboxFlavour: "browser" }, runtimes),
    ).toMatch(/sandbox\.runtimes\.runc\.flavours/);
  });

  it("refuses direct network mode with a named runtime", () => {
    expect(
      sandboxRuntimeConflict({ sandboxRuntime: "runc", networkMode: "direct" }, runtimes),
    ).toMatch(/networkMode direct cannot be combined with sandboxRuntime "runc"/);
  });

  it("is applied by checkProfileNames, and refuses any runtime when none are known", () => {
    expect(checkProfileNames({ sandboxRuntime: "runc" }, known)).toBeUndefined();
    expect(checkProfileNames({ sandboxRuntime: "nope" }, known)).toMatch(/not defined/);
    expect(checkProfileNames({ sandboxRuntime: "runc" }, { tools: [], mcpServers: [] })).toMatch(
      /sandbox\.runtimes/,
    );
  });
});

describe("sandboxRuntimeOf", () => {
  it("is null for the default runtime", () => {
    expect(sandboxRuntimeOf({})).toBeNull();
    expect(sandboxRuntimeOf({ sandboxRuntime: "runc" })).toBe("runc");
  });
});
