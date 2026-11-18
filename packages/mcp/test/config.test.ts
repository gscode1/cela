import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const TOKEN = "s3cret-token-value";
const ok = { PI_API_URL: "https://api.example.com", PI_API_TOKEN: TOKEN };

function failure(env: Record<string, string | undefined>): ConfigError {
  try {
    parseConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig", { timeout: 10_000 }, () => {
  it("accepts https and defaults maxSessions to 20", () => {
    expect(parseConfig(ok)).toEqual({
      apiUrl: "https://api.example.com",
      token: TOKEN,
      maxSessions: 20,
    });
  });

  it("strips trailing slashes but keeps a path prefix", () => {
    expect(parseConfig({ ...ok, PI_API_URL: "https://x.example/prefix//" }).apiUrl).toBe(
      "https://x.example/prefix",
    );
  });

  it.each(["http://localhost:8080", "http://127.0.0.1:1", "http://127.9.9.9", "http://[::1]:3000"])(
    "accepts http for loopback %s",
    (url) => {
      expect(parseConfig({ ...ok, PI_API_URL: url }).apiUrl).toContain("://");
    },
  );

  it.each([
    "http://example.com",
    "http://10.0.0.1",
    "http://localhost.evil.com",
    "ftp://localhost",
    "not a url",
    "https://user:pw@example.com",
    "https://example.com/?a=1",
  ])("rejects PI_API_URL %s", (url) => {
    const error = failure({ ...ok, PI_API_URL: url });
    expect(error.message).toContain("PI_API_URL");
    expect(error.message).not.toContain("pw");
  });

  it("requires the URL and the token", () => {
    expect(failure({ PI_API_TOKEN: TOKEN }).message).toContain("PI_API_URL");
    expect(failure({ PI_API_URL: ok.PI_API_URL }).message).toContain("PI_API_TOKEN");
    expect(failure({ ...ok, PI_API_TOKEN: "  " }).message).toContain("PI_API_TOKEN");
  });

  it("never puts the token in an error", () => {
    const bad = `${TOKEN} with space`;
    const error = failure({ ...ok, PI_API_TOKEN: bad });
    expect(error.message).not.toContain("s3cret");
    expect(failure({ ...ok, PI_API_URL: `http://example.com/${TOKEN}` }).message).not.toContain(
      TOKEN,
    );
  });

  it("parses PI_MCP_MAX_SESSIONS", () => {
    expect(parseConfig({ ...ok, PI_MCP_MAX_SESSIONS: "3" }).maxSessions).toBe(3);
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expect(failure({ ...ok, PI_MCP_MAX_SESSIONS: bad }).message).toContain("PI_MCP_MAX_SESSIONS");
    }
  });
});
