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
    return Promise.resolve({ status: step, text: () => Promise.resolve("[]") });
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

  it("retries a POST only on a status that means it was not delivered", async () => {
    const lost = scripted(["network", 200]);
    await expect(admin(lost.fetch).admin.createAgent("n", "i")).rejects.toThrow(/failed/);
    expect(lost.calls).toHaveLength(1);

    const five = scripted([500, 200]);
    await expect(admin(five.fetch).admin.createAgent("n", "i")).rejects.toMatchObject({
      status: 500,
    });
    expect(five.calls).toHaveLength(1);

    const gateway = scripted([503, 201]);
    await admin(gateway.fetch).admin.createAgent("n", "i");
    expect(gateway.calls).toHaveLength(2);
  });
});
