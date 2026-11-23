import { describe, expect, it } from "vitest";
import { SandboxRuntimeNotConfiguredError, warmPoolOfSession } from "../src/sandbox-runtime.ts";

const RUNTIMES = {
  gvisorkvm: { runtimeClassName: "gvisor-kvm", insecure: false, flavours: ["default", "browser"] },
};
const session = (sandboxRuntime: string | null) => ({
  sandboxSize: "m",
  networkMode: "proxied" as const,
  sandboxFlavour: "default" as const,
  sandboxRuntime,
});

describe("the warm pool of a session's runtime", () => {
  it("keeps the default runtime's pool names", () => {
    expect(warmPoolOfSession("pi-env-pool", {}, session(null))).toBe("pi-env-pool-m");
  }, 1000);
  it("picks the named runtime's pool", () => {
    expect(warmPoolOfSession("pi-env-pool", RUNTIMES, session("gvisorkvm"))).toBe(
      "pi-env-rt-gvisorkvm-pool-m",
    );
  }, 1000);
  it("fails the attach for a runtime the deployment no longer defines, and never falls back to the default", () => {
    expect(() => warmPoolOfSession("pi-env-pool", RUNTIMES, session("runc"))).toThrow(
      SandboxRuntimeNotConfiguredError,
    );
    expect(() => warmPoolOfSession("pi-env-pool", {}, session("runc"))).toThrow(
      /sandbox-runtime-not-configured.*"runc".*sandbox\.runtimes\.runc/,
    );
    // A name that Object.prototype has is not a configured runtime either.
    expect(() => warmPoolOfSession("pi-env-pool", {}, session("constructor"))).toThrow(
      "sandbox-runtime-not-configured",
    );
  }, 1000);
});
