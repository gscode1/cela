import { readFile } from "node:fs/promises";
import type { Models } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { modelKey } from "@pi-durable-k8s/session-core";
import type { OrchestratorConfig } from "./config.js";
import { scriptedProvider } from "./model.js";
import {
  createGatewayFetch,
  placeholderAuthContext,
  placeholderCredentials,
  withFetch,
} from "./onecli.js";

const LOCAL = new Set(["scripted", "faux"]);

/**
 * The `Models` of the orchestrator.
 *
 * Pi Durable stores a conversation's model as `{ provider, modelId }` names and resolves them against this `Models`
 * at every request, so every provider a stored conversation may name must be installed at every start: the
 * allowlist's providers, the scripted ones, and `faux` for the Phase 3 /control sessions.
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

  const remote = config.models.allowed.filter((choice) => !LOCAL.has(choice.provider));
  const token = config.onecli.token;
  if (remote.length === 0 || token === undefined) {
    assertInstalled(models, config);
    return models;
  }
  const wanted = new Set(remote.map((choice) => choice.provider));
  for (const provider of builtinProviders()) {
    if (wanted.has(provider.id)) models.setProvider(provider);
  }
  assertInstalled(models, config);
  const ca = await readCa(config.onecli.caFile);
  return withFetch(
    models,
    createGatewayFetch({
      gateway: config.onecli.gateway,
      token,
      ca,
      noProxy: config.onecli.noProxy,
    }),
  );
}

function assertInstalled(models: Models, config: OrchestratorConfig): void {
  for (const choice of config.models.allowed) {
    if (models.getModel(choice.provider, choice.model) === undefined) {
      throw new Error(`allowed model ${modelKey(choice)} is not known to pi-ai`);
    }
  }
}
