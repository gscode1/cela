import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { directFetch, parseCustomProviders } from "../src/custom-providers.ts";

const OMLX = {
  id: "omlx",
  baseUrl: "http://192.168.7.101:8000/v1",
  via: "direct",
  egress: { cidr: "192.168.7.101/32", port: 8000 },
  models: [{ id: "qwen3-30b", contextWindow: 32768, maxTokens: 8192 }],
};
const GENERIC = {
  id: "acme",
  baseUrl: "https://llm.acme.example/v1/",
  models: [{ id: "acme-1", contextWindow: 128000, maxTokens: 4096, reasoning: true }],
};
const parse = (value: unknown): ReturnType<typeof parseCustomProviders> =>
  parseCustomProviders(JSON.stringify(value));
const withProvider = (patch: Record<string, unknown>, base: object = OMLX): unknown[] => [
  { ...base, ...patch },
];

describe("parseCustomProviders", () => {
  it("is empty when unset or blank", () => {
    expect(parseCustomProviders(undefined)).toEqual([]);
    expect(parseCustomProviders("  ")).toEqual([]);
    expect(parse([])).toEqual([]);
  });

  it("applies the defaults: onecli transport, text input, no reasoning, no developer role or reasoning_effort", () => {
    const [acme] = parse([{ ...GENERIC, models: [{ id: "m", contextWindow: 10, maxTokens: 5 }] }]);
    expect(acme).toMatchObject({
      id: "acme",
      via: "onecli",
      // The trailing slash goes: pi-ai appends the path itself.
      baseUrl: "https://llm.acme.example/v1",
      compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      models: [
        { id: "m", name: "m", reasoning: false, input: ["text"], contextWindow: 10, maxTokens: 5 },
      ],
    });
    expect(acme?.egress).toBeUndefined();
  });

  it("reads the oMLX example and a whitelisted compat subset", () => {
    const [omlx] = parse(
      withProvider({
        compat: {
          supportsDeveloperRole: true,
          maxTokensField: "max_tokens",
          requiresToolResultName: true,
        },
        models: [
          { id: "m", name: "Model", contextWindow: 10, maxTokens: 5, input: ["text", "image"] },
        ],
      }),
    );
    expect(omlx).toMatchObject({
      via: "direct",
      egress: { cidr: "192.168.7.101/32", port: 8000 },
      compat: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
        maxTokensField: "max_tokens",
        requiresToolResultName: true,
      },
      models: [{ name: "Model", input: ["text", "image"] }],
    });
  });

  it.each<[string, unknown, RegExp]>([
    ["not JSON", "{", /not valid JSON/],
    ["not a list", {}, /must be a list/],
    ["builtin id", withProvider({ id: "openai" }, GENERIC), /builtin provider/],
    ["scripted id", withProvider({ id: "scripted" }, GENERIC), /builtin provider/],
    ["faux id", withProvider({ id: "faux" }, GENERIC), /builtin provider/],
    ["bad id", withProvider({ id: "Acme_1" }, GENERIC), /\.id must match/],
    ["id with a slash", withProvider({ id: "a/b" }, GENERIC), /\.id must match/],
    ["duplicate provider", [GENERIC, GENERIC], /defined twice/],
    [
      "duplicate model",
      withProvider({ models: [GENERIC.models[0], GENERIC.models[0]] }, GENERIC),
      /acme-1 is defined twice/,
    ],
    ["no models", withProvider({ models: [] }, GENERIC), /at least one model/],
    [
      "model id with a comma",
      withProvider({ models: [{ id: "a,b", contextWindow: 2, maxTokens: 1 }] }, GENERIC),
      /spaces or commas/,
    ],
    [
      "missing contextWindow",
      withProvider({ models: [{ id: "m", maxTokens: 1 }] }, GENERIC),
      /contextWindow/,
    ],
    [
      "maxTokens above the window",
      withProvider({ models: [{ id: "m", contextWindow: 1, maxTokens: 2 }] }, GENERIC),
      /must not exceed/,
    ],
    [
      "image-only input",
      withProvider(
        { models: [{ id: "m", contextWindow: 2, maxTokens: 1, input: ["image"] }] },
        GENERIC,
      ),
      /include text/,
    ],
    ["bad via", withProvider({ via: "proxy" }, GENERIC), /onecli or direct/],
    ["bad URL", withProvider({ baseUrl: "llm.acme.example" }, GENERIC), /absolute http/],
    [
      "URL credentials",
      withProvider({ baseUrl: "https://u:p@llm.acme.example/v1" }, GENERIC),
      /credentials/,
    ],
    ["URL query", withProvider({ baseUrl: "https://llm.acme.example/v1?key=1" }, GENERIC), /query/],
    ["unknown field", withProvider({ extra: 1 }, GENERIC), /not a known field/],
    [
      "unknown compat flag",
      withProvider({ compat: { openRouterRouting: {} } }, GENERIC),
      /not a known field/,
    ],
    [
      "bad compat value",
      withProvider({ compat: { maxTokensField: "x" } }, GENERIC),
      /maxTokensField/,
    ],
    // onecli
    ["http for onecli", withProvider({ baseUrl: "http://llm.acme.example/v1" }, GENERIC), /https/],
    [
      "IPv4 literal for onecli",
      withProvider({ baseUrl: "https://192.168.7.101/v1" }, GENERIC),
      /host name, not an IP/,
    ],
    [
      "IPv6 literal for onecli",
      withProvider({ baseUrl: "https://[2001:db8::1]/v1" }, GENERIC),
      /host name, not an IP/,
    ],
    [
      "egress on onecli",
      withProvider({ egress: { cidr: "10.0.0.1/32", port: 443 } }, GENERIC),
      /direct provider/,
    ],
    // direct, keyless only
    ["a key on direct", withProvider({ apiKey: "sk-x" }), /hold no credential/],
    ["a token on direct", withProvider({ token: "x" }), /hold no credential/],
    ["headers on direct", withProvider({ headers: { authorization: "x" } }), /hold no credential/],
    [
      "a key in egress",
      withProvider({ egress: { cidr: "192.168.7.101/32", port: 8000, key: "x" } }),
      /hold no credential/,
    ],
    // direct, network
    ["direct without egress", withProvider({ egress: undefined }), /egress is required/],
    [
      "egress port not the URL's",
      withProvider({ egress: { cidr: "192.168.7.101/32", port: 8001 } }),
      /port of baseUrl/,
    ],
    [
      "URL outside the egress cidr",
      withProvider({ egress: { cidr: "192.168.8.0/24", port: 8000 } }),
      /outside egress\.cidr/,
    ],
    ["IPv6 egress", withProvider({ egress: { cidr: "fd00::1/128", port: 8000 } }), /IPv4 CIDR/],
    [
      "metadata range",
      withProvider({
        baseUrl: "http://169.254.169.254:8000/v1",
        egress: { cidr: "169.254.169.254/32", port: 8000 },
      }),
      /169\.254\.0\.0\/16/,
    ],
    [
      "CGNAT range",
      withProvider({
        baseUrl: "http://100.64.1.1:8000/v1",
        egress: { cidr: "100.64.0.0/10", port: 8000 },
      }),
      /100\.64\.0\.0\/10/,
    ],
    [
      "loopback range",
      withProvider({
        baseUrl: "http://127.0.0.1:8000/v1",
        egress: { cidr: "127.0.0.1/32", port: 8000 },
      }),
      /127\.0\.0\.0\/8/,
    ],
    [
      "a cidr that contains a forbidden range",
      withProvider({ egress: { cidr: "0.0.0.0/0", port: 8000 } }),
      /may not use/,
    ],
    [
      "a /8 that contains loopback",
      withProvider({
        egress: { cidr: "127.0.0.0/8", port: 8000 },
        baseUrl: "http://192.168.7.101:8000/v1",
      }),
      /127\.0\.0\.0\/8/,
    ],
    [
      "localhost",
      withProvider({
        baseUrl: "http://localhost:8000/v1",
        egress: { cidr: "192.168.7.0/24", port: 8000 },
      }),
      /loopback/,
    ],
    [
      "an IPv6 literal URL",
      withProvider({
        baseUrl: "http://[fd00::1]:8000/v1",
        egress: { cidr: "192.168.7.0/24", port: 8000 },
      }),
      /IPv4 address or a host name/,
    ],
  ])("rejects %s", (_name, value, message) => {
    expect(() => (typeof value === "string" ? parseCustomProviders(value) : parse(value))).toThrow(
      message,
    );
  });

  it("does not echo the input when it is not JSON", () => {
    expect(() => parseCustomProviders("{ secret-looking-value")).toThrow(
      new Error("PI_CUSTOM_MODEL_PROVIDERS is not valid JSON"),
    );
  });

  it("allows a direct provider by host name, default port and any port", () => {
    const [named] = parse(
      withProvider({
        baseUrl: "https://mlx.lan/v1",
        egress: { cidr: "192.168.7.0/24", port: 443 },
      }),
    );
    expect(named?.via).toBe("direct");
    expect(
      parse(
        withProvider({
          baseUrl: "http://192.168.7.101/v1",
          egress: { cidr: "192.168.7.0/24", port: 80 },
        }),
      ),
    ).toHaveLength(1);
  });
});

describe("loadConfig with custom providers", () => {
  const env = {
    PI_ORCH_NAMESPACE: "test-ns",
    PI_ORCH_WARMPOOL: "test-pool",
    PI_ONECLI_GATEWAY: "http://gateway:10255",
    PI_ONECLI_API: "http://gateway-api:10256",
    PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
    PI_API_TOKENS: "alice:0123456789abcdef0123",
  };

  it("is empty by default and parses PI_CUSTOM_MODEL_PROVIDERS", () => {
    expect(loadConfig(env).customProviders).toEqual([]);
    const config = loadConfig({ ...env, PI_CUSTOM_MODEL_PROVIDERS: JSON.stringify([OMLX]) });
    expect(config.customProviders.map((p) => p.id)).toEqual(["omlx"]);
  });

  it("needs no OneCLI token for an allowlisted direct provider, but does for one through OneCLI", () => {
    const providers = JSON.stringify([OMLX, GENERIC]);
    expect(() =>
      loadConfig({
        ...env,
        PI_CUSTOM_MODEL_PROVIDERS: providers,
        PI_MODEL_ALLOWLIST: "omlx/qwen3-30b",
      }),
    ).not.toThrow();
    expect(() =>
      loadConfig({
        ...env,
        PI_CUSTOM_MODEL_PROVIDERS: providers,
        PI_MODEL_ALLOWLIST: "acme/acme-1",
      }),
    ).toThrow(/ONECLI_AGENT_TOKEN is required for model provider acme/);
  });

  it("refuses an onecli provider whose host NO_PROXY would send around the gateway", () => {
    const provider = (baseUrl: string): string => JSON.stringify([{ ...GENERIC, baseUrl }]);
    for (const baseUrl of [
      "https://llm.cluster.local/v1",
      "https://x.svc/v1",
      "https://llm.corp.internal/v1",
    ]) {
      expect(
        () =>
          loadConfig({
            ...env,
            NO_PROXY: "corp.internal",
            PI_CUSTOM_MODEL_PROVIDERS: provider(baseUrl),
          }),
        baseUrl,
      ).toThrow(/NO_PROXY/);
    }
    // A host name on a LAN is not caught by the default NO_PROXY, which lists only the private ranges and cluster names.
    expect(() =>
      loadConfig({ ...env, PI_CUSTOM_MODEL_PROVIDERS: provider("https://mlx.lan/v1") }),
    ).not.toThrow();
  });
});

describe("directFetch", () => {
  const recorder = (): { calls: { url: string; redirect: unknown }[]; fetch: typeof fetch } => {
    const calls: { url: string; redirect: unknown }[] = [];
    return {
      calls,
      fetch: (input, init) => {
        calls.push({ url: typeof input === "string" ? input : "other", redirect: init?.redirect });
        return Promise.resolve(new Response("ok"));
      },
    };
  };

  it("sets redirect to error, whatever the caller asked", async () => {
    const { calls, fetch } = recorder();
    const direct = directFetch({ baseUrl: "http://192.168.7.101:8000/v1" }, fetch);
    await direct("http://192.168.7.101:8000/v1/chat/completions", { redirect: "follow" });
    expect(calls).toEqual([
      { url: "http://192.168.7.101:8000/v1/chat/completions", redirect: "error" },
    ]);
  });

  it("calls only the origin of its own base URL", async () => {
    const { calls, fetch } = recorder();
    const direct = directFetch({ baseUrl: "http://192.168.7.101:8000/v1" }, fetch);
    await expect(direct("http://192.168.7.102:8000/v1/x")).rejects.toThrow(/may only call/);
    await expect(direct("http://192.168.7.101:9000/v1/x")).rejects.toThrow(/may only call/);
    expect(calls).toEqual([]);
  });
});
