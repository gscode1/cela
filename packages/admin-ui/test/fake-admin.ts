import { vi } from "vitest";
import type { Mock } from "vitest";
import type { ProfileDefinition } from "@/lib/api/profiles";

/**
 * An in-memory stand-in for the admin endpoints the console uses, with the answers that matter to it: revisions and
 * `409` as in docs/decisions/0023-admin-revisions.md, `400` for a bad default profile, and the profile list shapes. It
 * does not validate definitions: the console mirrors that, and ingest is tested in its own package.
 */
export interface FakeProfile {
  name: string;
  currentVersion: number;
  revision: number;
  enabledForNew: boolean;
  versions: { version: number; definition: ProfileDefinition; createdBy: string }[];
}

export interface FakeSettings {
  defaultModel: string;
  allowlist: string[];
  reasoning: string | null;
  maxReasoning: string | null;
  defaultProfile: string;
  turnBudget: number;
  tokenBudget: number | null;
  repoAllowlist: string[];
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface FakeAdmin {
  settings: FakeSettings;
  history: { id: string; changedAt: string; changedBy: string; old: unknown; new: unknown }[];
  profiles: FakeProfile[];
  invalid: { name: string; message: string }[];
  tools: string[];
  /** The `GET /admin/models` answer (default view). */
  models: Record<string, unknown>;
  mcp: { name: string; url: string; enabled: boolean }[];
  skills: {
    name: string;
    currentVersion: number;
    versions: {
      version: number;
      digest: string;
      description: string;
      disableModelInvocation: boolean;
      files: { path: string; size: number; executable: boolean }[];
    }[];
  }[];
  /** Every write received, as `PUT path body`. */
  writes: { path: string; body: Record<string, unknown> }[];
  fetch: Mock<(path: string, init?: RequestInit) => Promise<Response>>;
}

const NOW = "2026-11-17T00:00:00.000Z";

export function createFakeAdmin(): FakeAdmin {
  const admin: FakeAdmin = {
    settings: {
      defaultModel: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1"],
      reasoning: null,
      maxReasoning: null,
      defaultProfile: "coding",
      turnBudget: 100,
      tokenBudget: null,
      repoAllowlist: [],
      revision: 1,
      updatedAt: NOW,
      updatedBy: "seed",
    },
    history: [],
    profiles: [
      {
        name: "coding",
        currentVersion: 1,
        revision: 1,
        enabledForNew: true,
        versions: [{ version: 1, definition: {}, createdBy: "seed" }],
      },
    ],
    invalid: [],
    tools: ["read", "write", "edit", "bash"],
    models: {
      models: [
        { provider: "openai", id: "gpt-fast", name: "GPT Fast", reasoning: false },
        { provider: "openai", id: "gpt-think", name: "GPT Think", reasoning: true },
      ],
      providers: [{ provider: "openai", credential: "configured" }],
      source: "orchestrator",
      filtered: true,
      credentials: "configured",
    },
    mcp: [],
    skills: [],
    writes: [],
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  };
  const reply = (status: number, body: unknown) => Promise.resolve(Response.json(body, { status }));
  const current = (profile: FakeProfile) => profile.versions[profile.versions.length - 1];
  const profileJson = (profile: FakeProfile) => ({
    name: profile.name,
    currentVersion: profile.currentVersion,
    revision: profile.revision,
    enabledForNew: profile.enabledForNew,
    definition: current(profile)?.definition ?? {},
    createdAt: NOW,
    createdBy: "seed",
    updatedAt: NOW,
    updatedBy: current(profile)?.createdBy ?? "seed",
  });
  admin.fetch.mockImplementation((path, init = {}) => {
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth === "Bearer bob-token") return reply(403, { error: "forbidden" });
    if (auth !== "Bearer alice-token") return reply(401, { error: "unauthorized" });
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const url = new URL(path, "http://x");
    const route = url.pathname;
    if (method === "PUT") admin.writes.push({ path: route, body });
    if (route === "/admin/settings" && method === "GET") return reply(200, admin.settings);
    if (route === "/admin/settings/history") return reply(200, { history: admin.history });
    if (route === "/admin/settings" && method === "PUT") {
      const { expectedRevision: asked, ...patch } = body;
      const expectedRevision = typeof asked === "number" ? asked : undefined;
      if (expectedRevision !== undefined && expectedRevision !== admin.settings.revision)
        return reply(409, {
          error: `settings is at revision ${String(admin.settings.revision)}, not the expected ${String(expectedRevision)}: reload and retry`,
        });
      const target = patch.defaultProfile;
      const profile = admin.profiles.find((entry) => entry.name === target);
      if (typeof target === "string" && profile?.enabledForNew !== true)
        return reply(400, {
          error: `defaultProfile: profile "${target}" is disabled for new sessions`,
        });
      admin.settings = {
        ...admin.settings,
        ...patch,
        revision: admin.settings.revision + 1,
        updatedBy: "alice",
      };
      return reply(200, admin.settings);
    }
    if (route === "/admin/profiles" && method === "GET")
      return reply(200, {
        defaultProfile: admin.settings.defaultProfile,
        profiles: admin.profiles.map(profileJson),
        invalid: admin.invalid,
      });
    const match = /^\/admin\/profiles\/([^/]+)$/.exec(route);
    if (match?.[1] !== undefined) {
      const name = match[1];
      const profile = admin.profiles.find((entry) => entry.name === name);
      if (method === "GET") {
        if (profile === undefined) return reply(404, { error: "profile not found" });
        return reply(200, {
          ...profileJson(profile),
          versions: [...profile.versions]
            .reverse()
            .map((version) => ({ ...version, createdAt: NOW })),
        });
      }
      if (method === "DELETE") {
        // The API's rules (ADR 0027): revision required, not the default, closed to new sessions.
        admin.writes.push({ path: `DELETE ${route}`, body: {} });
        const asked = Number(url.searchParams.get("expectedRevision"));
        if (profile === undefined) return reply(404, { error: "profile not found" });
        if (asked !== profile.revision) return reply(409, { error: "stale revision" });
        const blockedBy = {
          ...(admin.settings.defaultProfile === name ? { defaultProfile: true } : {}),
          ...(profile.enabledForNew ? { enabledForNew: true } : {}),
        };
        if (Object.keys(blockedBy).length > 0)
          return reply(409, { error: `profile "${name}" cannot be deleted`, blockedBy });
        admin.profiles.splice(admin.profiles.indexOf(profile), 1);
        return reply(200, { name, deleted: true, lastVersion: profile.currentVersion });
      }
      const expected =
        typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
      if (expected !== undefined && expected !== profile?.revision)
        return reply(409, {
          error:
            profile === undefined
              ? `profile ${name} does not exist, so expectedRevision ${String(expected)} cannot match`
              : `profile ${name} is at revision ${String(profile.revision)}, not the expected ${String(expected)}: reload and retry`,
        });
      const definition = body.definition as ProfileDefinition | undefined;
      if (profile === undefined) {
        admin.profiles.push({
          name,
          currentVersion: 1,
          revision: 1,
          enabledForNew: body.enabledForNew !== false,
          versions: [{ version: 1, definition: definition ?? {}, createdBy: "alice" }],
        });
        const created = admin.profiles[admin.profiles.length - 1];
        return reply(201, { ...profileJson(created as FakeProfile), versionCreated: true });
      }
      if (body.enabledForNew === false && admin.settings.defaultProfile === name)
        return reply(409, {
          error: `profile "${name}" is the default profile for new sessions: select another enabled profile as the default first`,
        });
      let versionCreated = false;
      if (
        definition !== undefined &&
        JSON.stringify(definition) !== JSON.stringify(current(profile)?.definition)
      ) {
        profile.currentVersion += 1;
        profile.revision += 1;
        profile.versions.push({ version: profile.currentVersion, definition, createdBy: "alice" });
        versionCreated = true;
      }
      if (typeof body.enabledForNew === "boolean" && body.enabledForNew !== profile.enabledForNew) {
        profile.enabledForNew = body.enabledForNew;
        profile.revision += 1;
      }
      return reply(200, { ...profileJson(profile), versionCreated });
    }
    if (route === "/admin/models") return reply(200, admin.models);
    if (route === "/admin/tools") return reply(200, { tools: admin.tools, source: "orchestrator" });
    if (route === "/admin/mcp-servers") return reply(200, { servers: admin.mcp, invalid: [] });
    if (route === "/admin/skills")
      return reply(200, { skills: admin.skills.map(({ name }) => ({ name })) });
    const skill = /^\/admin\/skills\/([^/]+)$/.exec(route);
    if (skill?.[1] !== undefined) {
      const found = admin.skills.find((entry) => entry.name === skill[1]);
      return found === undefined ? reply(404, { error: "skill not found" }) : reply(200, found);
    }
    return reply(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", admin.fetch);
  return admin;
}
