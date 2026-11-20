import { describe, expect, it } from "vitest";
import type { ModelProviderStatus } from "@cela/session-core";
import { ModelCredentialsLoop, oneCliSecretsView } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import { mcpSecretCandidates, secretName } from "../src/onecli-names.ts";
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
  secrets: { name: string; hostPattern?: string }[];
  published: { value: ModelProviderStatus[] | undefined; writes: number };
  names: { value: string[] | undefined; writes: number };
  fail: { listing: boolean };
}> {
  const models = await buildModels(config, () => Promise.resolve(""));
  const secrets: { name: string; hostPattern?: string }[] = [];
  const names: { value: string[] | undefined; writes: number } = { value: undefined, writes: 0 };
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
    publishSecretNames: (next) => {
      const changed = JSON.stringify(next) !== JSON.stringify(names.value);
      if (changed) {
        names.value = [...next];
        names.writes += 1;
      }
      return Promise.resolve(changed);
    },
  });
  return { loop, secrets, published, names, fail };
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
    secrets.push({ name: "codex", hostPattern: "chatgpt.com" });
    expect(await loop.run()).toBe(true);
    expect(credentialOf(published.value, "openai-codex")).toBe("configured");
    expect(credentialOf(published.value, "anthropic")).toBe("missing");
    expect(published.writes).toBe(2);
  }, 10_000);

  it("keeps the last hint when listing the secrets fails, and never throws", async () => {
    const { loop, secrets, published, fail } = await setup();
    secrets.push({ name: "codex", hostPattern: "chatgpt.com" });
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
      publishSecretNames: () => Promise.resolve(false),
    });
    const first = loop.run();
    expect(await loop.run()).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(listings).toBe(1);
  }, 10_000);
});

const SESSION = "0b8e1c52-8a51-4c1e-9f0a-3d6f2b7c9e10";

describe("mcpSecretCandidates", () => {
  it("keeps the names an MCP server could reference, sorted and once each", () => {
    expect(
      mcpSecretCandidates([
        { name: "linear-mcp" },
        { name: "github-mcp" },
        { name: "linear-mcp" },
        { name: "Anthropic.key:prod/2" },
      ]),
    ).toEqual(["Anthropic.key:prod/2", "github-mcp", "linear-mcp"]);
  });

  it("leaves out the per-session secrets of any orchestrator prefix", () => {
    expect(
      mcpSecretCandidates([
        { name: secretName(SESSION, "git") },
        { name: secretName(SESSION, "api") },
        { name: secretName(SESSION, "git", "pi-e2e-ab12cd-session-") },
        { name: `my-${SESSION}-notes` },
        { name: "github-mcp" },
      ]),
    ).toEqual(["github-mcp", `my-${SESSION}-notes`]);
  });

  it("leaves out names the API would refuse as an onecliSecret", () => {
    expect(
      mcpSecretCandidates([
        { name: "" },
        { name: "-leading" },
        { name: "has space" },
        { name: "x".repeat(201) },
        { name: "ok" },
      ]),
    ).toEqual(["ok"]);
  });
});

describe("OneCLI secret names", () => {
  it("the loop publishes the names, writing only on a change, and keeps them when the listing fails", async () => {
    const { loop, secrets, names, fail } = await setup();
    secrets.push({ name: "github-mcp", hostPattern: "api.githubcopilot.com" });
    secrets.push({ name: secretName(SESSION, "git"), hostPattern: "github.com" });
    expect(await loop.run()).toBe(true);
    expect(names.value).toEqual(["github-mcp"]);
    expect(await loop.run()).toBe(false);
    secrets.push({ name: "linear-mcp", hostPattern: "mcp.linear.app" });
    expect(await loop.run()).toBe(true);
    expect(names.value).toEqual(["github-mcp", "linear-mcp"]);
    fail.listing = true;
    expect(await loop.run()).toBe(false);
    expect(names.value).toEqual(["github-mcp", "linear-mcp"]);
    expect(names.writes).toBe(2);
  }, 10_000);

  it("at start: the names from one listing; absent, not empty, without an admin client or when the listing fails", async () => {
    const models = await buildModels(config, () => Promise.resolve(""));
    let listings = 0;
    const listed = await oneCliSecretsView(models, config, () => {
      listings += 1;
      return Promise.resolve([
        { name: "codex", hostPattern: "chatgpt.com" },
        { name: secretName(SESSION, "api"), hostPattern: "api.github.com" },
      ]);
    });
    expect(listings).toBe(1);
    expect(listed.onecliSecretNames).toEqual(["codex"]);
    expect(credentialOf(listed.modelProviders, "openai-codex")).toBe("configured");
    const empty = await oneCliSecretsView(models, config, () => Promise.resolve([]));
    expect(empty.onecliSecretNames).toEqual([]);
    const none = await oneCliSecretsView(models, config, undefined);
    expect(none).not.toHaveProperty("onecliSecretNames");
    expect(credentialOf(none.modelProviders, "anthropic")).toBe("unknown");
    const failed = await oneCliSecretsView(models, config, () =>
      Promise.reject(new Error("onecli down")),
    );
    expect(failed).not.toHaveProperty("onecliSecretNames");
    expect(credentialOf(failed.modelProviders, "anthropic")).toBe("unknown");
  }, 10_000);
});
