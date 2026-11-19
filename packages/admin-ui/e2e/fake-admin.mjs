// A small in-memory stand-in for the admin endpoints the catalog screens use (skills, MCP servers, shard status, and a
// read of the profiles), for the local run of the browser suite. It reuses the real validators, digest and zip writer of
// session-core, so the limits and error texts are the API's own. The authentication, the console and everything else
// stay with the real ingest server code (local-server.mjs puts this in front of it).
import {
  buildZip,
  manifestOf,
  skillDigest,
  skillNameError,
  mcpServerNameError,
  validateMcpServer,
  validateSkillContent,
} from "../../session-core/dist/index.js";

import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? {} : JSON.parse(text);
}

/** The state of one fake install. `catalogs` is what the console is told; the fake itself accepts writes either way. */
export function createFakeAdmin() {
  /** name -> versions, oldest first. A version keeps its file bytes. */
  const skills = new Map();
  /** name -> { server, revision, source, createdAt, createdBy, updatedAt, updatedBy } */
  const mcp = new Map();
  const mcpHistory = [];
  let historyId = 0;
  const profiles = new Map([["coding", { name: "coding", enabledForNew: true, definition: {} }]]);
  /** The profiles (all at version 1 here) whose definition names `name` under `field` (`skills` or `mcpServers`). */
  const usersOf = (field, name) =>
    [...profiles.values()]
      .filter((p) =>
        (p.definition[field] ?? []).some(
          (entry) => (typeof entry === "string" ? entry : entry.name) === name,
        ),
      )
      .map((p) => ({ name: p.name, version: 1 }));
  let shards = [];
  // What `GET /admin/status` adds to the shard rows, and `GET /admin/egress/status` (the real ingest has no egress
  // tables behind its in-memory settings database). `PUT /__fake/status` sets them and, left out, resets them.
  let directSessions = 0;
  const healthyEgress = () => ({
    revision: 3,
    ruleSets: 2,
    rules: 4,
    invalid: 0,
    principals: { active: 2, withPodIp: 1, revoked: 3 },
    proxy: { replicas: [{ name: "egress-proxy-0", revision: 3, state: "serving" }] },
  });
  let egressStatus = healthyEgress();
  const now = () => new Date().toISOString();

  /** id -> { owner, profile, deleted, entries, live, watchers, timers }: the session API, scripted (no model, no sandbox). */
  const sessions = new Map();
  let sessionSeq = 0;
  const sse = (res, text) => {
    if (!res.writableEnded) res.write(text);
  };
  const sendLive = (session) => {
    const text = `event: live\ndata: ${JSON.stringify(session.live)}\n\n`;
    for (const res of session.watchers) sse(res, text);
  };
  const addEntry = (session, messages) => {
    const entry = { id: session.entries.length + 1, kind: "message", messages };
    session.entries.push(entry);
    const text = `id: ${String(entry.id)}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const res of session.watchers) sse(res, text);
  };
  const later = (session, ms, fn) => session.timers.add(setTimeout(fn, ms));
  const clearTimers = (session) => {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
  };

  /**
   * One scripted turn: a tool call (the first MCP server of the profile as `mcp__<server>__echo`, else `bash`), its
   * result, then an answer. "fail" in the text makes the tool error, "slow" keeps the turn running until a cancel.
   */
  function runTurn(session, text) {
    const tool =
      session.mcpServers[0] === undefined ? "bash" : `mcp__${session.mcpServers[0]}__echo`;
    session.live = { running: true, queued: 0, partial: "Let me try the tool." };
    sendLive(session);
    if (text.includes("slow")) return;
    later(session, 40, () => {
      session.live = { running: true, queued: 0 };
      addEntry(session, [
        {
          role: "assistant",
          text: "Let me try the tool.",
          calls: [`${tool}(${JSON.stringify({ text })})`],
        },
      ]);
      sendLive(session);
    });
    later(session, 80, () => {
      const failed = text.includes("fail");
      addEntry(session, [
        {
          role: "toolResult",
          text: failed ? "tool failed: simulated error" : `echo: ${text}\n${"line\n".repeat(30)}`,
          isError: failed,
        },
      ]);
    });
    later(session, 120, () => {
      addEntry(session, [{ role: "assistant", text: "Done: the tool answered." }]);
      session.live = { running: false, queued: 0 };
      sendLive(session);
    });
  }

  async function handleSessions(req, res, owner, parts) {
    const reply = (status, body) => json(res, status, body);
    if (parts.length === 1 && req.method === "POST") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return reply(400, { error: "body must be a JSON object" });
      }
      const name = body.profile ?? "coding";
      const profile = profiles.get(name);
      if (profile === undefined || !profile.enabledForNew)
        return reply(400, { error: `profile "${name}" is unknown or disabled for new sessions` });
      const id = `00000000-0000-4000-8000-${String(++sessionSeq).padStart(12, "0")}`;
      sessions.set(id, {
        id,
        owner,
        profile: name,
        mcpServers: profile.definition.mcpServers ?? [],
        deleted: false,
        entries: [],
        live: { running: false, queued: 0 },
        watchers: new Set(),
        timers: new Set(),
        body,
      });
      return reply(201, {
        sessionId: id,
        profile: { name, version: 1 },
        provider: body.provider ?? "scripted",
        model: body.model ?? "scripted-1",
        ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
        networkMode: "proxied",
        sandboxFlavour: "default",
      });
    }
    const session = sessions.get(parts[1] ?? "");
    if (session === undefined || session.owner !== owner)
      return reply(404, { error: "session not found" });
    if (session.deleted) return reply(410, { error: "session deleted" });
    if (parts.length === 2 && req.method === "GET")
      return reply(200, {
        sessionId: session.id,
        status: "active",
        profile: { name: session.profile, version: 1 },
        model: { provider: "scripted", model: "scripted-1" },
      });
    if (parts.length === 2 && req.method === "DELETE") {
      session.deleted = true;
      clearTimers(session);
      for (const watcher of session.watchers) {
        sse(watcher, "event: deleted\ndata: {}\n\n");
        watcher.end();
      }
      return reply(202, { sessionId: session.id, status: "deleting" });
    }
    if (parts[2] === "events" && req.method === "POST") {
      const body = await readBody(req);
      if (body.kind === "cancel") {
        clearTimers(session);
        session.live = { running: false, queued: 0, runFailure: "aborted" };
        sendLive(session);
      } else if (body.kind === "message" && typeof body.text === "string") {
        addEntry(session, [{ role: "user", text: body.text }]);
        runTurn(session, body.text);
      } else return reply(400, { error: "invalid event" });
      return reply(202, { eventId: `e${String(session.entries.length)}`, duplicate: false });
    }
    if (parts[2] === "stream" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write("retry: 2000\n\n");
      const after = Number(req.headers["last-event-id"] ?? 0);
      for (const entry of session.entries)
        if (entry.id > after)
          res.write(`id: ${String(entry.id)}\nevent: entry\ndata: ${JSON.stringify(entry)}\n\n`);
      res.write(`event: live\ndata: ${JSON.stringify(session.live)}\n\n`);
      session.watchers.add(res);
      res.on("close", () => session.watchers.delete(res));
      return undefined;
    }
    return reply(404, { error: "not found" });
  }

  const versionJson = (v) => ({
    name: v.name,
    version: v.version,
    digest: v.digest,
    description: v.description,
    disableModelInvocation: v.disableModelInvocation,
    size: v.files.reduce((sum, f) => sum + f.size, 0),
    files: v.files.map(({ path, size, sha256, executable }) => ({
      path,
      size,
      sha256,
      executable,
    })),
    source: v.source,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
  });

  async function handleSkills(req, res, owner, parts, url) {
    const method = req.method;
    const name = parts[2];
    if (name === undefined)
      return json(res, 200, {
        skills: [...skills.entries()].map(([skillName, versions]) => {
          const v = versions.at(-1);
          return {
            name: skillName,
            currentVersion: v.version,
            digest: v.digest,
            description: v.description,
            disableModelInvocation: v.disableModelInvocation,
            createdAt: versions[0].createdAt,
            createdBy: versions[0].createdBy,
            updatedAt: v.createdAt,
            updatedBy: v.createdBy,
          };
        }),
      });
    const nameError = skillNameError(name);
    if (nameError !== undefined) return json(res, 400, { error: nameError });
    const versions = skills.get(name);
    if (parts.length === 3 && req.method === "DELETE") {
      const asked = url.searchParams.get("expectedRevision");
      if (asked === null || !/^[0-9]{1,10}$/.test(asked))
        return json(res, 400, { error: "expectedRevision must be a positive integer" });
      if (versions === undefined) return json(res, 404, { error: "skill not found" });
      if (Number(asked) !== versions.at(-1).version)
        return json(res, 409, { error: "the skill has a newer version: reload and retry" });
      const using = usersOf("skills", name);
      if (using.length > 0)
        return json(res, 409, {
          error: `skill "${name}" cannot be deleted`,
          blockedBy: { profiles: using },
        });
      skills.delete(name);
      return json(res, 200, { name, deleted: true, lastVersion: versions.at(-1).version });
    }
    if (parts.length === 3) {
      if (versions === undefined) return json(res, 404, { error: "skill not found" });
      return json(res, 200, {
        name,
        currentVersion: versions.at(-1).version,
        versions: [...versions].reverse().map(versionJson),
      });
    }
    if (parts[3] !== "versions") return json(res, 404, { error: "not found" });
    if (parts.length === 4) {
      if (method !== "POST") return json(res, 405, { error: "method not allowed" });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const content = validateSkillContent(body, name);
      if (typeof content === "string") return json(res, 400, { error: content });
      const files = manifestOf(content).map((entry) => ({
        ...entry,
        bytes: content.files.find((f) => f.path === entry.path).content,
      }));
      const digest = skillDigest(content.name, content.description, files);
      const current = versions?.at(-1);
      if (current !== undefined && current.digest === digest)
        return json(res, 200, { ...versionJson(current), versionCreated: false });
      const created = {
        name,
        version: (current?.version ?? 0) + 1,
        digest,
        description: content.description,
        disableModelInvocation: content.disableModelInvocation,
        files,
        source: content.source,
        createdAt: now(),
        createdBy: owner,
      };
      skills.set(name, [...(versions ?? []), created]);
      return json(res, 201, { ...versionJson(created), versionCreated: true });
    }
    if (method !== "GET") return json(res, 405, { error: "method not allowed" });
    const version = versions?.find((v) => String(v.version) === parts[4]);
    if (version === undefined) return json(res, 404, { error: "skill version not found" });
    if (parts[5] === "zip") {
      const zip = buildZip(
        version.files.map((f) => ({
          path: f.path,
          content: Buffer.from(f.bytes),
          executable: f.executable,
        })),
      );
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(zip.length),
        "content-disposition": `attachment; filename="${name}-v${String(version.version)}.zip"`,
      });
      return res.end(zip);
    }
    if (url.searchParams.get("content") === "true")
      return json(res, 200, {
        ...versionJson(version),
        files: version.files.map(({ path, size, sha256, executable, bytes }) => ({
          path,
          size,
          sha256,
          executable,
          contentBase64: Buffer.from(bytes).toString("base64"),
        })),
      });
    return json(res, 200, versionJson(version));
  }

  const mcpJson = (stored) => ({
    ...stored.server,
    revision: stored.revision,
    source: stored.source,
    // The orchestrator's discovery outcome (ADR 0044). The fake has no orchestrator, so nothing has reported: a row
    // with default settings keeps nothing to expand, as the specs expect.
    reachability: "unknown",
    discovery: stored.server.enabled
      ? { state: "unknown", tools: 0, checkedAt: null }
      : { state: "disabled", tools: 0, checkedAt: null },
    createdAt: stored.createdAt,
    createdBy: stored.createdBy,
    updatedAt: stored.updatedAt,
    updatedBy: stored.updatedBy,
  });

  const conflict = (res, message) => json(res, 409, { error: message });

  async function handleMcp(req, res, owner, parts, url) {
    const method = req.method;
    const name = parts[2];
    if (name === undefined)
      return json(res, 200, {
        servers: [...mcp.values()].map(mcpJson).sort((a, b) => a.name.localeCompare(b.name)),
        invalid: [],
        // What a shard 0 orchestrator with a OneCLI admin key would publish (ADR 0040 amendment).
        onecliSecrets: { names: ["github-mcp", "linear-mcp"], source: "orchestrator" },
      });
    if (name === "history") {
      const only = url.searchParams.get("name");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const history = mcpHistory
        .filter((h) => only === null || h.name === only)
        .slice(-limit)
        .reverse();
      return json(res, 200, { history });
    }
    const nameError = mcpServerNameError(name);
    if (nameError !== undefined) return json(res, 400, { error: nameError });
    const stored = mcp.get(name);
    if (method === "GET") {
      if (stored === undefined) return json(res, 404, { error: "server not found" });
      return json(res, 200, mcpJson(stored));
    }
    const record = (action, old, next) =>
      mcpHistory.push({
        id: String(++historyId),
        changedAt: now(),
        changedBy: owner,
        name,
        action,
        old,
        new: next,
      });
    if (method === "PUT") {
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 400, { error: "body must be a JSON object" });
      }
      const { expectedRevision, ...rest } = body;
      if (expectedRevision !== undefined) {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0)
          return json(res, 400, {
            error: "expectedRevision must be 0 (create only) or a positive integer",
          });
        // 0 is a create: it matches only a name that does not exist (ADR 0023).
        if (expectedRevision === 0) {
          if (stored !== undefined)
            return conflict(res, `MCP server ${name} already exists: choose another name`);
        } else if (stored === undefined)
          return conflict(
            res,
            `server does not exist, so expectedRevision ${String(expectedRevision)} cannot match`,
          );
        else if (stored.revision !== expectedRevision)
          return conflict(
            res,
            `server is at revision ${String(stored.revision)}, not the expected ${String(expectedRevision)}: reload and retry`,
          );
      }
      const server = validateMcpServer(name, rest, stored?.server);
      if (typeof server === "string") return json(res, 400, { error: server });
      if (stored !== undefined && JSON.stringify(server) === JSON.stringify(stored.server))
        return json(res, 200, mcpJson(stored));
      const next = {
        server,
        revision: (stored?.revision ?? 0) + 1,
        source: stored?.source ?? null,
        createdAt: stored?.createdAt ?? now(),
        createdBy: stored?.createdBy ?? owner,
        updatedAt: now(),
        updatedBy: owner,
      };
      mcp.set(name, next);
      record(stored === undefined ? "create" : "update", stored?.server ?? null, server);
      return json(res, stored === undefined ? 201 : 200, mcpJson(next));
    }
    if (method === "DELETE") {
      // The API's rules (ADR 0027): the revision is required, and a server a profile names is not deleted.
      const asked = url.searchParams.get("expectedRevision");
      if (asked === null || !/^[0-9]{1,10}$/.test(asked))
        return json(res, 400, { error: "expectedRevision must be a positive integer" });
      if (stored === undefined) return json(res, 404, { error: "server not found" });
      if (Number(asked) !== stored.revision)
        return conflict(
          res,
          `server is at revision ${String(stored.revision)}, not the expected ${asked}: reload and retry`,
        );
      const using = usersOf("mcpServers", name);
      if (using.length > 0)
        return json(res, 409, {
          error: `MCP server "${name}" cannot be deleted`,
          blockedBy: { profiles: using },
        });
      mcp.delete(name);
      record("delete", stored.server, null);
      return json(res, 200, { name, deleted: true });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  /** Test controls, local only: `PUT /__fake/status` (`shards`, and optionally `directSessions` and `egress`), `PUT /__fake/profiles/{name}`, `PUT /__fake/mcp/{name}` (a stale write). */
  async function control(req, res, parts) {
    const body = await readBody(req);
    if (parts[1] === "status") {
      shards = body.shards;
      directSessions = body.directSessions ?? 0;
      egressStatus = body.egress ?? healthyEgress();
      return json(res, 200, { ok: true });
    }
    if (parts[1] === "profiles" && parts[2] !== undefined) {
      profiles.set(parts[2], {
        name: parts[2],
        enabledForNew: body.enabledForNew ?? true,
        definition: body.definition ?? {},
      });
      return json(res, 200, { ok: true });
    }
    if (parts[1] === "sessions") {
      // `drop` ends every open stream the way a proxy would (the console must reconnect); no `drop` lists the sessions.
      if (parts[2] === "drop")
        for (const s of sessions.values()) for (const w of s.watchers) w.end();
      return json(res, 200, {
        sessions: [...sessions.values()].map((s) => ({
          id: s.id,
          profile: s.profile,
          deleted: s.deleted,
          watchers: s.watchers.size,
        })),
      });
    }
    return json(res, 404, { error: "unknown control" });
  }

  /** True when the request was answered here. `owner` is the authenticated admin. */
  async function handle(req, res, owner) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "__fake") {
      await control(req, res, parts);
      return true;
    }
    if (parts[0] === "sessions") {
      await handleSessions(req, res, owner, parts);
      return true;
    }
    if (parts[0] !== "admin") return false;
    if (parts[1] === "skills") await handleSkills(req, res, owner, parts, url);
    else if (parts[1] === "mcp-servers") await handleMcp(req, res, owner, parts, url);
    else if (parts[1] === "profiles" && parts.length === 2 && req.method === "GET")
      json(res, 200, {
        defaultProfile: "coding",
        profiles: [...profiles.values()].map((p) => ({
          ...p,
          currentVersion: 1,
          revision: 1,
          createdAt: now(),
          createdBy: "seed",
          updatedAt: now(),
          updatedBy: "seed",
        })),
        invalid: [],
      });
    else if (parts[1] === "status" && parts[2] === undefined && req.method === "GET")
      json(res, 200, {
        shards,
        networkPolicy: shards[0]
          ? {
              state: shards[0].networkPolicy,
              checkedAt: shards[0].networkPolicyCheckedAt ?? null,
              detail: shards[0].networkPolicyDetail ?? null,
              requestedAt: shards[0].probeRequestedAt ?? null,
            }
          : null,
        directSessions,
      });
    else if (parts[1] === "egress" && parts[2] === "status" && req.method === "GET")
      json(res, 200, egressStatus);
    else if (parts[1] === "status" && parts[2] === "probe" && req.method === "POST") {
      if (shards.length === 0)
        json(res, 503, { error: "shard 0 has not published a status row yet" });
      else {
        shards = shards.map((s) =>
          s.shard === 0 ? { ...s, networkPolicy: "enforced", networkPolicyCheckedAt: now() } : s,
        );
        json(res, 202, { requested: true, state: "requested" });
      }
    } else return false;
    return true;
  }

  return { handle };
}
