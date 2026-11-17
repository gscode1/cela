import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/github-app.ts";
import { OneCliAdmin, OneCliError } from "../src/onecli-admin.ts";
import { Redacted } from "../src/onecli.ts";

type Step = number | "network" | "hang";

/** Answers one scripted step per call; "hang" never answers until the call's signal aborts. */
function scripted(steps: Step[]): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push(`${init.method} ${url}`);
    const step = steps.shift() ?? 200;
    if (step === "network") return Promise.reject(new TypeError("fetch failed: secret-host"));
    if (step === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    return Promise.resolve({
      status: step,
      json: () => Promise.resolve([]),
      text: () => Promise.resolve("[]"),
    });
  };
  return { fetch, calls };
}

function admin(fetch: FetchLike, retries = 3): { admin: OneCliAdmin; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    admin: new OneCliAdmin("http://onecli:10256", new Redacted("oc_key"), fetch, {
      timeoutMs: 50,
      retries,
      backoffMs: 100,
      maxBackoffMs: 300,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }),
  };
}

describe("OneCliAdmin listSecrets", () => {
  it("returns the host pattern when the API gives one, and none otherwise", async () => {
    const body = [
      { id: "s1", name: "openai", hostPattern: "api.openai.com" },
      { id: "s2", name: "bare" },
    ];
    const fetch: FetchLike = () =>
      Promise.resolve({
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    const { admin: a } = admin(fetch);
    expect(await a.listSecrets()).toEqual([
      { id: "s1", name: "openai", hostPattern: "api.openai.com" },
      { id: "s2", name: "bare" },
    ]);
  });
});

describe("OneCliAdmin retry and timeout", () => {
  it("retries a network error and a 5xx with doubling, capped backoff, then succeeds", async () => {
    const { fetch, calls } = scripted(["network", 503, 500, 200]);
    const { admin: a, sleeps } = admin(fetch);
    await expect(a.listAgents()).resolves.toEqual([]);
    expect(calls).toHaveLength(4);
    expect(sleeps).toEqual([100, 200, 300]);
  });

  it("gives up after the bounded number of retries with the last error", async () => {
    const { fetch, calls } = scripted([500, 500, 500]);
    const { admin: a } = admin(fetch, 2);
    await expect(a.listAgents()).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(3);
  });

  it("never retries a 4xx", async () => {
    const { fetch, calls } = scripted([401, 200]);
    const { admin: a, sleeps } = admin(fetch);
    await expect(a.listAgents()).rejects.toBeInstanceOf(OneCliError);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("aborts a hung call after the timeout and retries it", async () => {
    const { fetch, calls } = scripted(["hang", 200]);
    const { admin: a } = admin(fetch);
    await expect(a.listAgents()).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("reports a timeout without the cause's text", async () => {
    const { fetch } = scripted(["hang", "hang"]);
    const { admin: a } = admin(fetch, 1);
    await expect(a.listAgents()).rejects.toThrow(/GET \/v1\/agents timed out after 50 ms/);
  });

  it("does not leak the network error's text", async () => {
    const { fetch } = scripted(["network"]);
    const { admin: a } = admin(fetch, 0);
    await expect(a.listAgents()).rejects.toThrow(/^OneCLI GET \/v1\/agents failed: TypeError$/);
  });

  it("never re-sends a create POST after an ambiguous failure, and finds an applied create by lookup", async () => {
    for (const failure of ["network", 500, 502, 503, 504, "hang"] as const) {
      // lookup (empty), POST (fails in a way that may hide an applied create), lookup finds it.
      const calls: string[] = [];
      const fetch: FetchLike = (url, init) => {
        calls.push(`${init.method} ${url}`);
        const n = calls.length;
        if (n === 2) {
          if (failure === "network") return Promise.reject(new TypeError("fetch failed"));
          if (failure === "hang") {
            return new Promise((_, reject) => {
              init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
          }
          return Promise.resolve({
            status: failure,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(""),
          });
        }
        const body = n === 1 ? [] : [{ id: "a1", name: "i", identifier: "i", accessToken: "t" }];
        return Promise.resolve({
          status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(JSON.stringify(body)),
        });
      };
      const { admin: a } = admin(fetch);
      const { agent, created } = await a.ensureAgent("i");
      expect(agent.identifier).toBe("i");
      expect(created).toBe(true);
      expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
    }
  });

  it("does not retry a create refused with a 4xx", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push(`${init.method} ${url}`);
      const status = init.method === "POST" ? 400 : 200;
      return Promise.resolve({
        status,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve("[]"),
      });
    };
    await expect(admin(fetch).admin.ensureAgent("i")).rejects.toMatchObject({ status: 400 });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(1);
  });

  it("stops after the bounded retries when the create keeps failing and is never found", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push(`${init.method} ${url}`);
      const status = init.method === "POST" ? 503 : 200;
      return Promise.resolve({
        status,
        json: () => Promise.resolve([]),
        text: () => Promise.resolve("[]"),
      });
    };
    const { admin: a, sleeps } = admin(fetch, 2);
    await expect(a.ensureAgent("i")).rejects.toMatchObject({ status: 503 });
    expect(calls.filter((c) => c.startsWith("POST"))).toHaveLength(3);
    expect(sleeps).toEqual([100, 200]);
  });

  it("does not POST a secret that a lookup finds", async () => {
    const calls: string[] = [];
    const fetch: FetchLike = (url, init) => {
      calls.push(`${init.method} ${url}`);
      const body = [{ id: "s1", name: "n" }];
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      });
    };
    const id = await admin(fetch).admin.ensureSecret({
      name: "n",
      value: "v",
      hostPattern: "h",
      header: "Authorization",
      valueFormat: "{value}",
    });
    expect(id).toBe("s1");
    expect(calls).toHaveLength(1);
  });
});
