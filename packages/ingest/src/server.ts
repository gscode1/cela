import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import type pg from "pg";
import { orchestratorUrlFor } from "./config.js";
import { handleAdminEgress } from "./egress-routes.js";
import { isConsolePath, serveConsole, setConsoleHeaders } from "./console.js";
import type { ConsoleCatalogs } from "./console.js";
import {
  AdminBlockedError,
  AdminConflictError,
  BodyError,
  BUILTIN_TOOL_NAMES,
  buildZip,
  chooseModel,
  chooseSandboxSize,
  chooseRepo,
  createSession,
  enqueueEvent,
  errorMessage,
  getSession,
  newLiveViewToken,
  setLiveViewToken,
  deleteMcpServer,
  deleteProfile,
  deleteSkill,
  StaleProfileError,
  isAdmin,
  LEGACY_PROFILE,
  listMcpServerHistory,
  listProfileVersions,
  listSettingsHistory,
  mcpServerNameError,
  syncMcpRulesFromCatalog,
  listSkillVersions,
  parseExpectedRevision,
  profileNameError,
  putMcpServer,
  putSkillVersion,
  readSkill,
  readSkillBundle,
  readSkills,
  readSkillVersion,
  SKILL_BODY_LIMIT,
  skillNameError,
  verifySkillBundle,
  validateProfileDefinition,
  putProfile,
  catalogKeys,
  readCapabilities,
  readMcpServers,
  readEgress,
  countDirectSessions,
  directModeConflict,
  DIRECT_NOT_ALLOWED,
  networkModeOf,
  sandboxFlavourOf,
  DEFAULT_SANDBOX_RUNTIME,
  sandboxRuntimeConflict,
  sandboxRuntimeOf,
  flavourNotEnabled,
  flavourWithRepo,
  isUntrustedContentFlavour,
  untrustedFlavourConflict,
  readProfile,
  readProfiles,
  readJsonObject,
  sendBodyError,
  canonicalRepo,
  readSettings,
  PROBE_SHARD,
  readMcpDiscovery,
  readShardStatus,
  discoveryView,
  requestNetworkProbe,
  updateSettings,
  beginDelete,
  requeueFailedDelete,
  sendJson,
  summarize,
  getEvent,
  UUID,
} from "@cela/session-core";
import type {
  McpDiscoveryOutcome,
  ModelCatalogEntry,
  ModelProviderStatus,
  Authenticator,
  ModelChoice,
  ModelPolicy,
  Principal,
  ProfileDefinition,
  ProfileSnapshot,
  SandboxRuntimes,
  SandboxSizes,
  SessionRow,
  Settings,
  SkillVersionMeta,
  StoredMcpServer,
  StoredProfile,
  StoredSettings,
} from "@cela/session-core";
import { eventView, parseEventBody, parseEventId } from "./events.js";
import { getFeed, streamFeed } from "./feed-routes.js";
import { handleLiveUpgrade, isLivePath, liveViewUrl, serveLive } from "./live-view.js";
import { log } from "./log.js";

export interface IngestDeps {
  pool: pg.Pool;
  authenticate: Authenticator;
  /** Stream endpoint of the orchestrator; may hold `{shard}` (see `IngestConfig.orchestratorUrl`). */
  orchestratorUrl: string;
  /** Number of orchestrator shards; default 1. */
  shards?: number;
  /** The settings cache: the model policy for POST /sessions and GET, refreshed after an admin write. */
  settings: SettingsView;
  /** Owner names allowed to call `/admin/*`. */
  admins: readonly string[];
  /** Directory of the built console (`PI_CONSOLE_DIR`); undefined: `/console` is a 404. */
  consoleDir?: string | undefined;
  /** What the console's catalog screens offer (`PI_CONSOLE_CATALOGS`); default `manage`. UI gating only. */
  consoleCatalogs?: ConsoleCatalogs | undefined;
  /** False until the inbox schema is migrated; liveness does not wait for it, readiness and the API do. */
  schemaReady: () => boolean;
  /** The deployment's sandbox sizes (`PI_SANDBOX_SIZES`); undefined: none, sessions get the unsized pool. */
  sandboxSizes?: SandboxSizes | undefined;
  /** `networkMode: direct` is allowed (`PI_ALLOW_DIRECT_SANDBOX_EGRESS`, ADR 0038); default: refused with a 400. */
  allowDirectSandboxEgress?: boolean | undefined;
  /** Browser sandboxes are rendered (`PI_SANDBOX_FLAVOURS` names `browser`, ADR 0041); default: refused with a 400. */
  browserFlavourEnabled?: boolean | undefined;
  /** Desktop sandboxes are rendered (`PI_SANDBOX_FLAVOURS` names `desktop`, ADR 0065); default: refused with a 400. */
  desktopFlavourEnabled?: boolean | undefined;
  /** The named sandbox runtimes (`PI_SANDBOX_RUNTIMES`, the chart's `sandbox.runtimes`, issue #406); default: none. */
  sandboxRuntimes?: SandboxRuntimes | undefined;
  /** `PI_LIVE_VIEW_PUBLIC_URL` (the chart's `liveView.publicUrl`, ADR 0066); undefined: no live view, `/live/*` is a 404. */
  liveViewPublicUrl?: string | undefined;
  /** `PI_LIVE_VIEW_DIR`: the viewer page, its script and noVNC, served at `/live/_assets/*`. */
  liveViewDir?: string | undefined;
}

export interface SettingsView {
  get(): Settings;
  policy(): ModelPolicy;
  /** Re-reads the row now, so a write is visible to the next request on this replica. */
  refresh(): Promise<void>;
}

const liveViewOf = (deps: IngestDeps) => ({
  pool: deps.pool,
  publicUrl: deps.liveViewPublicUrl,
  dir: deps.liveViewDir,
  orchestratorUrl: deps.orchestratorUrl,
});

export function createIngestServer(deps: IngestDeps): Server {
  const server = createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      log("http-error", { message: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
  // The only upgrade ingest serves is the anonymous live view's WebSocket; every other one is dropped.
  server.on("upgrade", (req, socket, head) => {
    // Node has removed its error listener by now: a reset during the token lookup would otherwise end the process.
    socket.on("error", () => socket.destroy());
    if (!deps.schemaReady() || !isLivePath(req.url ?? "")) {
      socket.destroy();
      return;
    }
    void handleLiveUpgrade(req, socket, head, liveViewOf(deps));
  });
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: IngestDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // The console is static and holds no secret, so it is served before the schema check and the bearer gate.
  if (isConsolePath(url.pathname)) {
    await serveConsole(req, res, url.pathname, deps.consoleDir, deps.consoleCatalogs);
    return;
  }
  if (parts[0] === "admin") setConsoleHeaders(res);

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  if (method === "GET" && url.pathname === "/readyz") {
    // Ready means "can accept events": the schema is migrated and the database answers. The orchestrator is
    // deliberately not checked.
    if (!deps.schemaReady()) {
      sendJson(res, 503, { status: "migrating" });
      return;
    }
    try {
      await deps.pool.query("select 1");
      sendJson(res, 200, { status: "ready" });
    } catch {
      sendJson(res, 503, { status: "database unavailable" });
    }
    return;
  }

  if (!deps.schemaReady()) {
    sendJson(res, 503, { error: "starting" }, { "retry-after": "2" });
    return;
  }

  // The live view's viewer page and assets (ADR 0066): the token in the URL is the credential, so no bearer. Only when
  // the schema is ready, because the token is looked up in it.
  if (isLivePath(url.pathname)) {
    await serveLive(req, res, url.pathname, liveViewOf(deps));
    return;
  }

  // Every route below is behind this one check.
  const principal = await deps.authenticate(req.headers);
  if (principal === undefined) {
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }

  if (parts[0] === "admin") {
    await handleAdmin(req, res, deps, principal, url, parts);
    return;
  }
  if (method === "POST" && url.pathname === "/sessions") {
    await postSession(req, res, deps, principal);
    return;
  }
  // The caller's own feed (ADR 0058): keyed by the subject, like the owner check of every session route.
  if (method === "GET" && url.pathname === "/events") {
    await getFeed(res, deps.pool, principal.subject, url);
    return;
  }
  if (method === "GET" && url.pathname === "/events/stream") {
    streamFeed(req, res, deps.pool, principal.subject);
    return;
  }
  if (parts[0] !== "sessions" || parts[1] === undefined) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const session = await ownedSession(deps.pool, parts[1], principal);
  if (session === undefined) {
    // Unknown id and someone else's id look the same: the API does not reveal that a session exists.
    sendJson(res, 404, { error: "session not found" });
    return;
  }

  if (parts.length === 2 && method === "GET") {
    const summary = await summarize(deps.pool, session);
    sendJson(res, 200, {
      sessionId: session.id,
      status: summary.status,
      model: modelOf(session, deps.settings.policy()),
      profile: session.profile === null ? LEGACY_PROFILE : profileRef(session.profile),
      ...skillsOf(session),
      ...repoFlagsOf(session),
      ...(session.repo === null ? {} : { repo: session.repo }),
      ...(session.failure === null ? {} : { failure: session.failure }),
      ...(session.usage === null ? {} : { usage: session.usage }),
      ...(session.sandboxSize === null ? {} : { sandboxSize: session.sandboxSize }),
      networkMode: session.networkMode,
      sandboxFlavour: session.sandboxFlavour,
      sandboxRuntime: session.sandboxRuntime ?? DEFAULT_SANDBOX_RUNTIME,
      ...liveViewFields(deps, session.liveViewToken),
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: summary.lastActivityAt.toISOString(),
      events: summary.events,
    });
    return;
  }
  if (parts.length === 2 && method === "DELETE") {
    await queueDelete(deps.pool, session, res);
    return;
  }
  if (parts.length === 3 && parts[2] === "live-view" && method === "PUT") {
    await putLiveView(deps, session, res);
    return;
  }
  if (parts.length === 3 && parts[2] === "live-view" && method === "DELETE") {
    await setLiveViewToken(deps.pool, session.id, null);
    res.writeHead(204);
    res.end();
    return;
  }
  if (parts.length === 3 && parts[2] === "events" && method === "POST") {
    await postEvent(req, res, deps.pool, session, principal);
    return;
  }
  if (parts.length === 4 && parts[2] === "events" && method === "GET") {
    const eventId = parseEventId(parts[3] ?? "");
    const event =
      eventId === undefined ? undefined : await getEvent(deps.pool, session.id, eventId);
    if (event === undefined) {
      sendJson(res, 404, { error: "event not found" });
      return;
    }
    sendJson(res, 200, eventView(event));
    return;
  }
  if (parts.length === 3 && parts[2] === "stream" && method === "GET") {
    if (session.status === "deleted") {
      sendJson(res, 410, { error: "session deleted" });
      return;
    }
    proxyStream(req, res, orchestratorUrlFor(deps.orchestratorUrl, session.shard), session.id);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 500;

/**
 * `/admin/*`: only the owners in `PI_API_ADMINS` (403 for any other authenticated caller). A write the stored state
 * refuses (a stale `expectedRevision`, disabling the default profile) throws `AdminConflictError` from inside its
 * transaction, which rolled back: it is a 409 here.
 */
async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
  url: URL,
  parts: string[],
): Promise<void> {
  try {
    await handleAdminRoutes(req, res, deps, principal, url, parts);
  } catch (error) {
    if (!(error instanceof AdminConflictError)) throw error;
    sendJson(res, 409, {
      error: error.message,
      ...(error instanceof AdminBlockedError ? { blockedBy: error.blockedBy } : {}),
    });
  }
}

/**
 * The `?expectedRevision=N` of a DELETE, which a delete must carry (ADR 0027): the caller proves it saw the current
 * state. The number, or the message for a 400.
 */
function requiredRevisionParam(url: URL): number | string {
  const asked = url.searchParams.get("expectedRevision");
  if (asked === null)
    return "expectedRevision is required: DELETE ...?expectedRevision=<current revision>";
  const parsed = parseExpectedRevision(/^[0-9]{1,10}$/.test(asked) ? Number(asked) : asked);
  return parsed ?? "expectedRevision must be a positive integer";
}

/**
 * `expectedRevision` taken out of a body, so the rest can go to a validator that refuses unknown keys. `create`: the
 * write can create, so 0 ("must not exist yet") is allowed.
 */
function takeExpectedRevision(
  body: Record<string, unknown>,
  options: { create?: boolean } = {},
): { expectedRevision: number | undefined; rest: Record<string, unknown> } | string {
  const { expectedRevision, ...rest } = body;
  const parsed = parseExpectedRevision(expectedRevision, options);
  return typeof parsed === "string" ? parsed : { expectedRevision: parsed, rest };
}

/** The tools the profile validator accepts: what the orchestrator published, before it ever started the built-in names. */
async function installedTools(
  deps: IngestDeps,
): Promise<{ tools: readonly string[]; source: "orchestrator" | "builtin" }> {
  const capabilities = await readCapabilities(deps.pool);
  if (capabilities === undefined) log("capabilities-missing", { using: "builtin tool names" });
  return capabilities === undefined
    ? { tools: BUILTIN_TOOL_NAMES, source: "builtin" }
    : { tools: capabilities.tools, source: "orchestrator" };
}

/** The published model catalog's `provider/model` keys, or undefined while none is published (no check then). */
async function publishedModelKeys(deps: IngestDeps): Promise<string[] | undefined> {
  const capabilities = await readCapabilities(deps.pool);
  return capabilities?.models === undefined ? undefined : catalogKeys(capabilities.models);
}

export type CredentialsView = "configured" | "none-configured" | "unknown";

/**
 * The catalog as the console should offer it: only providers whose credential is `configured`, never `scripted` (a
 * test provider for CI, e2e and the quickstart), so the list is never big. `credentials` says why it may be empty:
 * `none-configured` when OneCLI was checked and holds no model credential, `unknown` (with a `reason`) when it could not
 * be checked. `all` returns the full catalog. Validation of writes never uses this view
 * (docs/decisions/0025-model-catalog.md).
 */
export function filterModelCatalog(
  models: readonly ModelCatalogEntry[],
  providers: readonly ModelProviderStatus[],
  all: boolean,
): {
  models: ModelCatalogEntry[];
  providers: ModelProviderStatus[];
  filtered: boolean;
  credentials?: CredentialsView;
  reason?: string;
} {
  if (all) return { models: [...models], providers: [...providers], filtered: false };
  const real = providers.filter((p) => p.provider !== "scripted");
  const kept = real.filter((p) => p.credential === "configured");
  const names = new Set(kept.map((p) => p.provider));
  const filtered = {
    models: models.filter((m) => names.has(m.provider)),
    providers: kept,
    filtered: true,
  };
  if (kept.length > 0) return { ...filtered, credentials: "configured" };
  if (real.some((p) => p.credential === "missing")) {
    return { ...filtered, credentials: "none-configured" };
  }
  return {
    ...filtered,
    credentials: "unknown",
    reason:
      "OneCLI could not be checked (the orchestrator has no OneCLI admin key, or listing the secrets failed)",
  };
}

async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
  url: URL,
  parts: string[],
): Promise<void> {
  if (!isAdmin(principal, deps.admins)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  const method = req.method ?? "GET";
  if (parts[1] === "status" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const shards = await readShardStatus(deps.pool);
    const probed = shards.find((row) => row.shard === PROBE_SHARD);
    sendJson(res, 200, {
      shards,
      networkPolicy: {
        state: probed?.networkPolicy ?? "unknown",
        checkedAt: probed?.networkPolicyCheckedAt ?? null,
        detail: probed?.networkPolicyDetail ?? null,
        requestedAt: probed?.probeRequestedAt ?? null,
      },
      // Unfiltered, unaudited sandboxes (ADR 0038); always 0 unless the chart allows direct egress.
      directSessions: await countDirectSessions(deps.pool),
    });
    return;
  }
  // Ingest cannot reach the Kubernetes API: it records the request, shard 0's orchestrator picks it up within seconds.
  if (parts[1] === "status" && parts[2] === "probe" && parts.length === 3) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const asked = await requestNetworkProbe(deps.pool);
    if (asked === "no-shard") {
      sendJson(res, 503, { error: "orchestrator shard 0 has not published its status yet" });
      return;
    }
    sendJson(res, 202, {
      requested: asked === "requested",
      state: asked === "running" ? "running" : "requested",
    });
    return;
  }
  if (parts[1] === "sandbox-sizes" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, deps.sandboxSizes ?? { sizes: [], defaultSize: null });
    return;
  }
  if (parts[1] === "network-modes" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    // `direct` has no proxy, rules or audit: the console labels it unfiltered and unaudited (ADR 0038).
    const directAllowed = deps.allowDirectSandboxEgress === true;
    sendJson(res, 200, {
      modes: directAllowed ? ["proxied", "direct"] : ["proxied"],
      defaultMode: "proxied",
      directAllowed,
    });
    return;
  }
  if (parts[1] === "sandbox-flavours" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const browser = deps.browserFlavourEnabled === true;
    const desktop = deps.desktopFlavourEnabled === true;
    sendJson(res, 200, {
      flavours: ["default", ...(browser ? ["browser"] : []), ...(desktop ? ["desktop"] : [])],
      defaultFlavour: "default",
      browserEnabled: browser,
      desktopEnabled: desktop,
    });
    return;
  }
  if (parts[1] === "sandbox-runtimes" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    // Names and flavours only: the RuntimeClass names are deployment detail the console does not need.
    sendJson(res, 200, {
      runtimes: Object.entries(deps.sandboxRuntimes ?? {}).map(([name, runtime]) => ({
        name,
        flavours: runtime.flavours,
        insecure: runtime.insecure,
      })),
      defaultRuntime: DEFAULT_SANDBOX_RUNTIME,
    });
    return;
  }
  if (parts[1] === "tools" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, await installedTools(deps));
    return;
  }
  if (parts[1] === "models" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const capabilities = await readCapabilities(deps.pool);
    if (capabilities?.models === undefined) {
      sendJson(res, 200, {
        models: [],
        providers: [],
        source: "none",
        filtered: false,
        credentials: "unknown",
        reason: "no orchestrator has published a model catalog yet",
      });
      return;
    }
    const all = ["1", "true"].includes(url.searchParams.get("all") ?? "");
    const providers = capabilities.modelProviders ?? [];
    sendJson(res, 200, {
      ...filterModelCatalog(capabilities.models, providers, all),
      source: "orchestrator",
    });
    return;
  }
  if (parts[1] === "mcp-servers") {
    await handleAdminMcpServers(req, res, deps, principal, url, parts);
    return;
  }
  if (parts[1] === "egress") {
    await handleAdminEgress(req, res, deps.pool, principal.owner, url, parts);
    return;
  }
  if (parts[1] === "profiles") {
    await handleAdminProfiles(req, res, deps, principal, url, parts);
    return;
  }
  if (parts[1] === "skills") {
    await handleAdminSkills(req, res, deps, principal, url, parts);
    return;
  }
  if (
    parts[1] !== "settings" ||
    parts.length > 3 ||
    (parts[2] !== undefined && parts[2] !== "history")
  ) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (parts[2] === "history" && method === "GET") {
    const asked = Number(url.searchParams.get("limit") ?? HISTORY_DEFAULT);
    const limit =
      Number.isInteger(asked) && asked >= 1 ? Math.min(asked, HISTORY_MAX) : HISTORY_DEFAULT;
    const history = await listSettingsHistory(deps.pool, limit);
    sendJson(res, 200, {
      history: history.map((entry) => ({ ...entry, changedAt: entry.changedAt.toISOString() })),
    });
    return;
  }
  if (parts[2] === undefined && method === "GET") {
    const stored = await readSettings(deps.pool);
    if (stored === undefined) {
      sendJson(res, 404, { error: "settings are not seeded" });
      return;
    }
    sendJson(res, 200, settingsJson(stored));
    return;
  }
  if (parts[2] === undefined && method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      if (error instanceof BodyError) {
        sendBodyError(res, req, error);
        return;
      }
      throw error;
    }
    const taken = takeExpectedRevision(body);
    if (typeof taken === "string") {
      sendJson(res, 400, { error: taken });
      return;
    }
    // The default-profile check runs inside the write transaction, under the lock that profile disables take.
    const stored = await updateSettings(
      deps.pool,
      taken.rest,
      principal.owner,
      taken.expectedRevision,
      await publishedModelKeys(deps),
    );
    if (typeof stored === "string") {
      sendJson(res, 400, { error: stored });
      return;
    }
    await deps.settings.refresh();
    sendJson(res, 200, settingsJson(stored));
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

function settingsJson(stored: StoredSettings) {
  return {
    ...stored.settings,
    revision: stored.revision,
    updatedAt: stored.updatedAt.toISOString(),
    updatedBy: stored.updatedBy,
  };
}

function profileRef(profile: { name: string; version: number }): { name: string; version: number } {
  return { name: profile.name, version: profile.version };
}

/** The skills a session was created with, as pinned in its profile snapshot (name, version, digest). */
function skillsOf(session: SessionRow): { skills?: unknown[] } {
  if (session.profile === null) return {};
  const definition = validateProfileDefinition(session.profile.snapshot);
  if (typeof definition === "string" || definition.skills === undefined) return {};
  return { skills: definition.skills };
}

/** `repoSkills` / `repoContext`: true when the session's snapshot turned it on and the session has a repo (else ignored). */
function repoFlagsOf(session: SessionRow): { repoSkills?: true; repoContext?: true } {
  if (session.profile === null || session.repo === null) return {};
  const definition = validateProfileDefinition(session.profile.snapshot);
  if (typeof definition === "string") return {};
  return {
    ...(definition.repoSkills === true ? { repoSkills: true as const } : {}),
    ...(definition.repoContext === true ? { repoContext: true as const } : {}),
  };
}

function skillVersionJson(meta: SkillVersionMeta) {
  return {
    name: meta.name,
    version: meta.version,
    digest: meta.digest,
    description: meta.description,
    disableModelInvocation: meta.disableModelInvocation,
    size: meta.size,
    files: meta.files,
    source: meta.source,
    createdAt: meta.createdAt.toISOString(),
    createdBy: meta.createdBy,
  };
}

/**
 * `/admin/skills` (the caller is already known to be an admin): list, get one with its versions, publish a version
 * (`POST /admin/skills/{name}/versions`) and read one (`GET .../versions/{v}`, with the file contents for
 * `?content=true`, because a skill is reviewed like code). No update of a published version (docs/decisions/0011); a delete is
 * refused while anything refers to it (docs/decisions/0027-admin-delete.md). A version a profile or session refers to
 * never changes or goes away; publishing identical content to the current version writes nothing.
 */
async function handleAdminSkills(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
  url: URL,
  parts: string[],
): Promise<void> {
  const method = req.method ?? "GET";
  const name = parts[2];
  if (name === undefined) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const skills = await readSkills(deps.pool);
    sendJson(res, 200, {
      skills: skills.map((skill) => ({
        name: skill.name,
        currentVersion: skill.currentVersion,
        digest: skill.digest,
        description: skill.description,
        disableModelInvocation: skill.disableModelInvocation,
        createdAt: skill.createdAt.toISOString(),
        createdBy: skill.createdBy,
        updatedAt: skill.updatedAt.toISOString(),
        updatedBy: skill.updatedBy,
      })),
    });
    return;
  }
  const nameError = skillNameError(name);
  if (nameError !== undefined) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  if (parts.length === 3 && method === "DELETE") {
    // Versions never change, so a skill's revision is its current version.
    const expected = requiredRevisionParam(url);
    if (typeof expected === "string") {
      sendJson(res, 400, { error: expected });
      return;
    }
    const deleted = await deleteSkill(deps.pool, name, expected, principal.owner);
    if (deleted === undefined) {
      sendJson(res, 404, { error: "skill not found" });
      return;
    }
    sendJson(res, 200, { name, deleted: true, lastVersion: deleted.lastVersion });
    return;
  }
  if (parts.length === 3) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const skill = await readSkill(deps.pool, name);
    if (skill === undefined) {
      sendJson(res, 404, { error: "skill not found" });
      return;
    }
    const versions = await listSkillVersions(deps.pool, name);
    sendJson(res, 200, {
      name,
      currentVersion: skill.currentVersion,
      versions: versions.map(skillVersionJson),
    });
    return;
  }
  if (
    parts[3] !== "versions" ||
    parts.length > 6 ||
    (parts[5] !== undefined && parts[5] !== "zip")
  ) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (parts.length === 4) {
    if (method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, SKILL_BODY_LIMIT);
    } catch (error) {
      if (error instanceof BodyError) {
        sendBodyError(res, req, error);
        return;
      }
      throw error;
    }
    const result = await putSkillVersion(deps.pool, name, body, principal.owner);
    if (!result.ok) {
      sendJson(res, 400, { error: result.message });
      return;
    }
    log("skill-published", {
      skill: name,
      version: result.version.version,
      digest: result.version.digest,
      by: principal.owner,
      created: result.created,
    });
    sendJson(res, result.created ? 201 : 200, {
      ...skillVersionJson(result.version),
      versionCreated: result.created,
    });
    return;
  }
  if (method !== "GET") {
    sendJson(res, 405, { error: "method not allowed" });
    return;
  }
  const version = Number(parts[4]);
  if (!/^[1-9][0-9]{0,8}$/.test(parts[4] ?? "")) {
    sendJson(res, 400, { error: "version must be a positive integer" });
    return;
  }
  if (parts[5] === "zip") {
    const bundle = await readSkillBundle(deps.pool, name, version);
    if (bundle === undefined) {
      sendJson(res, 404, { error: "skill version not found" });
      return;
    }
    const corrupt = verifySkillBundle(bundle);
    if (corrupt !== undefined) {
      log("skill-corrupt", { skill: name, version, message: corrupt });
      sendJson(res, 409, { error: "the stored skill version is corrupt" });
      return;
    }
    // Same paths and executable bits as the manifest: a re-upload of the unzipped files is the same digest.
    const zip = buildZip(
      bundle.files.map((file) => ({
        path: file.path,
        content: bundle.contents.get(file.path) ?? Buffer.alloc(0),
        executable: file.executable,
      })),
    );
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(zip.length),
      "content-disposition": `attachment; filename="${name}-v${String(version)}.zip"`,
    });
    res.end(zip);
    return;
  }
  if (url.searchParams.get("content") === "true") {
    const bundle = await readSkillBundle(deps.pool, name, version);
    if (bundle === undefined) {
      sendJson(res, 404, { error: "skill version not found" });
      return;
    }
    sendJson(res, 200, {
      ...skillVersionJson(bundle),
      files: bundle.files.map((file) => ({
        ...file,
        contentBase64: bundle.contents.get(file.path)?.toString("base64") ?? null,
      })),
    });
    return;
  }
  const meta = await readSkillVersion(deps.pool, name, version);
  if (meta === undefined) {
    sendJson(res, 404, { error: "skill version not found" });
    return;
  }
  sendJson(res, 200, skillVersionJson(meta));
}

function profileJson(stored: StoredProfile) {
  return {
    name: stored.name,
    currentVersion: stored.currentVersion,
    revision: stored.revision,
    enabledForNew: stored.enabledForNew,
    definition: stored.definition,
    createdAt: stored.createdAt.toISOString(),
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt.toISOString(),
    updatedBy: stored.updatedBy,
  };
}

/**
 * `/admin/profiles` (the caller is already known to be an admin): list, get (with every version), put (create, new
 * version, enable or disable for new sessions). A profile is disabled before it can be deleted, and a delete is
 * refused while anything refers to it (docs/decisions/0027-admin-delete.md); until then its versions stay as the
 * record of what sessions ran with.
 */
async function handleAdminProfiles(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
  url: URL,
  parts: string[],
): Promise<void> {
  const method = req.method ?? "GET";
  if (parts.length > 3) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const name = parts[2];
  if (name === undefined) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const catalog = await readProfiles(deps.pool);
    sendJson(res, 200, {
      defaultProfile: deps.settings.get().defaultProfile,
      profiles: catalog.profiles.map(profileJson),
      invalid: catalog.invalid,
    });
    return;
  }
  const nameError = profileNameError(name);
  if (nameError !== undefined) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  if (method === "GET") {
    const found = await readProfile(deps.pool, name).catch((error: unknown) => {
      log("profile-invalid", { profile: name, message: errorMessage(error) });
      return null;
    });
    if (found === null) {
      sendJson(res, 409, { error: "the current version of this profile is invalid" });
      return;
    }
    if (found === undefined) {
      sendJson(res, 404, { error: "profile not found" });
      return;
    }
    const versions = await listProfileVersions(deps.pool, name);
    sendJson(res, 200, {
      ...profileJson(found),
      versions: versions.map((version) => ({
        ...version,
        createdAt: version.createdAt.toISOString(),
      })),
    });
    return;
  }
  if (method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      if (error instanceof BodyError) {
        sendBodyError(res, req, error);
        return;
      }
      throw error;
    }
    for (const key of Object.keys(body)) {
      if (key !== "definition" && key !== "enabledForNew" && key !== "expectedRevision") {
        sendJson(res, 400, { error: `unknown field "${key.slice(0, 50)}"` });
        return;
      }
    }
    const taken = takeExpectedRevision(body, { create: true });
    if (typeof taken === "string") {
      sendJson(res, 400, { error: taken });
      return;
    }
    const installed = await installedTools(deps);
    const models = await publishedModelKeys(deps);
    const catalog = await readMcpServers(deps.pool);
    const result = await putProfile(
      deps.pool,
      name,
      {
        ...taken.rest,
        ...(taken.expectedRevision === undefined
          ? {}
          : { expectedRevision: taken.expectedRevision }),
      },
      principal.owner,
      {
        tools: installed.tools,
        mcpServers: catalog.servers.map((stored) => stored.server.name),
        ...(models === undefined ? {} : { models }),
        sandboxSizes: (deps.sandboxSizes?.sizes ?? []).map((size) => size.name),
        allowDirectEgress: deps.allowDirectSandboxEgress === true,
        directConflict: directConflictOf(catalog.servers, await readEgress(deps.pool)),
        browserFlavourEnabled: deps.browserFlavourEnabled === true,
        desktopFlavourEnabled: deps.desktopFlavourEnabled === true,
        untrustedConflict: untrustedConflictOf(catalog.servers, await readEgress(deps.pool)),
        sandboxRuntimes: deps.sandboxRuntimes ?? {},
      },
    );
    if (!result.ok) {
      sendJson(res, 400, { error: result.message });
      return;
    }
    sendJson(res, result.created ? 201 : 200, {
      ...profileJson(result.stored),
      versionCreated: result.versionCreated,
    });
    return;
  }
  if (method === "DELETE") {
    const expected = requiredRevisionParam(url);
    if (typeof expected === "string") {
      sendJson(res, 400, { error: expected });
      return;
    }
    const deleted = await deleteProfile(deps.pool, name, expected, principal.owner);
    if (deleted === undefined) {
      sendJson(res, 404, { error: "profile not found" });
      return;
    }
    sendJson(res, 200, { name, deleted: true, lastVersion: deleted.lastVersion });
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

function mcpServerJson(
  stored: StoredMcpServer,
  discovery: ReadonlyMap<string, ReadonlyMap<number, McpDiscoveryOutcome>>,
) {
  return {
    ...stored.server,
    revision: stored.revision,
    source: stored.source,
    // Reachability is the orchestrator's own discovery outcome (ADR 0044), not a probe from ingest: the path that
    // matters (gateway, host rules, egress policy) is only walked from the orchestrator.
    ...discoveryView(stored.server.enabled, discovery.get(stored.server.name)),
    createdAt: stored.createdAt.toISOString(),
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt.toISOString(),
    updatedBy: stored.updatedBy,
  };
}

/**
 * `/admin/mcp-servers` (the caller is already known to be an admin): list, history, get, put (create or update) and
 * delete. The orchestrators pick a change up through the notification the write sends.
 */
async function handleAdminMcpServers(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
  url: URL,
  parts: string[],
): Promise<void> {
  const method = req.method ?? "GET";
  if (parts.length > 3) {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  const name = parts[2];
  if (name === undefined) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const catalog = await readMcpServers(deps.pool);
    const discovery = await readMcpDiscovery(deps.pool);
    // The names an `onecliSecret` could take, as the orchestrator last listed them (ADR 0040 amendment): a picker's
    // list, never a check. `source: "none"` while unknown, which is not the same as an empty list.
    const names = (await readCapabilities(deps.pool))?.onecliSecretNames;
    sendJson(res, 200, {
      servers: catalog.servers.map((stored) => mcpServerJson(stored, discovery)),
      invalid: catalog.invalid,
      onecliSecrets:
        names === undefined ? { names: [], source: "none" } : { names, source: "orchestrator" },
    });
    return;
  }
  if (name === "history") {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    const asked = Number(url.searchParams.get("limit") ?? HISTORY_DEFAULT);
    const limit =
      Number.isInteger(asked) && asked >= 1 ? Math.min(asked, HISTORY_MAX) : HISTORY_DEFAULT;
    const only = url.searchParams.get("name") ?? undefined;
    const history = await listMcpServerHistory(deps.pool, limit, only);
    sendJson(res, 200, {
      history: history.map((entry) => ({ ...entry, changedAt: entry.changedAt.toISOString() })),
    });
    return;
  }
  const nameError = mcpServerNameError(name);
  if (nameError !== undefined) {
    sendJson(res, 400, { error: nameError });
    return;
  }
  if (method === "GET") {
    const catalog = await readMcpServers(deps.pool);
    const found = catalog.servers.find((stored) => stored.server.name === name);
    if (found === undefined) {
      sendJson(res, 404, { error: "server not found" });
      return;
    }
    sendJson(res, 200, mcpServerJson(found, await readMcpDiscovery(deps.pool)));
    return;
  }
  if (method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      if (error instanceof BodyError) {
        sendBodyError(res, req, error);
        return;
      }
      throw error;
    }
    const taken = takeExpectedRevision(body, { create: true });
    if (typeof taken === "string") {
      sendJson(res, 400, { error: taken });
      return;
    }
    const result = await putMcpServer(
      deps.pool,
      name,
      taken.rest,
      principal.owner,
      taken.expectedRevision,
      // The egress rules derived from the catalog change in the same transaction (ADR 0040).
      { within: (client) => syncMcpRulesFromCatalog(client, principal.owner) },
    );
    if (typeof result === "string") {
      sendJson(res, 400, { error: result });
      return;
    }
    sendJson(
      res,
      result.created ? 201 : 200,
      mcpServerJson(result.stored, await readMcpDiscovery(deps.pool)),
    );
    return;
  }
  if (method === "DELETE") {
    // A DELETE has no body to speak of: the revision is a query parameter, `?expectedRevision=3`.
    const expected = requiredRevisionParam(url);
    if (typeof expected === "string") {
      sendJson(res, 400, { error: expected });
      return;
    }
    const deleted = await deleteMcpServer(deps.pool, name, principal.owner, expected, {
      within: (client) => syncMcpRulesFromCatalog(client, principal.owner),
    });
    if (!deleted) {
      sendJson(res, 404, { error: "server not found" });
      return;
    }
    sendJson(res, 200, { name, deleted: true });
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

/** Sessions that predate migration 002 have no stored model: they run the default. */
function modelOf(session: SessionRow, policy: ModelPolicy): ModelChoice {
  return session.model ?? policy.default;
}

async function postSession(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readJsonObject(req);
  } catch (error) {
    if (error instanceof BodyError) {
      sendBodyError(res, req, error);
      return;
    }
    throw error;
  }
  if (body.liveView !== undefined && typeof body.liveView !== "boolean") {
    sendJson(res, 400, { error: "liveView must be a boolean" });
    return;
  }
  const resolved = await chooseProfile(deps, body);
  if ("status" in resolved) {
    sendJson(res, resolved.status, { error: resolved.error });
    return;
  }
  const { snapshot } = resolved;
  // Precedence: the request, then the profile, then the settings. All three go through the same checks (the allowlist
  // and the reasoning cap) when the session is created, so a profile that no longer fits is refused, not applied.
  const fromProfile = {
    ...(body.provider === undefined &&
    body.model === undefined &&
    snapshot.definition.defaultModel !== undefined
      ? parseProfileModel(snapshot.definition.defaultModel)
      : {}),
    ...(body.reasoning === undefined && snapshot.definition.reasoning !== undefined
      ? { reasoning: snapshot.definition.reasoning }
      : {}),
  };
  const model = chooseModel(deps.settings.policy(), { ...fromProfile, ...body });
  if (typeof model === "string") {
    const inherited = Object.keys(fromProfile).length > 0;
    sendJson(res, 400, {
      error: inherited
        ? `profile "${snapshot.name}" v${String(snapshot.version)}: ${model}`
        : model,
    });
    return;
  }
  const requested = chooseRepo(body);
  if (typeof requested === "string") {
    sendJson(res, 400, { error: requested });
    return;
  }
  // The GitHub App can reach more repositories than callers should: only the ones an admin listed (ADR 0032). The
  // session stores the allowlist's spelling, not the caller's, so one repository has one name (issue #334).
  let repo = requested;
  if (requested !== undefined) {
    const canonical = canonicalRepo(requested.repo, deps.settings.get().repoAllowlist);
    if (canonical === undefined) {
      sendJson(res, 403, { error: `repo "${requested.repo}" is not on the repo allowlist` });
      return;
    }
    repo = { ...requested, repo: canonical };
  }
  const sized = chooseSandboxSize(deps.sandboxSizes, snapshot.definition, body.sandboxSize);
  if ("error" in sized) {
    sendJson(res, 400, {
      error:
        body.sandboxSize === undefined
          ? `profile "${snapshot.name}" v${String(snapshot.version)}: ${sized.error}`
          : sized.error,
    });
    return;
  }
  // The environment may have changed since the profile was written (issue #406).
  const runtimeRefusal = sandboxRuntimeConflict(snapshot.definition, deps.sandboxRuntimes ?? {});
  if (runtimeRefusal !== null) {
    sendJson(res, 400, {
      error: `profile "${snapshot.name}" v${String(snapshot.version)}: ${runtimeRefusal}`,
    });
    return;
  }
  const sandboxRuntime = sandboxRuntimeOf(snapshot.definition);
  const networkMode = networkModeOf(snapshot.definition);
  if (networkMode === "direct") {
    const refusal = await directRefusal(deps, snapshot.definition, repo !== undefined);
    if (refusal !== undefined) {
      sendJson(res, 400, {
        error: `profile "${snapshot.name}" v${String(snapshot.version)}: ${refusal}`,
      });
      return;
    }
  }
  const sandboxFlavour = sandboxFlavourOf(snapshot.definition);
  if (isUntrustedContentFlavour(sandboxFlavour)) {
    const refusal = await untrustedFlavourRefusal(
      deps,
      sandboxFlavour,
      snapshot.definition,
      repo !== undefined,
    );
    if (refusal !== undefined) {
      sendJson(res, 400, {
        error: `profile "${snapshot.name}" v${String(snapshot.version)}: ${refusal}`,
      });
      return;
    }
  }
  const liveViewRefused =
    body.liveView === true ? liveViewRefusal(deps, sandboxFlavour) : undefined;
  if (liveViewRefused !== undefined) {
    sendJson(res, 400, { error: liveViewRefused });
    return;
  }
  const liveViewToken = body.liveView === true ? newLiveViewToken() : null;
  let sessionId: string;
  try {
    sessionId = await createSession(
      deps.pool,
      principal,
      model,
      repo,
      snapshot,
      deps.shards ?? 1,
      sized.size,
      networkMode,
      sandboxFlavour,
      sandboxRuntime,
      liveViewToken,
    );
  } catch (error) {
    // The profile got a new version, was closed or deleted since it was read: nothing was stored.
    if (!(error instanceof StaleProfileError)) throw error;
    sendJson(res, 409, { error: error.message });
    return;
  }
  sendJson(res, 201, {
    sessionId,
    profile: profileRef(snapshot),
    provider: model.provider,
    model: model.model,
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(sized.size === null ? {} : { sandboxSize: sized.size }),
    networkMode,
    sandboxFlavour,
    sandboxRuntime: sandboxRuntime ?? DEFAULT_SANDBOX_RUNTIME,
    ...liveViewFields(deps, liveViewToken),
    ...(repo === undefined
      ? {}
      : { repo: repo.repo, ...(repo.branch === undefined ? {} : { branch: repo.branch }) }),
  });
}

/** `liveViewUrl` for a response, only while the live view is on. Never for a session whose owner did not ask. */
function liveViewFields(deps: IngestDeps, token: string | null): { liveViewUrl?: string } {
  return token === null || deps.liveViewPublicUrl === undefined
    ? {}
    : { liveViewUrl: liveViewUrl(deps.liveViewPublicUrl, token) };
}

/** Why a session of this flavour cannot have a live view, or undefined (ADR 0066). */
function liveViewRefusal(deps: IngestDeps, flavour: string): string | undefined {
  if (deps.liveViewPublicUrl === undefined)
    return "liveView is not available: this deployment has not set liveView.enabled";
  if (flavour !== "desktop") return "liveView needs a desktop session (sandboxFlavour desktop)";
  return undefined;
}

/** `PUT /sessions/{id}/live-view`: turns the live view on, or replaces its URL. The old URL stops working at once. */
async function putLiveView(
  deps: IngestDeps,
  session: SessionRow,
  res: ServerResponse,
): Promise<void> {
  const refusal = liveViewRefusal(deps, session.sandboxFlavour);
  if (refusal !== undefined) {
    sendJson(res, 400, { error: refusal });
    return;
  }
  if (session.status !== "active") {
    sendJson(res, session.status === "deleted" ? 410 : 409, {
      error: `session is ${session.status}`,
    });
    return;
  }
  const token = newLiveViewToken();
  if (!(await setLiveViewToken(deps.pool, session.id, token))) {
    sendJson(res, 409, { error: "session is not active" });
    return;
  }
  sendJson(res, 200, { liveViewUrl: liveViewUrl(deps.liveViewPublicUrl ?? "", token) });
}

/** `directModeConflict` over the catalog and the rules as they are now, for `checkProfileNames`. */
function directConflictOf(
  mcpServers: Parameters<typeof directModeConflict>[1]["mcpServers"],
  egress: Parameters<typeof directModeConflict>[1]["egress"],
): (definition: ProfileDefinition) => string | undefined {
  return (definition) => directModeConflict(definition, { mcpServers, egress });
}

/** `untrustedFlavourConflict` over the catalog and the rules as they are now, for `checkProfileNames`. */
function untrustedConflictOf(
  mcpServers: Parameters<typeof untrustedFlavourConflict>[1]["mcpServers"],
  egress: Parameters<typeof untrustedFlavourConflict>[1]["egress"],
): (definition: ProfileDefinition) => string | undefined {
  return (definition) => untrustedFlavourConflict(definition, { mcpServers, egress });
}

/**
 * Why a new session of a `browser` or `desktop` profile is refused, or undefined (ADR 0041, 0065): the deployment does
 * not render that flavour's sandboxes, the request names a repo, or the profile now has a credentialed MCP server or a `onecli` rule that
 * applies to it (the catalog and the rules may have changed since the profile was written).
 */
async function untrustedFlavourRefusal(
  deps: IngestDeps,
  flavour: "browser" | "desktop",
  definition: ProfileDefinition,
  hasRepo: boolean,
): Promise<string | undefined> {
  const enabled = flavour === "browser" ? deps.browserFlavourEnabled : deps.desktopFlavourEnabled;
  if (enabled !== true) return flavourNotEnabled(flavour);
  if (hasRepo) return flavourWithRepo(flavour);
  const [catalog, egress] = await Promise.all([readMcpServers(deps.pool), readEgress(deps.pool)]);
  return untrustedFlavourConflict(definition, { mcpServers: catalog.servers, egress });
}

/**
 * Why a new session of a `direct` profile is refused, or undefined (ADR 0038): the deployment does not allow it, the
 * request names a repo (its credential would need the proxy), or the profile now has a credentialed MCP server or a
 * `onecli` rule that applies to it (the catalog and the rules may have changed since the profile was written).
 */
async function directRefusal(
  deps: IngestDeps,
  definition: ProfileDefinition,
  hasRepo: boolean,
): Promise<string | undefined> {
  if (deps.allowDirectSandboxEgress !== true) return DIRECT_NOT_ALLOWED;
  if (hasRepo)
    return "networkMode direct cannot be combined with a repo (its credential needs the egress proxy)";
  const [catalog, egress] = await Promise.all([readMcpServers(deps.pool), readEgress(deps.pool)]);
  return directModeConflict(definition, { mcpServers: catalog.servers, egress });
}

function parseProfileModel(key: string): { provider: string; model: string } {
  const slash = key.indexOf("/");
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}

/**
 * The profile a new session gets, as the snapshot it stores: the requested one, else the settings' default. A request
 * for a profile that does not exist or is not open to new sessions is a 400. The default failing is the operator's
 * misconfiguration (a 503), and never falls back to another profile: a missing profile fails closed.
 */
async function chooseProfile(
  deps: IngestDeps,
  body: Record<string, unknown>,
): Promise<{ snapshot: ProfileSnapshot } | { status: number; error: string }> {
  const asked = body.profile;
  if (asked !== undefined) {
    const nameError = profileNameError(asked);
    if (nameError !== undefined) return { status: 400, error: nameError };
  }
  const name = typeof asked === "string" ? asked : deps.settings.get().defaultProfile;
  const refused = (message: string) =>
    asked === undefined
      ? { status: 503, error: `the default profile "${name}" ${message}` }
      : { status: 400, error: `profile "${name}" ${message}` };
  let stored: StoredProfile | undefined;
  try {
    stored = await readProfile(deps.pool, name);
  } catch (error) {
    log("profile-invalid", { profile: name, message: errorMessage(error) });
    return refused("is invalid");
  }
  if (stored === undefined) return refused("does not exist");
  if (!stored.enabledForNew) return refused("is not available for new sessions");
  return {
    snapshot: { name: stored.name, version: stored.currentVersion, definition: stored.definition },
  };
}

async function ownedSession(
  pool: pg.Pool,
  id: string,
  principal: Principal,
): Promise<SessionRow | undefined> {
  if (!UUID.test(id)) return undefined;
  const session = await getSession(pool, id);
  return session?.ownerSubject === principal.subject ? session : undefined;
}

async function postEvent(
  req: IncomingMessage,
  res: ServerResponse,
  pool: pg.Pool,
  session: SessionRow,
  principal: Principal,
): Promise<void> {
  let parsed;
  try {
    parsed = parseEventBody(await readJsonObject(req));
  } catch (error) {
    if (error instanceof BodyError) {
      sendBodyError(res, req, error);
      return;
    }
    throw error;
  }
  if (typeof parsed === "string") {
    sendJson(res, 400, { error: parsed });
    return;
  }
  if (session.status !== "active") {
    sendJson(res, session.status === "deleted" ? 410 : 409, {
      error: `session is ${session.status}`,
    });
    return;
  }
  const result = await enqueueEvent(
    pool,
    {
      sessionId: session.id,
      source: `api:${principal.owner}`,
      sourceEventId: parsed.sourceEventId,
      kind: parsed.kind,
      payload: parsed.payload,
    },
    { requireActive: true },
  );
  if (result.outcome === "inactive") {
    // The session was deleted or failed after the check above (the body is read in between).
    sendJson(res, result.status === "deleted" ? 410 : 409, {
      error: `session is ${result.status}`,
    });
    return;
  }
  if (result.outcome === "conflict") {
    sendJson(res, 409, { error: "sourceEventId was already used for another session" });
    return;
  }
  // 202 either way: a repeated post is accepted and names the first event.
  sendJson(res, 202, { eventId: result.eventId, duplicate: result.outcome === "duplicate" });
}

async function queueDelete(pool: pg.Pool, session: SessionRow, res: ServerResponse): Promise<void> {
  if (session.status === "deleted") {
    sendJson(res, 202, { sessionId: session.id, status: "deleted" });
    return;
  }
  // Status first: events are admitted only while the session is active, so once this commits nothing new can be
  // accepted, and the delete row below sorts after every event that was. The delete is an inbox row like any other.
  // Both writes in one transaction (see beginDelete): never `deleting` without a delete row.
  const result = await beginDelete(pool, session.id);
  // A repeated DELETE is the client's retry: a delete row that ended `failed` runs again.
  await requeueFailedDelete(pool, session.id);
  const eventId = "eventId" in result ? result.eventId : undefined;
  sendJson(res, 202, { sessionId: session.id, status: "deleting", eventId });
}

/**
 * Pipes the orchestrator's SSE stream to the client. The orchestrator authenticates the same token again.
 * When the upstream ends (orchestrator restart) the client's response ends too; the client reconnects
 * with Last-Event-ID and resumes.
 */
function proxyStream(
  req: IncomingMessage,
  res: ServerResponse,
  orchestratorUrl: string,
  sessionId: string,
): void {
  const target = new URL(`/sessions/${sessionId}/stream`, orchestratorUrl);
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (typeof req.headers.authorization === "string")
    headers.authorization = req.headers.authorization;
  const lastEventId = req.headers["last-event-id"];
  if (typeof lastEventId === "string") headers["last-event-id"] = lastEventId;

  const upstream = httpRequest(target, { method: "GET", headers }, (up) => {
    const type = up.headers["content-type"];
    const retryAfter = up.headers["retry-after"];
    res.writeHead(up.statusCode ?? 502, {
      "content-type": typeof type === "string" ? type : "application/json",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
      // An orchestrator that is not ready says when to retry; the client must see it.
      ...(typeof retryAfter === "string" ? { "retry-after": retryAfter } : {}),
    });
    up.pipe(res);
    up.on("error", () => res.end());
  });
  upstream.on("error", () => {
    if (!res.headersSent) {
      sendJson(res, 503, { error: "orchestrator unavailable, retry" }, { "retry-after": "2" });
    } else {
      res.end();
    }
  });
  res.on("close", () => upstream.destroy());
  // The orchestrator sends a keepalive every 15 s. Silence for 45 s means it is gone without closing the
  // connection (node lost, network cut): drop the stream so the client reconnects instead of waiting forever.
  upstream.setTimeout(45_000, () => upstream.destroy());
  upstream.end();
}
