import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSandboxToken, sandboxTokenSha256 } from "../src/token.ts";

describe("deriveSandboxToken", () => {
  it("is deterministic and 64 hex characters", () => {
    expect(deriveSandboxToken("m", "pi-conv-1")).toBe(deriveSandboxToken("m", "pi-conv-1"));
    expect(deriveSandboxToken("m", "pi-conv-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs per claim and per master", () => {
    expect(deriveSandboxToken("m", "pi-conv-1")).not.toBe(deriveSandboxToken("m", "pi-conv-2"));
    expect(deriveSandboxToken("m", "pi-conv-1")).not.toBe(deriveSandboxToken("n", "pi-conv-1"));
  });

  it("matches the RFC 4231 HMAC-SHA256 test case 2", () => {
    expect(deriveSandboxToken("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("rejects an empty master", () => {
    expect(() => deriveSandboxToken("", "pi-conv-1")).toThrow(/master/);
  });

  it("gives a token whose sandboxd hash is sha256 of the token string and is not the token", () => {
    const token = deriveSandboxToken("m", "pi-conv-1");
    const hash = sandboxTokenSha256(token);
    expect(hash).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
    expect(hash).not.toBe(token);
    // The hash of one sandbox's token is not a valid token for another: tokens differ per claim.
    expect(hash).not.toBe(deriveSandboxToken("m", "pi-conv-2"));
  });
});
