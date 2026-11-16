import { loadModelPolicy } from "@pi-durable-k8s/session-core";
import type { ModelPolicy } from "@pi-durable-k8s/session-core";

/** Environment contract of ingest. The database URL and the API tokens are secrets: env-only, never logged. */
export interface IngestConfig {
  databaseUrl: string;
  /** `owner:token` entries, see session-core `tokenAuthenticator`. */
  apiTokens: string;
  /** Base URL of the orchestrator's stream endpoint. */
  orchestratorUrl: string;
  port: number;
  instance: string;
  /** Default model and allowlist for POST /sessions (same variables as the orchestrator, from one ConfigMap). */
  models: ModelPolicy;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): IngestConfig {
  const databaseUrl = env.PI_DURABLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("PI_DURABLE_DATABASE_URL is required");
  const apiTokens = env.PI_API_TOKENS;
  if (!apiTokens) throw new Error("PI_API_TOKENS is required");
  const port = Number(env.PI_INGEST_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PI_INGEST_PORT is invalid");
  }
  return {
    databaseUrl,
    apiTokens,
    orchestratorUrl: env.PI_ORCH_URL ?? "http://pi-orchestrator:8081",
    port,
    instance: env.POD_NAME ?? `ingest-${String(process.pid)}`,
    models: loadModelPolicy(env),
  };
}
