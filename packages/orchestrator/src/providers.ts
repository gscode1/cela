import { readFile } from "node:fs/promises";
import { createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import type { FetchFunction, Model, Models, Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { errorMessage, modelKey } from "@cela/session-core";
import type { CredentialState, ModelCatalogEntry, ModelProviderStatus } from "@cela/session-core";
import type { OrchestratorConfig } from "./config.js";
import { directFetch } from "./custom-providers.js";
import type { CustomProvider } from "./custom-providers.js";
import { log } from "./log.js";
import { scriptedProvider } from "./model.js";
import type { Redacted } from "./onecli.js";
import {
  PLACEHOLDER_API_KEY,
  createGatewayFetch,
  placeholderAuthContext,
  placeholderCredentials,
  withFetch,
} from "./onecli.js";

/**
 * The `Models` of the orchestrator.
 *
 * Pi Durable stores a conversation's model as `{ provider, modelId }` names and resolves them against this `Models`
 * at every request, so every provider a stored conversation may name must be installed at every start: all builtin
 * providers when the OneCLI token is set (the allowlist only limits new sessions), the scripted ones, and `faux` for
 * the Phase 3 /control sessions. The operator's custom providers (ADR 0055) come after the builtin ones: those that go
 * through OneCLI with the token like the builtin ones, the keyless direct ones always.
 *
 * Real providers resolve their API key to a placeholder (`placeholderAuthContext`) and send their requests through
 * the OneCLI gateway, which replaces the placeholder with the credential it holds. Throws when an allowlisted model
 * is not in pi-ai's catalog, so a typo in the ConfigMap fails at start instead of at the first request.
 */
export async function buildModels(
  config: OrchestratorConfig,
  readCa: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<Models> {
  const models = createModels({
    authContext: placeholderAuthContext,
    credentials: await placeholderCredentials(config.onecli.codexAccountId),
  });
  models.setProvider(scriptedProvider({ provider: "faux" }).provider);
  models.setProvider(
    scriptedProvider({
      provider: "scripted",
      models: [{ id: "scripted-1" }, { id: "scripted-2" }],
    }).provider,
  );

  // A direct provider has no credential and never touches the gateway: its calls skip it, token or not.
  const direct = new Map<string, FetchFunction>();
  for (const custom of config.customProviders) {
    if (custom.via === "direct") {
      models.setProvider(customProvider(custom));
      direct.set(
        custom.id,
        directFetch(custom, (input, init) => globalThis.fetch(input, init)),
      );
    }
  }
  const token = config.onecli.token;
  if (token === undefined) {
    assertInstalled(models, config);
    return direct.size === 0 ? models : withFetch(models, noGatewayFetch, direct);
  }
  // Every builtin provider, not only the allowlisted ones: the allowlist governs new sessions (ingest checks it), but
  // an existing conversation keeps the model stored with it, so a provider whose last model was removed from the
  // allowlist must still resolve (docs/model-credentials.md). Without a token nothing can reach a provider anyway.
  for (const provider of builtinProviders()) models.setProvider(provider);
  for (const custom of config.customProviders) {
    if (custom.via === "onecli") models.setProvider(customProvider(custom));
  }
  assertInstalled(models, config);
  return withFetch(models, await buildGatewayFetch(config, token, readCa), direct);
}

/** What a direct (keyless) provider sends as its bearer value; see `customProvider`. */
export const KEYLESS_API_KEY = "keyless";

const noGatewayFetch: FetchFunction = () =>
  Promise.reject(new Error("ONECLI_AGENT_TOKEN is required: model calls go through the gateway"));

/**
 * One operator-defined OpenAI-compatible provider. A provider that goes through OneCLI resolves its API key to the same
 * placeholder as the builtin ones (`<ID>_API_KEY` through `placeholderAuthContext`); the gateway swaps in the secret
 * whose host pattern covers the base URL. A direct provider is keyless: pi-ai's client refuses to start without some
 * key, so it sends the constant `keyless`, which no server takes as a credential.
 */
function customProvider(custom: CustomProvider): Provider {
  const models: Model<"openai-completions">[] = custom.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: "openai-completions",
    provider: custom.id,
    baseUrl: custom.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: custom.compat,
  }));
  return createProvider({
    id: custom.id,
    baseUrl: custom.baseUrl,
    auth: {
      apiKey:
        custom.via === "direct"
          ? {
              name: custom.id,
              resolve: () => Promise.resolve({ auth: { apiKey: KEYLESS_API_KEY } }),
            }
          : envApiKeyAuth(custom.id, [`${custom.id.toUpperCase().replaceAll("-", "_")}_API_KEY`]),
    },
    models,
    api: openAICompletionsApi(),
  });
}

/** The orchestrator's one `fetch` through the OneCLI gateway: model calls and remote MCP calls share it. */
export async function buildGatewayFetch(
  config: OrchestratorConfig,
  token: Redacted,
  readCa: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): Promise<FetchFunction> {
  return createGatewayFetch({
    gateway: config.onecli.gateway,
    token,
    ca: await readCa(config.onecli.caFile),
    noProxy: config.onecli.noProxy,
  });
}

function assertInstalled(models: Models, config: OrchestratorConfig): void {
  for (const choice of config.models.allowed) {
    if (models.getModel(choice.provider, choice.model) === undefined) {
      throw new Error(`allowed model ${modelKey(choice)} is not known to pi-ai`);
    }
  }
}

/**
 * The models pi-ai knows here, for the admin console and the settings checks (docs/decisions/0025-model-catalog.md).
 * `faux` is the /control tests' own and stays out; `scripted` is in because tests and e2e use it. The catalog says what
 * pi-ai knows, not which providers have a credential.
 */
export function modelCatalog(models: Models): ModelCatalogEntry[] {
  return models
    .getModels()
    .filter((model) => model.provider !== "faux")
    .map((model) => ({
      provider: model.provider,
      id: model.id,
      ...(model.name !== "" && model.name !== model.id ? { name: model.name } : {}),
      reasoning: model.reasoning,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    }));
}

/**
 * True if an OneCLI secret's host pattern covers `host`: the same host (case-insensitive), or `*.suffix`, which covers
 * any subdomain of the suffix but not the suffix itself. A bare `*` is not taken as a match: a catch-all secret says
 * nothing about a provider. ASSUMED from the patterns this repo writes (`docs/onecli-host-rules.md`).
 */
export function hostPatternMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase();
  const h = host.toLowerCase();
  if (p.startsWith("*.")) return h.endsWith(p.slice(1)) && h.length > p.length - 1;
  return p === h;
}

/**
 * Per provider of the catalog, whether OneCLI holds a credential for it. A hint, never a proof: the key may be invalid
 * and the agent may lack the grant; only the first turn proves it. `unknown` for every real provider when there is no
 * admin client or the listing fails (logged without values); `scripted` needs none; the Codex login lives in the
 * OneCLI account, so a set `PI_CODEX_ACCOUNT_ID` counts. Never throws.
 */
export async function providerCredentials(
  models: Models,
  config: Pick<OrchestratorConfig, "onecli" | "customProviders">,
  listSecrets: (() => Promise<readonly { hostPattern?: string }[]>) | undefined,
): Promise<ModelProviderStatus[]> {
  let patterns: string[] | undefined;
  if (listSecrets !== undefined) {
    try {
      patterns = (await listSecrets()).flatMap((s) =>
        s.hostPattern === undefined ? [] : [s.hostPattern],
      );
    } catch (error) {
      log("model-credentials-unknown", { message: errorMessage(error) });
    }
  }
  const catalog = modelCatalog(models);
  const result: ModelProviderStatus[] = [];
  for (const provider of new Set(catalog.map((entry) => entry.provider))) {
    result.push({ provider, credential: credentialOf(models, provider, config, patterns) });
  }
  return result;
}

function credentialOf(
  models: Models,
  provider: string,
  config: Pick<OrchestratorConfig, "onecli" | "customProviders">,
  patterns: string[] | undefined,
): CredentialState {
  if (provider === "scripted") return "configured";
  // Keyless by design (ADR 0055): there is no credential to be missing.
  if (config.customProviders.some((custom) => custom.id === provider && custom.via === "direct"))
    return "configured";
  if (provider === "openai-codex" && config.onecli.codexAccountId !== PLACEHOLDER_API_KEY) {
    return "configured";
  }
  if (patterns === undefined) return "unknown";
  const hosts = new Set<string>();
  for (const model of models.getModels(provider)) {
    try {
      hosts.add(new URL(model.baseUrl).hostname);
    } catch {
      // A base URL that is a template or empty: this model's host is not known.
    }
  }
  if (hosts.size === 0) return "unknown";
  for (const host of hosts) {
    if (patterns.some((pattern) => hostPatternMatches(pattern, host))) return "configured";
  }
  return "missing";
}
