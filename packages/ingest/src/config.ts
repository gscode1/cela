import {
  loadDatabaseTls,
  parseAdmins,
  parseSandboxRuntimes,
  parseSandboxSizes,
  parseSessionMailServer,
  settingsFromEnv,
} from "@cela/session-core";
import { parseConsoleCatalogs } from "./console.js";
import type { ConsoleCatalogs } from "./console.js";
import type { DatabaseTls, SandboxRuntimes, SandboxSizes, Settings } from "@cela/session-core";

/** Environment contract of ingest. The database URL and the API tokens are secrets: env-only, never logged. */
export interface IngestConfig {
  databaseUrl: string;
  /** TLS towards Postgres (`PI_DURABLE_DATABASE_TLS_*`); undefined leaves the URI's own `sslmode` alone. */
  databaseTls: DatabaseTls | undefined;
  /** `owner:token` entries, see session-core `tokenAuthenticator`. */
  apiTokens: string;
  /**
   * Base URL of the orchestrator's stream endpoint. With several shards it holds `{shard}`, which becomes the
   * session's shard (`http://orchestrator-{shard}:8081`); without it every stream goes to the one URL.
   */
  orchestratorUrl: string;
  /** How many orchestrator shards exist (`PI_ORCH_SHARDS`); a new session goes to the one with the fewest active. */
  shards: number;
  port: number;
  instance: string;
  /**
   * The settings the environment describes (`PI_MODEL_*`, `PI_SESSION_*_BUDGET`, `PI_REPO_ALLOWLIST`). Seed only: ingest writes them to
   * Postgres once, when the settings row is absent, and the table wins from then on.
   */
  seed: Settings;
  /** Owner names (`PI_API_ADMINS`) allowed to call `/admin/*`. */
  admins: string[];
  /** Built console (`PI_CONSOLE_DIR`, set by the chart's `console.enabled`); undefined serves no console. */
  consoleDir: string | undefined;
  /** `PI_CONSOLE_CATALOGS` (`manage` or `readOnly`, from the chart's `console.catalogs`). */
  consoleCatalogs: ConsoleCatalogs;
  /** `PI_SANDBOX_SIZES` and `PI_SANDBOX_DEFAULT_SIZE` (docs/decisions/0030-sandbox-sizes.md); undefined: no sizes. */
  sandboxSizes: SandboxSizes | undefined;
  /**
   * `PI_ALLOW_DIRECT_SANDBOX_EGRESS=true` (the chart's `security.allowDirectSandboxEgress`): profiles and sessions may
   * use `networkMode: direct` (docs/decisions/0038-network-modes.md). Default false: the API refuses it.
   */
  allowDirectSandboxEgress: boolean;
  /** `PI_SESSION_MAIL_SERVER` (the chart's `sessionMail.server`, ADR 0067): the reserved mail server's catalog name; unset: off. */
  sessionMailServer: string | undefined;
  /** `PI_SANDBOX_FLAVOURS` names `browser` (the chart's `sandbox.flavours.browser.enabled`, ADR 0041). */
  browserFlavourEnabled: boolean;
  /** `PI_SANDBOX_FLAVOURS` names `desktop` (the chart's `sandbox.flavours.desktop.enabled`, ADR 0065). */
  desktopFlavourEnabled: boolean;
  /**
   * `PI_LIVE_VIEW_PUBLIC_URL` (the chart's `liveView.publicUrl`): the origin viewers reach `/live/*` at, with no path.
   * Set means the public live view is on (ADR 0066); undefined: its routes are 404s and the API refuses `liveView`.
   */
  liveViewPublicUrl: string | undefined;
  /** `PI_LIVE_VIEW_DIR`: the viewer page, its script and the noVNC modules baked into the image. */
  liveViewDir: string | undefined;
  /** `PI_SANDBOX_RUNTIMES` (the chart's `sandbox.runtimes`, issue #406); `{}` when the deployment has none. */
  sandboxRuntimes: SandboxRuntimes;
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

/** `PI_LIVE_VIEW_PUBLIC_URL` as an origin, or undefined when unset. A path or a query would end up inside every URL handed out. */
export function parseLiveViewPublicUrl(value: string | undefined): string | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("PI_LIVE_VIEW_PUBLIC_URL must be an http or https URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    throw new Error("PI_LIVE_VIEW_PUBLIC_URL must be an http or https URL");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "") {
    throw new Error("PI_LIVE_VIEW_PUBLIC_URL must have no path, query or credentials");
  }
  return url.origin;
}

/** The orchestrator URL of one shard: the `{shard}` placeholder replaced, or the URL as it is. */
export function orchestratorUrlFor(template: string, shard: number): string {
  return template.replaceAll("{shard}", String(shard));
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>): IngestConfig {
  const databaseUrl = env.PI_DURABLE_DATABASE_URL;
  if (!databaseUrl) throw new Error("PI_DURABLE_DATABASE_URL is required");
  const enabledFlavours = (env.PI_SANDBOX_FLAVOURS ?? "").split(",").map((name) => name.trim());
  const apiTokens = env.PI_API_TOKENS;
  if (!apiTokens) throw new Error("PI_API_TOKENS is required");
  // Only an unset variable takes the default. An empty value must not become Number("") === 0, and port 0
  // binds a random port the Service and probes would never reach, so it is invalid too.
  const portText = env.PI_INGEST_PORT ?? "8080";
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : 0;
  if (port < 1 || port > 65535) throw new Error("PI_INGEST_PORT must be a port from 1 to 65535");
  const orchestratorUrl = env.PI_ORCH_URL;
  if (!orchestratorUrl?.trim()) throw new Error("PI_ORCH_URL is required");
  assertHttpUrl(orchestratorUrlFor(orchestratorUrl, 0));
  const shardsText = env.PI_ORCH_SHARDS ?? "1";
  const shards = /^\d{1,3}$/.test(shardsText) ? Number(shardsText) : 0;
  if (shards < 1) throw new Error("PI_ORCH_SHARDS must be an integer of 1 or more");
  if (shards > 1 && !orchestratorUrl.includes("{shard}"))
    throw new Error("PI_ORCH_URL must contain {shard} when PI_ORCH_SHARDS is above 1");
  const liveViewPublicUrl = parseLiveViewPublicUrl(env.PI_LIVE_VIEW_PUBLIC_URL);
  const liveViewDir = env.PI_LIVE_VIEW_DIR?.trim() || undefined;
  if (liveViewPublicUrl !== undefined && liveViewDir === undefined)
    throw new Error("PI_LIVE_VIEW_DIR is required when PI_LIVE_VIEW_PUBLIC_URL is set");
  return {
    databaseUrl,
    databaseTls: loadDatabaseTls(env),
    apiTokens,
    orchestratorUrl,
    shards,
    port,
    instance: env.POD_NAME ?? `ingest-${String(process.pid)}`,
    seed: settingsFromEnv(env),
    admins: parseAdmins(env.PI_API_ADMINS),
    consoleDir: env.PI_CONSOLE_DIR?.trim() || undefined,
    consoleCatalogs: parseConsoleCatalogs(env.PI_CONSOLE_CATALOGS),
    sandboxSizes: parseSandboxSizes(env),
    allowDirectSandboxEgress: env.PI_ALLOW_DIRECT_SANDBOX_EGRESS?.trim() === "true",
    sessionMailServer: parseSessionMailServer(env.PI_SESSION_MAIL_SERVER),
    browserFlavourEnabled: enabledFlavours.includes("browser"),
    desktopFlavourEnabled: enabledFlavours.includes("desktop"),
    liveViewPublicUrl,
    liveViewDir,
    sandboxRuntimes: parseSandboxRuntimes(env),
  };
}
