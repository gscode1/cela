import { parseAdmins, settingsFromEnv } from "@pi-durable-k8s/session-core";
import type { Settings } from "@pi-durable-k8s/session-core";

/** Environment contract of ingest. The database URL and the API tokens are secrets: env-only, never logged. */
export interface IngestConfig {
  databaseUrl: string;
  /** `owner:token` entries, see session-core `tokenAuthenticator`. */
  apiTokens: string;
  /** Base URL of the orchestrator's stream endpoint. */
  orchestratorUrl: string;
  port: number;
  instance: string;
  /**
   * The settings the environment describes (`PI_MODEL_*`, `PI_SESSION_TURN_BUDGET`). Seed only: ingest writes them to
   * Postgres once, when the settings row is absent, and the table wins from then on.
   */
  seed: Settings;
  /** Owner names (`PI_API_ADMINS`) allowed to call `/admin/*`. */
  admins: string[];
}

/** The stream proxy makes plain http(s) requests; anything else would 500 on every stream while /readyz stays green. */
function assertHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PI_ORCH_URL must be an http or https URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new Error("PI_ORCH_URL must be an http or https URL");
  }
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): IngestConfig {
  const databaseUrl = env.PI_DURABLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("PI_DURABLE_DATABASE_URL is required");
  const apiTokens = env.PI_API_TOKENS;
  if (!apiTokens) throw new Error("PI_API_TOKENS is required");
  // Only an unset variable takes the default. An empty value must not become Number("") === 0, and port 0
  // binds a random port the Service and probes would never reach, so it is invalid too.
  const portText = env.PI_INGEST_PORT ?? "8080";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65535) throw new Error("PI_INGEST_PORT must be a port from 1 to 65535");
  const orchestratorUrl = env.PI_ORCH_URL ?? "http://pi-orchestrator:8081";
  assertHttpUrl(orchestratorUrl);
  return {
    databaseUrl,
    apiTokens,
    orchestratorUrl,
    port,
    instance: env.POD_NAME ?? `ingest-${String(process.pid)}`,
    seed: settingsFromEnv(env),
    admins: parseAdmins(env.PI_API_ADMINS),
  };
}
