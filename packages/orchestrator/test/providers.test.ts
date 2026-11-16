import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { PLACEHOLDER_API_KEY } from "../src/onecli.ts";
import { buildModels } from "../src/providers.ts";

const base = {
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
        "pi-pg-rw",
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
