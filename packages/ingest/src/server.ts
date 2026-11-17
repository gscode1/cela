import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import type pg from "pg";
import { orchestratorUrlFor } from "./config.js";
import {
  AdminConflictError,
  BodyError,
  BUILTIN_TOOL_NAMES,
  buildZip,
  chooseModel,
  chooseRepo,
  createSession,
  enqueueEvent,
  errorMessage,
  getSession,
  deleteMcpServer,
  isAdmin,
  LEGACY_PROFILE,
  listMcpServerHistory,
  listProfileVersions,
  listSettingsHistory,
  mcpServerNameError,
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
  readCapabilities,
  readMcpServers,
  readProfile,
  readProfiles,
  readJsonObject,
  readSettings,
  PROBE_SHARD,
  readShardStatus,
  requestNetworkProbe,
  updateSettings,
  beginDelete,
  requeueFailedDelete,
  sendJson,
  summarize,
  UUID,
} from "@pi-durable-k8s/session-core";
import type {
  Authenticator,
  ModelChoice,
  ModelPolicy,
  Principal,
  ProfileSnapshot,
  SessionRow,
  Settings,
  SkillVersionMeta,
  StoredMcpServer,
  StoredProfile,
  StoredSettings,
} from "@pi-durable-k8s/session-core";
import { parseEventBody } from "./events.js";
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
  /** False until the inbox schema is migrated; liveness does not wait for it, readiness and the API do. */
  schemaReady: () => boolean;
}

export interface SettingsView {
  get(): Settings;
  policy(): ModelPolicy;
  /** Re-reads the row now, so a write is visible to the next request on this replica. */
  refresh(): Promise<void>;
}

export function createIngestServer(deps: IngestDeps): Server {
  return createServer((req, res) => {
    void handle(req, res, deps).catch((error: unknown) => {
      log("http-error", { message: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      else res.destroy();
    });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, deps: IngestDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const method = req.method ?? "GET";

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
  if (parts.length === 3 && parts[2] === "events" && method === "POST") {
    await postEvent(req, res, deps.pool, session, principal);
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
    sendJson(res, 409, { error: error.message });
  }
}

/** `expectedRevision` taken out of a body, so the rest can go to a validator that refuses unknown keys. */
function takeExpectedRevision(
  body: Record<string, unknown>,
): { expectedRevision: number | undefined; rest: Record<string, unknown> } | string {
  const { expectedRevision, ...rest } = body;
  const parsed = parseExpectedRevision(expectedRevision);
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
      },
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
  if (parts[1] === "tools" && parts.length === 2) {
    if (method !== "GET") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    sendJson(res, 200, await installedTools(deps));
    return;
  }
  if (parts[1] === "mcp-servers") {
    await handleAdminMcpServers(req, res, deps, principal, url, parts);
    return;
  }
  if (parts[1] === "profiles") {
    await handleAdminProfiles(req, res, deps, principal, parts);
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
        sendJson(res, 400, { error: error.message });
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
 * `?content=true`, because a skill is reviewed like code). No update and no delete (docs/decisions/0011): a version a
 * profile or session refers to never changes or goes away; publishing identical content to the current version writes
 * nothing.
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
        sendJson(res, 400, { error: error.message });
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
 * version, enable or disable for new sessions). No delete (docs/decisions/0010-session-profiles.md): a profile is
 * disabled, so its versions stay as the record of what sessions ran with.
 */
async function handleAdminProfiles(
  req: IncomingMessage,
  res: ServerResponse,
  deps: IngestDeps,
  principal: Principal,
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
        sendJson(res, 400, { error: error.message });
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
    const taken = takeExpectedRevision(body);
    if (typeof taken === "string") {
      sendJson(res, 400, { error: taken });
      return;
    }
    const installed = await installedTools(deps);
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
  sendJson(res, 405, { error: "method not allowed" });
}

function mcpServerJson(stored: StoredMcpServer) {
  return {
    ...stored.server,
    revision: stored.revision,
    source: stored.source,
    // The admin API never probes the network (ADR 0009): whether the host is also allowed in the OneCLI rules and the
    // egress policy is only seen when the orchestrator connects.
    reachability: "unknown",
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
    sendJson(res, 200, {
      servers: catalog.servers.map(mcpServerJson),
      invalid: catalog.invalid,
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
    sendJson(res, 200, mcpServerJson(found));
    return;
  }
  if (method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req);
    } catch (error) {
      if (error instanceof BodyError) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      throw error;
    }
    const taken = takeExpectedRevision(body);
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
    );
    if (typeof result === "string") {
      sendJson(res, 400, { error: result });
      return;
    }
    sendJson(res, result.created ? 201 : 200, mcpServerJson(result.stored));
    return;
  }
  if (method === "DELETE") {
    // A DELETE has no body to speak of: the revision is a query parameter, `?expectedRevision=3`.
    const asked = url.searchParams.get("expectedRevision");
    const expected = parseExpectedRevision(
      asked === null ? undefined : /^[0-9]{1,10}$/.test(asked) ? Number(asked) : asked,
    );
    if (typeof expected === "string") {
      sendJson(res, 400, { error: expected });
      return;
    }
    if (!(await deleteMcpServer(deps.pool, name, principal.owner, expected))) {
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
      sendJson(res, 400, { error: error.message });
      return;
    }
    throw error;
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
  const repo = chooseRepo(body);
  if (typeof repo === "string") {
    sendJson(res, 400, { error: repo });
    return;
  }
  const sessionId = await createSession(
    deps.pool,
    principal,
    model,
    repo,
    snapshot,
    deps.shards ?? 1,
  );
  sendJson(res, 201, {
    sessionId,
    profile: profileRef(snapshot),
    provider: model.provider,
    model: model.model,
    ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
    ...(repo === undefined
      ? {}
      : { repo: repo.repo, ...(repo.branch === undefined ? {} : { branch: repo.branch }) }),
  });
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
      sendJson(res, 400, { error: error.message });
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
