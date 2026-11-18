import { describe, expect, it } from "vitest";
import type { ModelProviderStatus } from "@pi-durable-k8s/session-core";
import { ModelCredentialsLoop } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { buildModels } from "../src/providers.ts";

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
  ONECLI_AGENT_TOKEN: "aoc_0123456789abcdef0123456789abcdef",
});

/** A loop over a mutable secret list, publishing into `published` the way the database row would hold it. */
async function setup(): Promise<{
  loop: ModelCredentialsLoop;
  secrets: { hostPattern?: string }[];
  published: { value: ModelProviderStatus[] | undefined; writes: number };
  fail: { listing: boolean };
}> {
  const models = await buildModels(config, () => Promise.resolve(""));
  const secrets: { hostPattern?: string }[] = [];
  const published: { value: ModelProviderStatus[] | undefined; writes: number } = {
    value: undefined,
    writes: 0,
  };
  const fail = { listing: false };
  const loop = new ModelCredentialsLoop({
    models,
    config,
    listSecrets: () =>
      fail.listing ? Promise.reject(new Error("onecli down")) : Promise.resolve([...secrets]),
    publish: (providers) => {
      const changed = JSON.stringify(providers) !== JSON.stringify(published.value);
      if (changed) {
        published.value = [...providers];
        published.writes += 1;
      }
      return Promise.resolve(changed);
    },
  });
  return { loop, secrets, published, fail };
}

const credentialOf = (
  providers: ModelProviderStatus[] | undefined,
  provider: string,
): string | undefined => providers?.find((p) => p.provider === provider)?.credential;

describe("ModelCredentialsLoop", () => {
  it("flips a provider to configured once its secret is added to OneCLI, writing only on a change", async () => {
    const { loop, secrets, published } = await setup();
    expect(await loop.run()).toBe(true);
    expect(credentialOf(published.value, "openai-codex")).toBe("missing");
    expect(await loop.run()).toBe(false);
    secrets.push({ hostPattern: "chatgpt.com" });
    expect(await loop.run()).toBe(true);
    expect(credentialOf(published.value, "openai-codex")).toBe("configured");
    expect(credentialOf(published.value, "anthropic")).toBe("missing");
    expect(published.writes).toBe(2);
  }, 10_000);

  it("keeps the last hint when listing the secrets fails, and never throws", async () => {
    const { loop, secrets, published, fail } = await setup();
    secrets.push({ hostPattern: "chatgpt.com" });
    await loop.run();
    fail.listing = true;
    expect(await loop.run()).toBe(false);
    expect(credentialOf(published.value, "openai-codex")).toBe("configured");
    expect(published.writes).toBe(1);
  }, 10_000);

  it("skips a check while the previous one still runs", async () => {
    const models = await buildModels(config, () => Promise.resolve(""));
    let release: () => void = () => undefined;
    let listings = 0;
    const loop = new ModelCredentialsLoop({
      models,
      config,
      listSecrets: () => {
        listings += 1;
        return new Promise((resolve) => {
          release = () => resolve([]);
        });
      },
      publish: () => Promise.resolve(true),
    });
    const first = loop.run();
    expect(await loop.run()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(listings).toBe(1);
  }, 10_000);
});
