import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import type { OrchestratorConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { PLACEHOLDER_API_KEY, withFetch } from "../src/onecli.ts";
import {
  KEYLESS_API_KEY,
  buildModels,
  hostPatternMatches,
  modelCatalog,
  providerCredentials,
} from "../src/providers.ts";

const base = {
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
};
const TOKEN = "aoc_0123456789abcdef0123456789abcdef";
const readCa = (): Promise<string> => Promise.resolve("");

describe("model config", () => {
  it("defaults to the scripted model, which needs no OneCLI token", () => {
    const config = loadConfig(base);
    expect(config.models.default).toEqual({ provider: "scripted", model: "scripted-1" });
    expect(config.turnBudget).toBe(100);
    expect(config.onecli.token).toBeUndefined();
  });

  it("requires the OneCLI agent token for a real provider, and never prints it", () => {
    const env = { ...base, PI_MODEL_ALLOWLIST: "openrouter/openai/gpt-4.1-nano" };
    expect(() => loadConfig(env)).toThrow(
      /ONECLI_AGENT_TOKEN is required for model provider openrouter/,
    );
    const config = loadConfig({ ...env, ONECLI_AGENT_TOKEN: TOKEN });
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(config.onecli.token?.reveal()).toBe(TOKEN);
  });

  it("covers the cluster, the Kubernetes API and Postgres in NO_PROXY, and adds the environment's entries", () => {
    const { noProxy } = loadConfig({ ...base, NO_PROXY: "corp.internal" }).onecli;
    expect(noProxy).toEqual(
      expect.arrayContaining([
        ".svc",
        ".cluster.local",
        "kubernetes.default",
        "db",
        "gateway-api",
        "corp.internal",
      ]),
    );
  });

  it("validates the turn budget", () => {
    expect(loadConfig({ ...base, PI_SESSION_TURN_BUDGET: "7" }).turnBudget).toBe(7);
    expect(() => loadConfig({ ...base, PI_SESSION_TURN_BUDGET: "0" })).toThrow(/TURN_BUDGET/);
    expect(() => loadConfig({ ...base, PI_SESSION_TURN_BUDGET: "x" })).toThrow(/TURN_BUDGET/);
  });
});

describe("buildModels", () => {
  it("installs the scripted models and the legacy faux model for /control", async () => {
    const models = await buildModels(loadConfig(base), readCa);
    expect(models.getModel("scripted", "scripted-1")).toBeDefined();
    expect(models.getModel("scripted", "scripted-2")).toBeDefined();
    expect(models.getModel("faux", "faux-1")).toBeDefined();
    expect(models.getModel("openrouter", "openai/gpt-4.1-nano")).toBeUndefined();
  });

  it("installs an allowlisted real provider, whose API key is the placeholder, not a credential", async () => {
    const config = loadConfig({
      ...base,
      ONECLI_AGENT_TOKEN: TOKEN,
      PI_MODEL_ALLOWLIST: "openrouter/openai/gpt-4.1-nano,scripted/scripted-2",
    });
    const models = await buildModels(config, readCa);
    const model = models.getModel("openrouter", "openai/gpt-4.1-nano");
    expect(model).toBeDefined();
    if (model === undefined) return;
    const auth = await models.getAuth(model);
    expect(auth?.auth.apiKey).toBe(PLACEHOLDER_API_KEY);
    // A real key in the environment is ignored.
    process.env.OPENROUTER_API_KEY = "sk-real-should-never-be-used";
    try {
      expect((await models.getAuth(model))?.auth.apiKey).toBe(PLACEHOLDER_API_KEY);
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("still resolves a provider whose last model left the allowlist, for conversations that stored it", async () => {
    const config = loadConfig({
      ...base,
      ONECLI_AGENT_TOKEN: TOKEN,
      PI_MODEL_ALLOWLIST: "scripted/scripted-2",
    });
    const models = await buildModels(config, readCa);
    expect(models.getModel("openrouter", "openai/gpt-4.1-nano")).toBeDefined();
    expect(models.getModel("openai-codex", "gpt-6.1-terra")).toBeDefined();
  });

  it("fails at start for an allowlisted model pi-ai does not know", async () => {
    const config = loadConfig({
      ...base,
      ONECLI_AGENT_TOKEN: TOKEN,
      PI_MODEL_ALLOWLIST: "openrouter/openai/no-such-model",
    });
    await expect(buildModels(config, readCa)).rejects.toThrow(/openrouter\/openai\/no-such-model/);
  });

  it("gives the Codex provider a JWT-shaped placeholder login carrying the account id claim", async () => {
    const config = loadConfig({
      ...base,
      ONECLI_AGENT_TOKEN: TOKEN,
      PI_MODEL_ALLOWLIST: "openai-codex/gpt-6.1-terra",
      PI_CODEX_ACCOUNT_ID: "acct-placeholder",
    });
    const models = await buildModels(config, readCa);
    const model = models.getModel("openai-codex", "gpt-6.1-terra");
    expect(model).toBeDefined();
    if (model === undefined) return;
    const key = (await models.getAuth(model))?.auth.apiKey ?? "";
    const parts = key.split(".");
    expect(parts).toHaveLength(3);
    const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as Record<
      string,
      { chatgpt_account_id?: string }
    >;
    expect(claims["https://api.openai.com/auth"]?.chatgpt_account_id).toBe("acct-placeholder");
  });
});

describe("model catalog", () => {
  it("lists the scripted models without faux, and every builtin provider with a token", async () => {
    const plain = modelCatalog(await buildModels(loadConfig(base), readCa));
    expect(plain.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "scripted/scripted-1",
      "scripted/scripted-2",
    ]);
    const full = modelCatalog(
      await buildModels(loadConfig({ ...base, ONECLI_AGENT_TOKEN: TOKEN }), readCa),
    );
    expect(full.some((m) => m.provider === "faux")).toBe(false);
    expect(full.length).toBeGreaterThan(plain.length);
    expect(full.find((m) => m.provider === "openai")).toMatchObject({
      reasoning: expect.any(Boolean) as boolean,
      contextWindow: expect.any(Number) as number,
    });
  });
});

describe("hostPatternMatches", () => {
  it("matches the same host, or a subdomain for *., case-insensitively, and never a bare *", () => {
    expect(hostPatternMatches("api.openai.com", "API.openai.com")).toBe(true);
    expect(hostPatternMatches("*.openai.com", "api.openai.com")).toBe(true);
    expect(hostPatternMatches("*.openai.com", "openai.com")).toBe(false);
    expect(hostPatternMatches("api.openai.com", "x.api.openai.com")).toBe(false);
    expect(hostPatternMatches("*", "api.openai.com")).toBe(false);
  });
});

describe("providerCredentials", () => {
  const config = loadConfig({ ...base, ONECLI_AGENT_TOKEN: TOKEN });
  const status = async (
    list: Parameters<typeof providerCredentials>[2],
    cfg: Parameters<typeof providerCredentials>[1] = config,
  ): Promise<Record<string, string>> => {
    const models = await buildModels(config, readCa);
    return Object.fromEntries(
      (await providerCredentials(models, cfg, list)).map((p) => [p.provider, p.credential]),
    );
  };

  it("marks a provider configured when a secret's host covers its base URL, else missing", async () => {
    const result = await status(() => Promise.resolve([{ hostPattern: "api.openai.com" }, {}]));
    expect(result.openai).toBe("configured");
    expect(result.anthropic).toBe("missing");
    expect(result.scripted).toBe("configured");
  });

  it("is unknown without an admin client, and when listing fails, never failing", async () => {
    expect((await status(undefined)).openai).toBe("unknown");
    const failed = await status(() => Promise.reject(new Error("down")));
    expect(failed.openai).toBe("unknown");
    expect(failed.scripted).toBe("configured");
  });

  it("counts the Codex provider as configured when the OneCLI account id is set", async () => {
    const withAccount = loadConfig({
      ...base,
      ONECLI_AGENT_TOKEN: TOKEN,
      PI_CODEX_ACCOUNT_ID: "acct-1",
    });
    expect((await status(undefined, withAccount))["openai-codex"]).toBe("configured");
    expect((await status(undefined))["openai-codex"]).toBe("unknown");
  });
});

const OMLX = {
  id: "omlx",
  baseUrl: "http://192.168.7.101:8000/v1",
  via: "direct",
  egress: { cidr: "192.168.7.101/32", port: 8000 },
  models: [{ id: "qwen3-30b", contextWindow: 32768, maxTokens: 8192 }],
};
const ACME = {
  id: "acme",
  baseUrl: "https://llm.acme.example/v1",
  models: [
    { id: "acme-1", name: "Acme One", contextWindow: 128000, maxTokens: 4096, reasoning: true },
  ],
};
const custom = (extra: Record<string, string> = {}): OrchestratorConfig =>
  loadConfig({ ...base, PI_CUSTOM_MODEL_PROVIDERS: JSON.stringify([OMLX, ACME]), ...extra });

describe("custom providers", () => {
  it("installs a direct provider without the OneCLI token, and leaves the one through OneCLI out", async () => {
    const models = await buildModels(custom(), readCa);
    expect(models.getModel("omlx", "qwen3-30b")).toMatchObject({
      provider: "omlx",
      api: "openai-completions",
      baseUrl: "http://192.168.7.101:8000/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    });
    expect(models.getModel("acme", "acme-1")).toBeUndefined();
    expect(models.getModel("openai", "gpt-5-mini")).toBeUndefined();
  });

  it("installs both next to the builtin providers when the token is set, and lists them in the catalog", async () => {
    const config = custom({ ONECLI_AGENT_TOKEN: TOKEN, PI_MODEL_ALLOWLIST: "acme/acme-1" });
    const models = await buildModels(config, readCa);
    expect(models.getModel("acme", "acme-1")).toMatchObject({
      name: "Acme One",
      reasoning: true,
      baseUrl: "https://llm.acme.example/v1",
    });
    expect(models.getModel("openai", "gpt-5-mini")).toBeDefined();
    expect(modelCatalog(models)).toEqual(
      expect.arrayContaining([
        {
          provider: "omlx",
          id: "qwen3-30b",
          reasoning: false,
          contextWindow: 32768,
          maxTokens: 8192,
        },
        expect.objectContaining({ provider: "acme", id: "acme-1", name: "Acme One" }),
      ]),
    );
  });

  it("fails at start for an allowlisted custom model that does not exist", async () => {
    const config = custom({ PI_MODEL_ALLOWLIST: "omlx/nope" });
    await expect(buildModels(config, readCa)).rejects.toThrow(/omlx\/nope/);
  });

  it("resolves a provider through OneCLI to the placeholder key, a direct one to the keyless constant", async () => {
    const config = custom({ ONECLI_AGENT_TOKEN: TOKEN });
    const models = await buildModels(config, readCa);
    const acme = models.getModel("acme", "acme-1");
    const omlx = models.getModel("omlx", "qwen3-30b");
    if (acme === undefined || omlx === undefined) throw new Error("models missing");
    process.env.ACME_API_KEY = "sk-real-should-never-be-used";
    try {
      expect((await models.getAuth(acme))?.auth.apiKey).toBe(PLACEHOLDER_API_KEY);
    } finally {
      delete process.env.ACME_API_KEY;
    }
    expect((await models.getAuth(omlx))?.auth.apiKey).toBe(KEYLESS_API_KEY);
  });

  describe("routing", () => {
    let server: Server | undefined;
    afterEach(() => {
      server?.close();
      server = undefined;
    });

    /** A server answering every request with `reply`; the config's direct provider is pointed at it for the test. */
    async function serve(
      reply: (url: string) => { status: number; headers?: Record<string, string>; body?: string },
    ): Promise<{ requests: { url: string; authorization: string | undefined }[]; port: number }> {
      const requests: { url: string; authorization: string | undefined }[] = [];
      const listening = createServer((req, res) => {
        requests.push({ url: req.url ?? "", authorization: req.headers.authorization });
        const { status, headers = {}, body = "" } = reply(req.url ?? "");
        res.writeHead(status, headers);
        res.end(body);
      });
      server = listening;
      await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
      return { requests, port: (listening.address() as AddressInfo).port };
    }

    /** The config with the direct provider's base URL moved to the test server: the loader refuses loopback. */
    const pointedAt = (config: OrchestratorConfig, port: number): OrchestratorConfig => ({
      ...config,
      customProviders: config.customProviders.map((p) => ({
        ...p,
        baseUrl: `http://127.0.0.1:${String(port)}/v1`,
      })),
    });
    const ask = async (config: OrchestratorConfig): Promise<{ stopReason: string }> => {
      const models = await buildModels(config, readCa);
      const model = models.getModel("omlx", "qwen3-30b");
      if (model === undefined) throw new Error("model missing");
      return models.completeSimple(model, {
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      });
    };
    const chunk = (delta: object, finish: string | null): string =>
      `data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

    it("calls a direct provider itself, without the gateway, with no credential, even with a token set", async () => {
      const { requests, port } = await serve(() => ({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
      }));
      // The gateway host does not resolve: a call that went through it would fail.
      const config = pointedAt(custom({ ONECLI_AGENT_TOKEN: TOKEN }), port);
      const result = await ask(config);
      expect(result.stopReason).toBe("stop");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe("/v1/chat/completions");
      expect(requests[0]?.authorization).toBe(`Bearer ${KEYLESS_API_KEY}`);
    }, 20_000);

    it("does not follow a redirect from a direct provider", async () => {
      const { requests, port } = await serve((url) =>
        url.startsWith("/v1/")
          ? { status: 302, headers: { location: "/elsewhere" } }
          : { status: 200 },
      );
      const result = await ask(pointedAt(custom(), port));
      expect(result.stopReason).toBe("error");
      expect(requests.map((r) => r.url)).toEqual(["/v1/chat/completions"]);
    }, 20_000);

    it("withFetch gives a provider its own fetch, which wins over the caller's, and the others the default", async () => {
      const seen: string[] = [];
      const tag =
        (name: string): FetchFunction =>
        () => {
          seen.push(name);
          return Promise.resolve(new Response(""));
        };
      const calls: { provider: string; fetch: FetchFunction | undefined }[] = [];
      // Stands in for Models: only what the wrapper touches.
      const stub = {
        stream: (
          model: { provider: string },
          _context: unknown,
          options?: { fetch?: FetchFunction },
        ) => calls.push({ provider: model.provider, fetch: options?.fetch }),
      };
      const wrapped = withFetch(
        stub as unknown as Parameters<typeof withFetch>[0],
        tag("gateway"),
        new Map([["omlx", tag("direct")]]),
      );
      const stream = (
        model: { provider: string },
        context: unknown,
        options?: { fetch?: FetchFunction },
      ): unknown =>
        (wrapped.stream as unknown as (...args: unknown[]) => unknown).call(
          wrapped,
          model,
          context,
          options,
        );
      stream({ provider: "omlx" }, {}, { fetch: tag("caller") });
      stream({ provider: "acme" }, {});
      for (const call of calls) await call.fetch?.("https://x.example/");
      expect(calls.map((c) => c.provider)).toEqual(["omlx", "acme"]);
      expect(seen).toEqual(["direct", "gateway"]);
    });
  });
});

describe("providerCredentials for custom providers", () => {
  const status = async (
    patterns: string[] | undefined,
    token: boolean,
  ): Promise<Record<string, string>> => {
    const config = custom(token ? { ONECLI_AGENT_TOKEN: TOKEN } : {});
    const models = await buildModels(config, readCa);
    const list =
      patterns === undefined
        ? undefined
        : () => Promise.resolve(patterns.map((hostPattern) => ({ hostPattern })));
    return Object.fromEntries(
      (await providerCredentials(models, config, list)).map((p) => [p.provider, p.credential]),
    );
  };

  it("counts a direct provider as configured: it is keyless, whatever OneCLI holds", async () => {
    expect((await status([], false)).omlx).toBe("configured");
    expect((await status(undefined, true)).omlx).toBe("configured");
  });

  it("matches a provider through OneCLI by the host of its base URL", async () => {
    expect((await status(["llm.acme.example"], true)).acme).toBe("configured");
    expect((await status(["*.acme.example"], true)).acme).toBe("configured");
    expect((await status(["api.openai.com"], true)).acme).toBe("missing");
    expect((await status(undefined, true)).acme).toBe("unknown");
  });
});
