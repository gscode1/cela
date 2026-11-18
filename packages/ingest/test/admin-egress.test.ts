import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import { FakeEgressDb } from "../../session-core/test/fake-egress-db.ts";

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

/** alice is an admin, bob is not; a token is just the owner's name here. */
async function start(admins: string[] = ["alice"]): Promise<{ base: string; db: FakeEgressDb }> {
  const db = new FakeEgressDb();
  server = createIngestServer({
    pool: db.asPool(),
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: "http://unused",
    settings: {
      get: () => {
        throw new Error("not used");
      },
      policy: () => {
        throw new Error("not used");
      },
      refresh: () => Promise.resolve(),
    },
    admins,
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, db };
}

const call = (
  base: string,
  who: string | undefined,
  method: string,
  path: string,
  body?: unknown,
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(who === undefined ? {} : { authorization: `Bearer ${who}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const SESSION = "11111111-2222-4333-8444-555555555555";
const json = async (response: Response) => (await response.json()) as Record<string, unknown>;
const BASE = "/admin/egress";

describe("admin egress authorization", () => {
  it("answers 401 without a token and 403 to a non-admin on every route, and writes nothing", async () => {
    const { base, db } = await start();
    const routes: [string, string, unknown?][] = [
      ["GET", `${BASE}/rule-sets`],
      ["POST", `${BASE}/rule-sets`, { name: "web" }],
      ["GET", `${BASE}/rule-sets/web`],
      ["PUT", `${BASE}/rule-sets/web`, { description: "x" }],
      ["DELETE", `${BASE}/rule-sets/web?expectedRevision=1`],
      ["POST", `${BASE}/rule-sets/web/rules`, { effect: "allow", host: "a.example.com" }],
      ["PUT", `${BASE}/rules/1`, { note: "x" }],
      ["DELETE", `${BASE}/rules/1?expectedRevision=1`],
      ["GET", `${BASE}/sessions/${SESSION}/rules`],
      ["POST", `${BASE}/sessions/${SESSION}/rules`, { effect: "allow", host: "a.example.com" }],
      ["POST", `${BASE}/explain`, { host: "a.example.com" }],
      ["GET", `${BASE}/status`],
      ["GET", `${BASE}/history`],
    ];
    for (const [method, path, body] of routes) {
      expect((await call(base, undefined, method, path, body)).status, `${method} ${path}`).toBe(
        401,
      );
      expect((await call(base, "bob", method, path, body)).status, `${method} ${path}`).toBe(403);
    }
    expect(db.ruleSets).toHaveLength(0);
    expect(db.rules).toHaveLength(0);
    expect(db.revisions).toHaveLength(0);
    expect(db.notifications).toEqual([]);
  });
});

describe("admin egress rule sets", () => {
  it("creates, lists, reads, updates and deletes a rule set with revisions, history and notifications", async () => {
    const { base, db } = await start();
    expect(await json(await call(base, "alice", "GET", `${BASE}/rule-sets`))).toEqual({
      revision: 0,
      ruleSets: [],
      invalid: [],
    });
    const created = await call(base, "alice", "POST", `${BASE}/rule-sets`, {
      name: "web",
      description: "open web",
      expectedRevision: 0,
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      name: "web",
      description: "open web",
      appliesToAll: false,
      revision: 1,
      createdBy: "alice",
    });
    const rule = await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, {
      effect: "allow",
      host: "*",
      expectedRevision: 1,
    });
    expect(rule.status).toBe(201);
    expect(await json(rule)).toMatchObject({
      id: "1",
      ruleSet: "web",
      sessionId: null,
      host: "*",
      revision: 2,
    });

    const list = await json(await call(base, "alice", "GET", `${BASE}/rule-sets`));
    expect(list.revision).toBe(2);
    expect(list.ruleSets).toMatchObject([{ name: "web", ruleCount: 1 }]);
    const one = await json(await call(base, "alice", "GET", `${BASE}/rule-sets/web`));
    expect(one).toMatchObject({ name: "web", rules: [{ id: "1", host: "*" }] });
    expect((await call(base, "alice", "GET", `${BASE}/rule-sets/nope`)).status).toBe(404);

    const put = await call(base, "alice", "PUT", `${BASE}/rule-sets/web`, {
      appliesToAll: true,
      expectedRevision: 2,
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({
      appliesToAll: true,
      description: "open web",
      revision: 3,
    });

    expect(
      (await call(base, "alice", "DELETE", `${BASE}/rule-sets/web?expectedRevision=3`)).status,
    ).toBe(200);
    expect(
      (await call(base, "alice", "DELETE", `${BASE}/rule-sets/web?expectedRevision=4`)).status,
    ).toBe(404);
    expect(db.rules).toHaveLength(0);
    expect(db.notifications).toEqual(["1", "2", "3", "4"]);

    const history = await json(await call(base, "alice", "GET", `${BASE}/history`));
    expect(
      (history.history as { kind: string; action: string }[]).map((h) => `${h.kind} ${h.action}`),
    ).toEqual(["rule-set delete", "rule-set update", "rule create", "rule-set create"]);
    const only = await json(
      await call(base, "alice", "GET", `${BASE}/history?kind=rule-set&ref=web&limit=2`),
    );
    expect(only.history).toHaveLength(2);
    expect((await call(base, "alice", "GET", `${BASE}/history?kind=x`)).status).toBe(400);
  });

  it("answers 409 for a duplicate name and for a stale expectedRevision on every write, and changes nothing", async () => {
    const { base, db } = await start();
    await call(base, "alice", "POST", `${BASE}/rule-sets`, { name: "web" });
    expect((await call(base, "alice", "POST", `${BASE}/rule-sets`, { name: "web" })).status).toBe(
      409,
    );
    const attempts: [string, string, unknown?][] = [
      ["POST", `${BASE}/rule-sets`, { name: "other", expectedRevision: 0 }],
      ["PUT", `${BASE}/rule-sets/web`, { description: "x", expectedRevision: 5 }],
      [
        "POST",
        `${BASE}/rule-sets/web/rules`,
        { effect: "allow", host: "a.example.com", expectedRevision: 0 },
      ],
      ["DELETE", `${BASE}/rule-sets/web?expectedRevision=9`],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(base, "alice", method, path, body);
      expect(response.status, `${method} ${path}`).toBe(409);
      expect((await json(response)).error).toContain("revision 1");
    }
    expect(db.ruleSets).toHaveLength(1);
    expect(db.revision).toBe(1);
  });

  it("refuses to delete a rule set a profile names: 409 with the profiles", async () => {
    const { base, db } = await start();
    await call(base, "alice", "POST", `${BASE}/rule-sets`, { name: "web" });
    db.profiles.set("scraper", ["web"]);
    const response = await call(
      base,
      "alice",
      "DELETE",
      `${BASE}/rule-sets/web?expectedRevision=1`,
    );
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({
      error: expect.stringContaining("scraper") as unknown,
      blockedBy: { profiles: [{ name: "scraper", version: 1 }] },
    });
    expect(db.ruleSets).toHaveLength(1);
  });

  it("requires expectedRevision on DELETE and checks its form", async () => {
    const { base } = await start();
    expect((await call(base, "alice", "DELETE", `${BASE}/rule-sets/web`)).status).toBe(400);
    expect(
      (await call(base, "alice", "DELETE", `${BASE}/rule-sets/web?expectedRevision=abc`)).status,
    ).toBe(400);
    expect((await call(base, "alice", "DELETE", `${BASE}/rules/1`)).status).toBe(400);
    expect(
      (await call(base, "alice", "DELETE", `${BASE}/rules/abc?expectedRevision=1`)).status,
    ).toBe(400);
    for (const expectedRevision of [-1, 1.5, "1"]) {
      const response = await call(base, "alice", "POST", `${BASE}/rule-sets`, {
        name: "web",
        expectedRevision,
      });
      expect(response.status, String(expectedRevision)).toBe(400);
    }
  });

  it("answers 400 for invalid rule sets", async () => {
    const { base, db } = await start();
    const bad: unknown[] = [
      {},
      { name: "Web" },
      { name: "web", appliesToAll: "yes" },
      { name: "web", rules: [] },
      { name: "web", description: 5 },
    ];
    for (const body of bad) {
      expect(
        (await call(base, "alice", "POST", `${BASE}/rule-sets`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect((await call(base, "alice", "GET", `${BASE}/rule-sets/Web`)).status).toBe(400);
    expect(db.revision).toBe(0);
  });
});

describe("admin egress rules", () => {
  async function withSet() {
    const started = await start();
    await call(started.base, "alice", "POST", `${BASE}/rule-sets`, { name: "web" });
    return started;
  }

  it("updates and deletes a rule by id, with revisions", async () => {
    const { base, db } = await withSet();
    await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, {
      effect: "allow",
      host: "Registry.NPMJS.org",
      note: "npm",
    });
    const put = await call(base, "alice", "PUT", `${BASE}/rules/1`, {
      ports: [443, 8443],
      route: "onecli",
      expectedRevision: 2,
    });
    expect(put.status).toBe(200);
    expect(await json(put)).toMatchObject({
      host: "registry.npmjs.org",
      ports: [443, 8443],
      route: "onecli",
      revision: 3,
    });
    expect((await call(base, "alice", "PUT", `${BASE}/rules/7`, { note: "x" })).status).toBe(404);
    expect(
      (await call(base, "alice", "PUT", `${BASE}/rules/1`, { note: "x", expectedRevision: 1 }))
        .status,
    ).toBe(409);
    expect((await call(base, "alice", "DELETE", `${BASE}/rules/1?expectedRevision=3`)).status).toBe(
      200,
    );
    expect((await call(base, "alice", "DELETE", `${BASE}/rules/1?expectedRevision=4`)).status).toBe(
      404,
    );
    expect(db.rules).toHaveLength(0);
  });

  it("answers 400 for invalid rules, 404 for a missing set, and writes nothing", async () => {
    const { base, db } = await withSet();
    const bad: unknown[] = [
      { host: "a.example.com" },
      { effect: "allow" },
      { effect: "allow", host: "10.0.0.1" },
      { effect: "allow", host: "*.example.com" },
      { effect: "allow", host: "a.example.com", ports: [0] },
      { effect: "allow", host: "a.example.com", scope: "global" },
      { effect: "allow", host: "*", route: "onecli" },
      { effect: "allow", host: "10.20.0.0/16" },
      { effect: "allow", host: "10.20.0.0/16", private: true },
      { effect: "allow", host: "127.0.0.0/8", private: true, ports: [80] },
      { effect: "allow", host: "*", private: true, ports: [80] },
      { effect: "deny", host: "a.example.com", private: true, ports: [80] },
    ];
    for (const body of bad) {
      expect(
        (await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (
        await call(base, "alice", "POST", `${BASE}/rule-sets/nope/rules`, {
          effect: "allow",
          host: "a.example.com",
        })
      ).status,
    ).toBe(404);
    await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, {
      effect: "allow",
      host: "a.example.com",
    });
    expect((await call(base, "alice", "PUT", `${BASE}/rules/1`, { ports: [] })).status).toBe(400);
    expect(db.rules).toHaveLength(1);
    expect(db.revision).toBe(2);
  });

  it("accepts a private rule with a cidr and explicit ports", async () => {
    const { base } = await withSet();
    const response = await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, {
      effect: "allow",
      host: "10.20.0.0/16",
      private: true,
      ports: [8080],
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({
      host: "10.20.0.0/16",
      private: true,
      ports: [8080],
      route: "direct",
    });
  });

  it("manages a session's own rules", async () => {
    const { base, db } = await withSet();
    const body = { effect: "allow", host: "github.com", route: "onecli" };
    const created = await call(base, "alice", "POST", `${BASE}/sessions/${SESSION}/rules`, body);
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({
      ruleSet: null,
      sessionId: SESSION,
      route: "onecli",
    });
    const listed = await json(
      await call(base, "alice", "GET", `${BASE}/sessions/${SESSION}/rules`),
    );
    expect(listed.rules).toHaveLength(1);
    const none = await json(
      await call(
        base,
        "alice",
        "GET",
        `${BASE}/sessions/99999999-2222-4333-8444-555555555555/rules`,
      ),
    );
    expect(none.rules).toEqual([]);
    expect((await call(base, "alice", "GET", `${BASE}/sessions/not-a-uuid/rules`)).status).toBe(
      400,
    );
    expect((await call(base, "alice", "DELETE", `${BASE}/sessions/${SESSION}/rules`)).status).toBe(
      405,
    );
    expect((await call(base, "alice", "DELETE", `${BASE}/rules/1?expectedRevision=2`)).status).toBe(
      200,
    );
    expect(db.rules).toHaveLength(0);
  });

  it("answers 405 and 404 for the wrong method or path", async () => {
    const { base } = await start();
    expect((await call(base, "alice", "PATCH", `${BASE}/rule-sets`)).status).toBe(405);
    expect((await call(base, "alice", "GET", `${BASE}/rule-sets/web/rules`)).status).toBe(405);
    expect((await call(base, "alice", "GET", `${BASE}/rules/1`)).status).toBe(405);
    expect((await call(base, "alice", "GET", `${BASE}/explain`)).status).toBe(405);
    expect((await call(base, "alice", "POST", `${BASE}/status`, {})).status).toBe(405);
    expect((await call(base, "alice", "GET", `${BASE}/nope`)).status).toBe(404);
    expect((await call(base, "alice", "GET", `${BASE}/rule-sets/web/x/y`)).status).toBe(404);
  });
});

describe("admin egress explain and status", () => {
  async function seeded() {
    const started = await start();
    const make = (path: string, body: unknown) =>
      call(started.base, "alice", "POST", `${BASE}${path}`, body);
    await make("/rule-sets", { name: "base", appliesToAll: true });
    await make("/rule-sets", { name: "web" });
    await make("/rule-sets", { name: "other" });
    await make("/rule-sets/web/rules", { effect: "allow", host: "*" });
    await make("/rule-sets/base/rules", {
      effect: "allow",
      host: "api.github.com",
      route: "onecli",
    });
    await make("/rule-sets/base/rules", { effect: "deny", host: ".evil.example" });
    await make("/rule-sets/base/rules", {
      effect: "allow",
      host: "10.20.0.0/16",
      private: true,
      ports: [8080],
    });
    await make("/rule-sets/other/rules", {
      effect: "allow",
      host: "tie.example.com",
      route: "onecli",
    });
    await make("/rule-sets/web/rules", { effect: "allow", host: "tie.example.com" });
    started.db.profiles.set("scraper", ["web", "other"]);
    started.db.profiles.set("coding", []);
    return started;
  }
  const explain = async (base: string, body: unknown) =>
    json(await call(base, "alice", "POST", `${BASE}/explain`, body));

  it("resolves the profile's rule sets and names the rule, its set and the route", async () => {
    const { base } = await seeded();
    expect(await explain(base, { host: "API.GitHub.com.", profile: "scraper" })).toMatchObject({
      decision: "allow",
      route: "onecli",
      matchedRuleId: "2",
      ruleSet: "base",
      host: "api.github.com",
      port: 443,
      profileRuleSets: ["web", "other"],
      matchedRule: { id: "2", host: "api.github.com" },
      addressesChecked: false,
    });
    expect(await explain(base, { host: "news.example.org", profile: "scraper" })).toMatchObject({
      decision: "allow",
      route: "direct",
      ruleSet: "web",
    });
    expect((await explain(base, { host: "news.example.org", profile: "coding" })).decision).toBe(
      "deny",
    );
    expect((await explain(base, { host: "news.example.org" })).decision).toBe("deny");
    const denied = await explain(base, { host: "x.evil.example", profile: "scraper" });
    expect(denied).toMatchObject({
      decision: "deny",
      route: null,
      matchedRuleId: "3",
      ruleSet: "base",
    });
    expect(denied.reason).toContain("rule 3");
    expect((await explain(base, { host: "10.0.0.1", profile: "scraper" })).decision).toBe("deny");
    expect(
      (await explain(base, { host: "news.example.org", port: 80, profile: "scraper" })).decision,
    ).toBe("deny");
  });

  it("shows both rules when equally specific rule sets disagree on the route", async () => {
    const { base } = await seeded();
    const result = await explain(base, { host: "tie.example.com", profile: "scraper" });
    expect(result).toMatchObject({
      decision: "deny",
      matchedRuleId: null,
      conflictingRuleIds: ["5", "6"],
    });
    expect(result.reason).toContain("conflicting routes");
    expect(
      (result.conflictingRules as { id: string; ruleSet: string }[]).map(
        (r) => `${r.id}:${r.ruleSet}`,
      ),
    ).toEqual(["5:other", "6:web"]);
    expect((await explain(base, { host: "tie.example.com", profile: "coding" })).decision).toBe(
      "deny",
    );
  });

  it("shows when a decision depended on the private flag", async () => {
    const { base } = await seeded();
    const needs = await explain(base, {
      host: "svc.example.org",
      profile: "scraper",
      addresses: ["10.99.0.1"],
    });
    expect(needs).toMatchObject({ decision: "deny", needsPrivate: true, addressesChecked: true });
    expect(needs.reason).toContain("private: true");
    expect(
      await explain(base, { host: "db.example.org", port: 8080, addresses: ["10.20.3.4"] }),
    ).toMatchObject({
      decision: "allow",
      route: "direct",
      needsPrivate: true,
      matchedRuleId: "4",
    });
    const blocked = await explain(base, {
      host: "x.example.org",
      profile: "scraper",
      addresses: ["169.254.169.254"],
    });
    expect(blocked).toMatchObject({ decision: "deny", matchedRuleId: null });
    expect(blocked.reason).toContain("always-blocked");
    expect(
      (
        await explain(base, {
          host: "news.example.org",
          profile: "scraper",
          addresses: ["93.184.216.34"],
        })
      ).decision,
    ).toBe("allow");
  });

  it("applies a session's own rules, and answers 400 for a bad request", async () => {
    const { base } = await seeded();
    await call(base, "alice", "POST", `${BASE}/sessions/${SESSION}/rules`, {
      effect: "allow",
      host: "tie.example.com",
    });
    expect(
      await explain(base, { host: "tie.example.com", profile: "scraper", sessionId: SESSION }),
    ).toMatchObject({ decision: "allow", ruleSet: null, matchedRuleId: "7" });
    const bad: unknown[] = [
      {},
      { host: 5 },
      { host: "a.example.com", port: 0 },
      { host: "a.example.com", port: "443" },
      { host: "a.example.com", sessionId: "nope" },
      { host: "a.example.com", profile: "Not A Name" },
      { host: "a.example.com", profile: "unknown" },
      { host: "a.example.com", addresses: "10.0.0.1" },
      { host: "a.example.com", addresses: [5] },
      { host: "a.example.com", extra: 1 },
    ];
    for (const body of bad) {
      expect(
        (await call(base, "alice", "POST", `${BASE}/explain`, body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });

  it("reports the revision, the counts and what each proxy replica says", async () => {
    const { base, db } = await start();
    expect(await json(await call(base, "alice", "GET", `${BASE}/status`))).toMatchObject({
      revision: 0,
      ruleSets: 0,
      rules: 0,
      proxy: { replicas: [] },
    });
    await call(base, "alice", "POST", `${BASE}/rule-sets`, { name: "web" });
    await call(base, "alice", "POST", `${BASE}/rule-sets/web/rules`, {
      effect: "deny",
      host: "a.example.com",
    });
    db.insertRaw({ host: "10.0.0.1" });
    const at = new Date("2026-11-18T12:00:00Z");
    db.proxyStatus.push(
      {
        replica: "pi-egress-proxy-a",
        revision: 2,
        state: "serving",
        last_read_at: at,
        started_at: at,
        version: "test",
        updated_at: at,
        silent_seconds: 3,
      },
      {
        replica: "pi-egress-proxy-b",
        revision: 1,
        state: "serving",
        last_read_at: at,
        started_at: at,
        version: "test",
        updated_at: at,
        silent_seconds: 300,
      },
    );
    const status = await json(await call(base, "alice", "GET", `${BASE}/status`));
    expect(status).toMatchObject({ revision: 2, ruleSets: 1, rules: 1, invalid: 1 });
    expect((status as { proxy: unknown }).proxy).toEqual({
      replicas: [
        {
          name: "pi-egress-proxy-a",
          revision: 2,
          state: "serving",
          lastReadAt: at.toISOString(),
          startedAt: at.toISOString(),
          updatedAt: at.toISOString(),
          version: "test",
        },
        {
          name: "pi-egress-proxy-b",
          revision: 1,
          state: "silent",
          lastReadAt: at.toISOString(),
          startedAt: at.toISOString(),
          updatedAt: at.toISOString(),
          version: "test",
        },
      ],
    });
  });
});
