import { describe, expect, it } from "vitest";
import { warmPoolFor } from "../src/warm-pool.ts";

// Pool selection (docs/decisions/0038-network-modes.md): the pool is the network position.
describe("warmPoolFor", () => {
  it("keeps the proxied names of before modes: pi-env-pool and pi-env-pool-<size>", () => {
    expect(warmPoolFor("pi-env-pool", null, "proxied", "default", null)).toBe("pi-env-pool");
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "default", null)).toBe("pi-env-pool-m");
  });

  it("picks the direct pool of the session's size, or the unsized direct pool", () => {
    expect(warmPoolFor("pi-env-pool", "m", "direct", "default", null)).toBe("pi-env-direct-pool-m");
    expect(warmPoolFor("pi-env-pool", null, "direct", "default", null)).toBe("pi-env-direct-pool");
  });

  it("never collides: a size named like the mode cannot reach the other mode's pool", () => {
    expect(warmPoolFor("pi-env-pool", "direct-s", "proxied", "default", null)).toBe(
      "pi-env-pool-direct-s",
    );
    expect(warmPoolFor("pi-env-pool", "s", "direct", "default", null)).not.toBe(
      warmPoolFor("pi-env-pool", "direct-s", "proxied", "default", null),
    );
  });

  // The browser flavour (docs/decisions/0041-browser-sandbox.md) adds a name per flavour, size and mode.
  it("picks the browser pool of the session's size and mode", () => {
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "browser", null)).toBe(
      "pi-env-browser-pool-m",
    );
    expect(warmPoolFor("pi-env-pool", null, "proxied", "browser", null)).toBe(
      "pi-env-browser-pool",
    );
    expect(warmPoolFor("pi-env-pool", "m", "direct", "browser", null)).toBe(
      "pi-env-browser-direct-pool-m",
    );
  });

  it("keeps the default flavour's names, and no size can reach the browser pools", () => {
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "default", null)).toBe("pi-env-pool-m");
    const browser = new Set(
      ["s", "m", "l", "xl"].flatMap((size) => [
        warmPoolFor("pi-env-pool", size, "proxied", "browser", null),
        warmPoolFor("pi-env-pool", size, "direct", "browser", null),
      ]),
    );
    for (const size of ["browser-s", "browser-direct-s", "direct-s", "pool-s"]) {
      expect(browser.has(warmPoolFor("pi-env-pool", size, "proxied", "default", null))).toBe(false);
    }
  });

  // ADR 0064: a named runtime adds `-rt-<runtime>` after `pi-env`; null keeps every name above.
  it("picks the pool of a named runtime, with the infix before the flavour", () => {
    expect(warmPoolFor("pi-env-pool", null, "proxied", "default", "runc")).toBe(
      "pi-env-rt-runc-pool",
    );
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "default", "gvisorkvm")).toBe(
      "pi-env-rt-gvisorkvm-pool-m",
    );
    expect(warmPoolFor("pi-env-pool", "m", "proxied", "browser", "runc")).toBe(
      "pi-env-rt-runc-browser-pool-m",
    );
    expect(warmPoolFor("pi-env-pool", "xl", "direct", "browser", "runc")).toBe(
      "pi-env-rt-runc-browser-direct-pool-xl",
    );
  });

  it("never lets a runtime name, a flavour, a mode or a size reach another pool", () => {
    const all = new Map<string, string>();
    for (const runtime of [null, "runc", "gvisorkvm", "a1"])
      for (const flavour of ["default", "browser"] as const)
        for (const mode of ["proxied", "direct"] as const)
          for (const size of [null, "s", "m", "direct-s", "browser-s"]) {
            const key = JSON.stringify([runtime, flavour, mode, size]);
            const name = warmPoolFor("pi-env-pool", size, mode, flavour, runtime);
            expect(all.get(name), `${name}: ${key} and ${all.get(name) ?? ""}`).toBeUndefined();
            all.set(name, key);
          }
  });
});
