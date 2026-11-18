import type { Mock } from "vitest";
import { vi } from "vitest";
import type { EgressHistoryEntry, EgressRule, RuleSetSummary } from "@/lib/api/egress";
import type { FakeAdmin } from "./fake-admin";

/**
 * The egress endpoints on top of the fake admin API (docs/session-api.md): one revision for the whole schema, `409`
 * for a stale one, `409 blockedBy.profiles` on a set a profile names, and whatever `explainWith` answers. It does not
 * validate rules: the console mirrors that, and ingest is tested in its own package.
 */
export interface FakeEgress {
  revision: number;
  ruleSets: Omit<RuleSetSummary, "ruleCount">[];
  rules: EgressRule[];
  history: EgressHistoryEntry[];
  /** Every write received: `METHOD path`, body. */
  writes: { path: string; body: Record<string, unknown> }[];
  /** What `POST /admin/egress/explain` answers; the request is in `explained`. */
  explainWith: Record<string, unknown>;
  explained: Record<string, unknown>[];
  /** A sentence to answer the next write with `blockedBy.profiles` (a profile named the set meanwhile). */
  blockProfiles: { name: string; version: number }[] | undefined;
  /** Another admin writes: bumps the revision without the console knowing. */
  bump: () => void;
  fetch: Mock<(path: string, init?: RequestInit) => Promise<Response>>;
}

/** The body of a write without its `expectedRevision`. */
const withoutRevision = (body: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => key !== "expectedRevision"));

const NOW = "2026-11-17T00:00:00.000Z";

export const SESSION = "0b1e2d3c-4a5f-4e6d-8c7b-9a0f1e2d3c4b";

export function rule(partial: Partial<EgressRule> & Pick<EgressRule, "id" | "host">): EgressRule {
  return {
    ruleSet: "npm",
    sessionId: null,
    effect: "allow",
    ports: [443],
    route: "direct",
    private: false,
    expiresAt: null,
    note: "",
    revision: 1,
    createdAt: NOW,
    createdBy: "seed",
    updatedAt: NOW,
    updatedBy: "seed",
    ...partial,
  };
}

function setRow(name: string, description: string, appliesToAll = false) {
  return {
    name,
    description,
    appliesToAll,
    revision: 1,
    createdAt: NOW,
    createdBy: "seed",
    updatedAt: NOW,
    updatedBy: "seed",
  };
}

export function addFakeEgress(admin: FakeAdmin): FakeEgress {
  const egress: FakeEgress = {
    revision: 3,
    ruleSets: [setRow("npm", "npm registry"), setRow("open-web", "any public host", true)],
    rules: [
      rule({ id: "1", host: "registry.npmjs.org", note: "packages" }),
      rule({ id: "2", ruleSet: "open-web", host: "*" }),
    ],
    history: [],
    writes: [],
    explainWith: {},
    explained: [],
    blockProfiles: undefined,
    bump: () => {
      egress.revision += 1;
    },
    fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
  };
  // New rules start at 10, clear of the ids a test seeds.
  let nextId = 10;
  const reply = (status: number, body: unknown) => Promise.resolve(Response.json(body, { status }));
  const stale = (asked: unknown) =>
    typeof asked === "number" && asked !== egress.revision
      ? reply(409, {
          error: `the egress rules are at revision ${String(egress.revision)}, not the expected ${String(asked)}: reload and retry`,
        })
      : undefined;
  const summaries = () =>
    egress.ruleSets.map((set) => ({
      ...set,
      ruleCount: egress.rules.filter((entry) => entry.ruleSet === set.name).length,
    }));
  const other = admin.fetch.getMockImplementation();
  egress.fetch.mockImplementation((path, init = {}) => {
    const url = new URL(path, "http://x");
    const route = url.pathname;
    if (!route.startsWith("/admin/egress/")) return other?.(path, init) ?? reply(404, {});
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth !== "Bearer alice-token") return reply(401, { error: "unauthorized" });
    const method = init.method ?? "GET";
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method !== "GET") egress.writes.push({ path: `${method} ${route}${url.search}`, body });
    const parts = route.split("/").filter((part) => part !== "");
    const what = parts[2];
    if (what === "status")
      return reply(200, {
        revision: egress.revision,
        ruleSets: egress.ruleSets.length,
        rules: egress.rules.length,
        invalid: 0,
        proxy: { replicas: [], note: "no egress proxy reports yet" },
      });
    if (what === "history") return reply(200, { history: egress.history });
    if (what === "explain") {
      egress.explained.push(body);
      if (body.host === "bad host") return reply(400, { error: "host must be a DNS name" });
      return reply(200, egress.explainWith);
    }
    if (what === "sessions") {
      const id = parts[3];
      if (method === "GET")
        return reply(200, {
          revision: egress.revision,
          rules: egress.rules.filter((entry) => entry.sessionId === id),
        });
      const refused = stale(body.expectedRevision);
      if (refused) return refused;
      const fields = withoutRevision(body);
      egress.revision += 1;
      const created = rule({
        id: String(nextId++),
        ruleSet: null,
        sessionId: id ?? null,
        ...(fields as Pick<EgressRule, "host">),
      });
      egress.rules.push(created);
      return reply(201, created);
    }
    if (what === "rules") {
      const id = parts[3];
      const found = egress.rules.find((entry) => entry.id === id);
      if (found === undefined) return reply(404, { error: "rule not found" });
      const asked =
        method === "DELETE"
          ? Number(url.searchParams.get("expectedRevision"))
          : body.expectedRevision;
      const refused = stale(asked);
      if (refused) return refused;
      egress.revision += 1;
      if (method === "DELETE") {
        egress.rules.splice(egress.rules.indexOf(found), 1);
        return reply(200, { id, deleted: true });
      }
      const fields = withoutRevision(body);
      Object.assign(found, fields);
      return reply(200, found);
    }
    // rule-sets
    const name = parts[3];
    if (name === undefined) {
      if (method === "GET")
        return reply(200, { revision: egress.revision, ruleSets: summaries(), invalid: [] });
      const refused = stale(body.expectedRevision);
      if (refused) return refused;
      if (egress.ruleSets.some((set) => set.name === body.name))
        return reply(409, {
          error: `rule set ${String(body.name)} already exists: choose another name`,
        });
      egress.revision += 1;
      const created = setRow(
        String(body.name),
        typeof body.description === "string" ? body.description : "",
        body.appliesToAll === true,
      );
      egress.ruleSets.push(created);
      return reply(201, created);
    }
    const set = egress.ruleSets.find((entry) => entry.name === name);
    if (set === undefined) return reply(404, { error: "rule set not found" });
    if (parts[4] === "rules") {
      const refused = stale(body.expectedRevision);
      if (refused) return refused;
      const fields = withoutRevision(body);
      if (fields.host === "reject.example.com")
        return reply(400, { error: "host must be a DNS name of lowercase letters" });
      egress.revision += 1;
      const created = rule({
        id: String(nextId++),
        ruleSet: name,
        ...(fields as Pick<EgressRule, "host">),
      });
      egress.rules.push(created);
      return reply(201, created);
    }
    if (method === "GET")
      return reply(200, { ...set, rules: egress.rules.filter((entry) => entry.ruleSet === name) });
    if (method === "PUT") {
      const refused = stale(body.expectedRevision);
      if (refused) return refused;
      const fields = withoutRevision(body);
      egress.revision += 1;
      Object.assign(set, fields);
      return reply(200, set);
    }
    // DELETE
    const refused = stale(Number(url.searchParams.get("expectedRevision")));
    if (refused) return refused;
    const named = [
      ...admin.profiles
        .filter((profile) => {
          const definition = profile.versions[profile.versions.length - 1]?.definition;
          return definition?.egressRuleSets?.includes(name) === true;
        })
        .map((profile) => ({ name: profile.name, version: profile.currentVersion })),
      ...(egress.blockProfiles ?? []),
    ];
    if (named.length > 0)
      return reply(409, {
        error: `rule set "${name}" cannot be deleted`,
        blockedBy: { profiles: named },
      });
    egress.revision += 1;
    egress.ruleSets.splice(egress.ruleSets.indexOf(set), 1);
    egress.rules = egress.rules.filter((entry) => entry.ruleSet !== name);
    return reply(200, { name, deleted: true });
  });
  vi.stubGlobal("fetch", egress.fetch);
  return egress;
}
