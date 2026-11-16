import { describe, expect, it } from "vitest";
import { tokenAuthenticator } from "../src/auth.ts";

const spec = "alice:aaaaaaaaaaaaaaaaaaaa\nbob:bbbbbbbbbbbbbbbbbbbb";
const auth = tokenAuthenticator(spec);

describe("tokenAuthenticator", () => {
  it("maps a bearer token to its owner", async () => {
    expect(await auth({ authorization: "Bearer aaaaaaaaaaaaaaaaaaaa" })).toEqual({
      owner: "alice",
      subject: "static:alice",
    });
    expect(await auth({ authorization: "bearer bbbbbbbbbbbbbbbbbbbb" })).toEqual({
      owner: "bob",
      subject: "static:bob",
    });
  });

  it("rejects missing, malformed and wrong tokens", async () => {
    expect(await auth({})).toBeUndefined();
    expect(await auth({ authorization: "Basic aaaaaaaaaaaaaaaaaaaa" })).toBeUndefined();
    expect(await auth({ authorization: "Bearer " })).toBeUndefined();
    expect(await auth({ authorization: "Bearer aaaaaaaaaaaaaaaaaaab" })).toBeUndefined();
  });

  it("refuses weak or malformed configuration without echoing the token", () => {
    expect(() => tokenAuthenticator("")).toThrow(/no API tokens/);
    expect(() => tokenAuthenticator("alice:short")).toThrow(/entry 1/);
    expect(() => tokenAuthenticator("no-colon-here-at-all-xx")).toThrow(/owner:token/);
    try {
      tokenAuthenticator("alice:short");
    } catch (error) {
      expect(String(error)).not.toContain("short");
    }
  });
});
