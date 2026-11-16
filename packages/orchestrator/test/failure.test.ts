import { describe, expect, it } from "vitest";
import { terminalFailure } from "../src/failure.ts";

describe("terminalFailure", () => {
  it.each([
    "401 Incorrect API key provided: onecli-managed-placeholder",
    "403 Forbidden",
    "Request failed with status code 401",
    'OpenRouter error: 401 {"error":{"message":"No auth credentials found","code":401}}',
    "Proxy response (407) !== 200 when HTTP Tunneling",
    "407 Proxy Authentication Required",
    "Unauthorized",
    "invalid_api_key",
    // OneCLI v2 with the grant deleted; pi-ai keeps only the body's message.
    '{"error":"access_restricted","message":"chatgpt.com credentials exist in OneCLI but this agent does not have access. Ask the user to attach the key to this agent","provider":"chatgpt.com"}',
  ])("ends the session when the model says credentials are rejected: %s", (detail) => {
    expect(terminalFailure({ reason: "model_error", detail })).toMatch(
      /credentials were rejected \(401\/403\)/,
    );
  });

  it.each([
    "429 Too Many Requests",
    "503 Service Unavailable",
    "fetch failed",
    "request id 4010293 failed",
    "got 14031 bytes",
    "Provider returned error",
  ])("leaves the session usable for a transient or unrelated error: %s", (detail) => {
    expect(terminalFailure({ reason: "model_error", detail })).toBeUndefined();
  });

  it("does not read a credential message into other kinds of run failure", () => {
    expect(terminalFailure({ reason: "aborted", detail: "401" })).toBeUndefined();
    expect(terminalFailure({ reason: "model_error" })).toBeUndefined();
  });

  it("maps the turn limit to the turn budget", () => {
    expect(terminalFailure({ reason: "turn_limit", detail: "5 turns" })).toMatch(/turn budget/);
  });

  it("gives a message that never echoes the provider's text", () => {
    const message = terminalFailure({ reason: "model_error", detail: "401 key sk-live-abc123" });
    expect(message).not.toContain("sk-live-abc123");
  });
});
