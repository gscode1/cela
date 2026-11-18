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
  const now = () => new Date().toISOString();

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
    reachability: "unknown",
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
        if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
          return json(res, 400, { error: "expectedRevision must be a positive integer" });
        if (stored === undefined)
          return conflict(
            res,
            `server does not exist, so expectedRevision ${String(expectedRevision)} cannot match`,
          );
        if (stored.revision !== expectedRevision)
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

  /** Test controls, local only: `PUT /__fake/status`, `PUT /__fake/profiles/{name}`, `PUT /__fake/mcp/{name}` (a stale write). */
  async function control(req, res, parts) {
    const body = await readBody(req);
    if (parts[1] === "status") {
      shards = body.shards;
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
              requestedAt: shards[0].probeRequestedAt ?? null,
            }
          : null,
      });
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
