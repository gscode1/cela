import { describe, expect, it } from "vitest";
import { isAdmin, parseAdmins, tokenAuthenticator } from "../src/auth.ts";

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

  it("refuses tokens that can never be presented, without echoing them", () => {
    for (const spec of [
      "alice: abcdefghijklmnop",
      "alice:abcdefgh ijklmnop",
      "alice:abcdefghijklmnop\u00a0x",
    ]) {
      expect(() => tokenAuthenticator(spec)).toThrow(/entry 1.*no whitespace/);
      try {
        tokenAuthenticator(spec);
      } catch (error) {
        expect(String(error)).not.toContain("abcdefgh");
      }
    }
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

describe("tokenAuthenticator with a shared token", () => {
  it("refuses two owners with the same token, naming the owners and not the token", () => {
    const spec = "alice:sharedtokenvalue123\nbob:bbbbbbbbbbbbbbbbbbbb\ncarol:sharedtokenvalue123";
    expect(() => tokenAuthenticator(spec)).toThrow(/alice and carol/);
    try {
      tokenAuthenticator(spec);
    } catch (error) {
      expect(String(error)).not.toContain("sharedtokenvalue123");
    }
  });

  it("still accepts several distinct tokens for one owner", async () => {
    const both = tokenAuthenticator("alice:aaaaaaaaaaaaaaaaaaaa,alice:cccccccccccccccccccc");
    expect(await both({ authorization: "Bearer cccccccccccccccccccc" })).toEqual({
      owner: "alice",
      subject: "static:alice",
    });
  });
});

describe("parseAdmins", () => {
  it("splits on commas and newlines, and means nobody when empty", () => {
    expect(parseAdmins("alice, bob\ncarol")).toEqual(["alice", "bob", "carol"]);
    expect(parseAdmins(undefined)).toEqual([]);
    expect(parseAdmins("")).toEqual([]);
  });
  it("rejects a name that is not an owner name, and matches by owner", () => {
    expect(() => parseAdmins("Alice Smith")).toThrow(/PI_API_ADMINS/);
    expect(isAdmin({ owner: "alice", subject: "static:alice" }, ["alice"])).toBe(true);
    expect(isAdmin({ owner: "bob", subject: "static:bob" }, ["alice"])).toBe(false);
  });
});
