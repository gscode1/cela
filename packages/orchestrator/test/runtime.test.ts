import { describe, expect, it, vi } from "vitest";
import { guardRuntime } from "../src/runtime.ts";

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
