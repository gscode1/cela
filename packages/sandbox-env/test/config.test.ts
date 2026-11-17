import { describe, expect, it } from "vitest";
import { parseBridgeArgs } from "../src/config.ts";

const serve = ["serve", "--token", "abc"];

describe("parseBridgeArgs", () => {
  it("reads the target from the environment and defaults to in-cluster-service", () => {
    const config = parseBridgeArgs(serve, {
      PI_SANDBOX_CLAIM: "c1",
      PI_SANDBOX_NAMESPACE: "ns",
      PI_SANDBOX_AUTH_TOKEN: "t",
    });
    expect(config).toEqual({
      target: {
        claimName: "c1",
        namespace: "ns",
        connectivity: "in-cluster-service",
        authToken: "t",
      },
      command: "/usr/local/bin/pi-env",
      args: serve,
    });
  });

  it("lets flags override the environment", () => {
    const config = parseBridgeArgs(["--claim", "other", "--connectivity", "port-forward", ...serve], {
      PI_SANDBOX_CLAIM: "c1",
      PI_SANDBOX_NAMESPACE: "ns",
    });
    expect(config.target).toEqual({
      claimName: "other",
      namespace: "ns",
      connectivity: "port-forward",
    });
  });

  it("rejects a missing claim, bad connectivity and a missing serve command", () => {
    expect(() => parseBridgeArgs(serve, { PI_SANDBOX_NAMESPACE: "ns" })).toThrow(/claim/);
    expect(() =>
      parseBridgeArgs(serve, {
        PI_SANDBOX_CLAIM: "c",
        PI_SANDBOX_NAMESPACE: "n",
        PI_SANDBOX_CONNECTIVITY: "x",
      }),
    ).toThrow(/connectivity/);
    expect(() => parseBridgeArgs([], { PI_SANDBOX_CLAIM: "c", PI_SANDBOX_NAMESPACE: "n" })).toThrow(
      /serve/,
    );
  });
});
