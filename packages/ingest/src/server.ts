import { request as httpRequest, createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { URL } from "node:url";
import type pg from "pg";
import {
  BodyError,
  BUILTIN_TOOL_NAMES,
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
  profileNameError,
  putMcpServer,
  putProfile,
  readCapabilities,
  readMcpServers,
  readProfile,
  readProfiles,
  readJsonObject,
  readSettings,
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
  StoredMcpServer,
  StoredProfile,
} from "@pi-durable-k8s/session-core";
import { parseEventBody } from "./events.js";
import { log } from "./log.js";

export interface IngestDeps {
  pool: pg.Pool;
  authenticate: Authenticator;
  orchestratorUrl: string;
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
    proxyStream(req, res, deps.orchestratorUrl, session.id);
    return;
  }
  sendJson(res, 404, { error: "not found" });
}

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 500;

/** `/admin/*`: only the owners in `PI_API_ADMINS` (403 for any other authenticated caller). */
async function handleAdmin(
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
  if (parts[1] === "mcp-servers") {
    await handleAdminMcpServers(req, res, deps, principal, url, parts);
    return;
  }
  if (parts[1] === "profiles") {
    await handleAdminProfiles(req, res, deps, principal, parts);
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
    sendJson(res, 200, {
      ...stored.settings,
      updatedAt: stored.updatedAt.toISOString(),
      updatedBy: stored.updatedBy,
    });
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
    if (body.defaultProfile !== undefined) {
      const problem = await defaultProfileProblem(deps.pool, body.defaultProfile);
      if (problem !== undefined) {
        sendJson(res, 400, { error: problem });
        return;
      }
    }
    const stored = await updateSettings(deps.pool, body, principal.owner);
    if (typeof stored === "string") {
      sendJson(res, 400, { error: stored });
      return;
    }
    await deps.settings.refresh();
    sendJson(res, 200, {
      ...stored.settings,
      updatedAt: stored.updatedAt.toISOString(),
      updatedBy: stored.updatedBy,
    });
    return;
  }
  sendJson(res, 405, { error: "method not allowed" });
}

/** The default profile must exist and be open to new sessions, or every `POST /sessions` without `profile` would fail. */
async function defaultProfileProblem(pool: pg.Pool, name: unknown): Promise<string | undefined> {
  const nameError = profileNameError(name);
  if (nameError !== undefined) return `defaultProfile: ${nameError}`;
  let profile: StoredProfile | undefined;
  try {
    profile = await readProfile(pool, String(name));
  } catch {
    return `defaultProfile: profile "${String(name)}" is invalid`;
  }
  if (profile === undefined) return `defaultProfile: profile "${String(name)}" does not exist`;
  return profile.enabledForNew
    ? undefined
    : `defaultProfile: profile "${String(name)}" is disabled for new sessions`;
}

function profileRef(profile: { name: string; version: number }): { name: string; version: number } {
  return { name: profile.name, version: profile.version };
}

function profileJson(stored: StoredProfile) {
  return {
    name: stored.name,
    currentVersion: stored.currentVersion,
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
      if (key !== "definition" && key !== "enabledForNew") {
        sendJson(res, 400, { error: `unknown field "${key.slice(0, 50)}"` });
        return;
      }
    }
    // The installed tools, as the orchestrator published them; before it ever started, the built-in names.
    const capabilities = await readCapabilities(deps.pool);
    if (capabilities === undefined) log("capabilities-missing", { using: "builtin tool names" });
    const catalog = await readMcpServers(deps.pool);
    const result = await putProfile(deps.pool, name, body, principal.owner, {
      tools: capabilities?.tools ?? BUILTIN_TOOL_NAMES,
      mcpServers: catalog.servers.map((stored) => stored.server.name),
    });
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
    const result = await putMcpServer(deps.pool, name, body, principal.owner);
    if (typeof result === "string") {
      sendJson(res, 400, { error: result });
      return;
    }
    sendJson(res, result.created ? 201 : 200, mcpServerJson(result.stored));
    return;
  }
  if (method === "DELETE") {
    if (!(await deleteMcpServer(deps.pool, name, principal.owner))) {
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
  const sessionId = await createSession(deps.pool, principal, model, repo, snapshot);
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
    res.writeHead(up.statusCode ?? 502, {
      "content-type": typeof type === "string" ? type : "application/json",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
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
