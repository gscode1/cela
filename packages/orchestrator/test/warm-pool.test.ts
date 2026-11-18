import { describe, expect, it } from "vitest";
import { warmPoolFor } from "../src/warm-pool.ts";

// Pool selection (docs/decisions/0038-network-modes.md): the pool is the network position.
describe("warmPoolFor", () => {
  it("keeps the proxied names of before modes: pi-env-pool and pi-env-pool-<size>", () => {
    expect(warmPoolFor("pi-env-pool", null, "proxied")).toBe("pi-env-pool");
    expect(warmPoolFor("pi-env-pool", "m", "proxied")).toBe("pi-env-pool-m");
  });

  it("picks the direct pool of the session's size, or the unsized direct pool", () => {
    expect(warmPoolFor("pi-env-pool", "m", "direct")).toBe("pi-env-direct-pool-m");
    expect(warmPoolFor("pi-env-pool", null, "direct")).toBe("pi-env-direct-pool");
  });

  it("never collides: a size named like the mode cannot reach the other mode's pool", () => {
    expect(warmPoolFor("pi-env-pool", "direct-s", "proxied")).toBe("pi-env-pool-direct-s");
    expect(warmPoolFor("pi-env-pool", "s", "direct")).not.toBe(
      warmPoolFor("pi-env-pool", "direct-s", "proxied"),
    );
  });

  // The browser flavour (docs/decisions/0041-browser-sandbox.md) adds a name per flavour, size and mode.
  it("picks the browser pool of the session's size and mode", () => {
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "browser")).toBe("pi-env-browser-pool-m");
    expect(warmPoolFor("pi-env-pool", null, "proxied", "browser")).toBe("pi-env-browser-pool");
    expect(warmPoolFor("pi-env-pool", "m", "direct", "browser")).toBe(
      "pi-env-browser-direct-pool-m",
    );
  });

  it("keeps the default flavour's names, and no size can reach the browser pools", () => {
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "default")).toBe("pi-env-pool-m");
    const browser = new Set(
      ["s", "m", "l", "xl"].flatMap((size) => [
        warmPoolFor("pi-env-pool", size, "proxied", "browser"),
        warmPoolFor("pi-env-pool", size, "direct", "browser"),
      ]),
    );
    for (const size of ["browser-s", "browser-direct-s", "direct-s", "pool-s"]) {
      expect(browser.has(warmPoolFor("pi-env-pool", size, "proxied"))).toBe(false);
    }
  });
});
