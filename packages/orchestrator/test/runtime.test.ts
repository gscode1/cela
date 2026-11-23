import { describe, expect, it, vi } from "vitest";
import type { SandboxRuntimes } from "@cela/session-core";
import { guardRuntime, guardRuntimes } from "../src/runtime.ts";
import type { TemplateRuntime } from "../src/kube.ts";

describe("sandbox runtime startup guard", () => {
  it("accepts gvisor without an override", () => {
    const warn = vi.fn();
    guardRuntime("gvisor", undefined, warn);
    expect(warn).not.toHaveBeenCalled();
  }, 1000);
  it.each(["", "runc", "kata", "gVisor"])(
    "rejects %j unless the override is exactly 1",
    (runtime) => {
      for (const allow of [undefined, "0", "true", ""]) {
        expect(() => guardRuntime(runtime, allow, vi.fn())).toThrow("PI_ALLOW_INSECURE_RUNTIME=1");
      }
    },
    1000,
  );
  it("warns prominently at every insecure start, including the node default", () => {
    const warn = vi.fn();
    guardRuntime("", "1", warn);
    guardRuntime("runc", "1", warn);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      "INSECURE-SANDBOX-RUNTIME",
      expect.objectContaining({ level: "warn", configuredRuntime: "" }),
    );
  }, 1000);
});

const template = (
  name: string,
  runtime: string | undefined,
  runtimeClassName: string,
): TemplateRuntime => ({
  name,
  runtime,
  runtimeClassName,
});
const NAMED = {
  gvisorkvm: { runtimeClassName: "gvisor-kvm", insecure: false, flavours: ["default"] },
  runc: { runtimeClassName: "runc-sandbox", insecure: true, flavours: ["default"] },
};

describe("per-runtime startup guard", () => {
  const guard = (
    templates: TemplateRuntime[],
    options: { allowDefault?: string; allowNamed?: string[]; named?: SandboxRuntimes } = {},
    warn = vi.fn(),
  ) =>
    guardRuntimes(
      {
        templates,
        named: options.named ?? NAMED,
        allowDefault: options.allowDefault,
        allowNamed: options.allowNamed ?? [],
      },
      warn,
    );

  it("accepts gvisor default and a gvisor-* named runtime without any override", () => {
    const warn = vi.fn();
    const named = guard(
      [
        template("pi-env-template", "default", "gvisor"),
        template("pi-env-rt-gvisorkvm-template", "gvisorkvm", "gvisor-kvm"),
        template("pi-env-rt-gvisorkvm-browser-template", "gvisorkvm", "gvisor-kvm"),
      ],
      {},
      warn,
    );
    expect(named).toEqual({ gvisorkvm: "gvisor-kvm" });
    expect(warn).not.toHaveBeenCalled();
  }, 1000);

  it("treats a template without the label (an older chart) as the default runtime", () => {
    expect(() => guard([template("pi-env-template", undefined, "runc")])).toThrow(
      "PI_ALLOW_INSECURE_RUNTIME=1",
    );
    expect(guard([template("pi-env-template", undefined, "gvisor")])).toEqual({});
  }, 1000);

  it("refuses a default group that has two classes, and a named group that has two", () => {
    expect(() =>
      guard([template("a", "default", "gvisor"), template("b", undefined, "runc")], {
        allowDefault: "1",
      }),
    ).toThrow(/different RuntimeClasses/);
    expect(() =>
      guard([template("a", "gvisorkvm", "gvisor-kvm"), template("b", "gvisorkvm", "gvisor")]),
    ).toThrow(/"gvisorkvm" has templates with different RuntimeClasses/);
  }, 1000);

  it("refuses a named runtime that PI_SANDBOX_RUNTIMES does not define or defines with another class", () => {
    expect(() => guard([template("a", "ghost", "gvisor")])).toThrow("sandbox.runtimes.ghost");
    expect(() => guard([template("a", "gvisorkvm", "gvisor")])).toThrow(/PI_SANDBOX_RUNTIMES says/);
  }, 1000);

  it("needs the named runtime's own acknowledgement for a class that is not gvisor, and warns once acknowledged", () => {
    const templates = [template("a", "runc", "runc-sandbox")];
    expect(() => guard(templates)).toThrow("PI_ALLOW_INSECURE_RUNTIMES");
    // The default runtime's acknowledgement does not cover it.
    expect(() => guard(templates, { allowDefault: "1" })).toThrow(
      "sandbox.runtimes.runc.allowInsecureRuntime",
    );
    // Another runtime's acknowledgement does not either.
    expect(() => guard(templates, { allowNamed: ["gvisorkvm"] })).toThrow(
      "PI_ALLOW_INSECURE_RUNTIMES",
    );
    const warn = vi.fn();
    expect(guard(templates, { allowNamed: ["runc"] }, warn)).toEqual({ runc: "runc-sandbox" });
    expect(warn).toHaveBeenCalledWith(
      "INSECURE-SANDBOX-RUNTIME",
      expect.objectContaining({
        level: "warn",
        sandboxRuntime: "runc",
        configuredRuntime: "runc-sandbox",
      }),
    );
  }, 1000);

  it("an insecure default does not need the named acknowledgement, and the reverse", () => {
    expect(
      guard([template("a", "default", "runc"), template("b", "runc", "runc-sandbox")], {
        allowDefault: "1",
        allowNamed: ["runc"],
      }),
    ).toEqual({ runc: "runc-sandbox" });
    expect(() => guard([template("a", "default", "runc")], { allowNamed: ["runc"] })).toThrow(
      "PI_ALLOW_INSECURE_RUNTIME=1",
    );
  }, 1000);

  it("does not accept a lookalike of gvisor as gvisor", () => {
    const named = { x: { runtimeClassName: "gvisorkvm", insecure: true, flavours: ["default"] } };
    expect(() => guard([template("a", "x", "gvisorkvm")], { named })).toThrow(
      "PI_ALLOW_INSECURE_RUNTIMES",
    );
  }, 1000);
});
