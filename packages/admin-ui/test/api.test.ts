import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, adminFetch, signInMessage } from "@/lib/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("adminFetch", () => {
  it("sends the token only as a bearer header, with no cookies", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await adminFetch("secret-token", "/admin/settings");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/admin/settings");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret-token" });
    expect(path).not.toContain("secret-token");
  });

  it("throws an ApiError that carries the status and the API's message", async () => {
    stubFetch(403, { error: "forbidden" });
    const error = await adminFetch("t", "/admin/settings").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 403, message: "forbidden" });
  });

  it("falls back to the status line for a body that is not JSON", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>", { status: 502 })));
    await expect(adminFetch("t", "/x")).rejects.toMatchObject({ message: "HTTP 502" });
  });
});

describe("signInMessage", () => {
  it("tells an invalid token from a valid owner without admin access", () => {
    expect(signInMessage(new ApiError(401, "unauthorized"))).toBe("invalid token");
    expect(signInMessage(new ApiError(403, "forbidden"))).toBe("valid owner without admin access");
  });

  it("names other failures separately", () => {
    expect(signInMessage(new ApiError(503, "starting"))).toBe("sign-in failed: starting");
    expect(signInMessage(new TypeError("fetch failed"))).toBe("could not reach the server");
  });
});
