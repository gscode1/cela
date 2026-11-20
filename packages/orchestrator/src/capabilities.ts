import type pg from "pg";
import {
  checkProfileNames,
  errorMessage,
  publishCapabilities,
  readProfiles,
} from "@cela/session-core";
import type { Models } from "@earendil-works/pi-ai";
import { validateProfileDefinition } from "@cela/session-core";
import type { Capabilities, ModelProviderStatus, ProfileDefinition } from "@cela/session-core";
import type { OrchestratorConfig } from "./config.js";
import { log } from "./log.js";
import { mcpSecretCandidates } from "./onecli-names.js";
import { providerCredentials } from "./providers.js";

/**
 * At start: publishes the installed coding tools and extensions (ingest checks admin writes of profiles against them,
 * docs/decisions/0010-session-profiles.md) and logs every stored profile whose names do not resolve against them
 * (`profile-unresolved`). A tool that no longer exists leaves a session of that profile without it, never with more, so
 * this is a warning and never blocks the start. Returns the unresolved profile names.
 */
export async function publishAndCheckProfiles(
  pool: pg.Pool,
  capabilities: Capabilities,
  instance: string,
): Promise<string[]> {
  try {
    await publishCapabilities(pool, capabilities, instance);
    const catalog = await readProfiles(pool);
    for (const bad of catalog.invalid) log("profile-invalid", bad);
    const unresolved: string[] = [];
    for (const profile of catalog.profiles) {
      // MCP servers are checked at use (a catalog change needs no restart): only the tools are resolved here.
      const message = checkProfileNames(
        { ...profile.definition, mcpServers: [] },
        { tools: capabilities.tools, mcpServers: [] },
      );
      if (message !== undefined) {
        unresolved.push(profile.name);
        log("profile-unresolved", { profile: profile.name, message });
      }
    }
    return unresolved;
  } catch (error) {
    log("capabilities-publish-failed", { message: errorMessage(error) });
    return [];
  }
}

/**
 * The profile snapshots of the sessions that still have a conversation, by conversation id, for `Host.open` to
 * recompute their tool filters before runs resume. An unreadable database or snapshot is skipped and logged: the
 * filters are also recomputed at each input.
 */
export async function liveConversationProfiles(
  pool: pg.Pool,
  shard: number,
): Promise<Map<number, ProfileDefinition>> {
  const found = new Map<number, ProfileDefinition>();
  try {
    const { rows } = await pool.query<{ conversation_id: string; profile_snapshot: unknown }>(
      `select conversation_id, profile_snapshot from inbox.sessions
        where shard = $1 and conversation_id is not null and profile_snapshot is not null and status <> 'deleted'`,
      [shard],
    );
    for (const row of rows) {
      const definition = validateProfileDefinition(row.profile_snapshot);
      if (typeof definition === "string") {
        log("profile-snapshot-invalid", { conversation: row.conversation_id, message: definition });
        continue;
      }
      found.set(Number(row.conversation_id), definition);
    }
  } catch (error) {
    log("profile-tools-reapply-skipped", { message: errorMessage(error) });
  }
  return found;
}

type ListSecrets = () => Promise<readonly { name: string; hostPattern?: string }[]>;

/**
 * What the start publish says about OneCLI's secrets: the per-provider credential hint (ADR 0025) and the names an MCP
 * server could reference (ADR 0040 amendment), from one listing. Without an admin client, or when the listing fails
 * (logged without values), every real provider is `unknown` and the names are absent, never empty. Never throws.
 */
export async function oneCliSecretsView(
  models: Models,
  config: Pick<OrchestratorConfig, "onecli">,
  listSecrets: ListSecrets | undefined,
): Promise<Pick<Capabilities, "modelProviders" | "onecliSecretNames">> {
  let secrets: readonly { name: string; hostPattern?: string }[] | undefined;
  if (listSecrets !== undefined) {
    try {
      secrets = await listSecrets();
    } catch (error) {
      log("model-credentials-unknown", { message: errorMessage(error) });
    }
  }
  const listed = secrets;
  return {
    modelProviders: await providerCredentials(
      models,
      config,
      listed === undefined ? undefined : () => Promise.resolve(listed),
    ),
    ...(listed === undefined ? {} : { onecliSecretNames: mcpSecretCandidates(listed) }),
  };
}

export interface ModelCredentialsDeps {
  models: Models;
  config: Pick<OrchestratorConfig, "onecli">;
  listSecrets: ListSecrets;
  /** Writes the hint (`publishModelProviders`); true if it changed. */
  publish: (providers: readonly ModelProviderStatus[]) => Promise<boolean>;
  /** Writes the secret names an MCP server could reference (`publishOnecliSecretNames`); true if they changed. */
  publishSecretNames: (names: readonly string[]) => Promise<boolean>;
}

/**
 * Keeps the per-provider credential hint (ADR 0025) and the MCP secret names (ADR 0040 amendment) current, so a secret
 * added to OneCLI shows in the console without a restart. Shard 0 runs it. A failed listing keeps the last values:
 * publishing `unknown` would empty the console's model list on every OneCLI blip. The catalog itself changes only with
 * a new image, so it stays a start-time publish.
 */
export class ModelCredentialsLoop {
  readonly #deps: ModelCredentialsDeps;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: ModelCredentialsDeps) {
    this.#deps = deps;
  }

  start(intervalMs: number): void {
    this.#timer = setInterval(() => void this.run(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One check. Returns whether the hint or the names changed; never throws. Skipped while the previous one still runs. */
  async run(): Promise<boolean> {
    if (this.#running) return false;
    this.#running = true;
    try {
      const d = this.#deps;
      const secrets = await d.listSecrets();
      const providers = await providerCredentials(d.models, d.config, () =>
        Promise.resolve(secrets),
      );
      const changed = await d.publish(providers);
      if (changed) {
        log("model-credentials-refreshed", {
          configured: providers.filter((p) => p.credential === "configured").map((p) => p.provider),
        });
      }
      const names = mcpSecretCandidates(secrets);
      const namesChanged = await d.publishSecretNames(names);
      // A count only: the names are not secret, but a log line has no need for them.
      if (namesChanged) log("onecli-secret-names-refreshed", { count: names.length });
      return changed || namesChanged;
    } catch (error) {
      log("model-credentials-refresh-failed", { message: errorMessage(error) });
      return false;
    } finally {
      this.#running = false;
    }
  }
}
