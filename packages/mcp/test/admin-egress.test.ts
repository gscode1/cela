import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EGRESS_EFFECTS,
  EGRESS_ROUTES,
  MAX_RULE_NOTE,
  MAX_RULE_PORTS,
  RULE_SET_NAME,
  validateEgressRule,
  validateRuleSet,
  type EgressRuleSpec,
  type RuleSetSpec,
} from "@cela/session-core";
import {
  EGRESS_RULE_SET_SHAPE,
  EGRESS_RULE_SHAPE,
  MAX_DESCRIPTION,
  MAX_NOTE,
  MAX_PORTS,
  putRuleInput,
} from "../src/admin/egress.js";
import { adminEnv, dangerousEnv, withClient, writesEnv } from "./admin-fixture.js";
import { FakeApi } from "./fake-api.js";

const SESSION = "11111111-2222-4333-8444-555555555555";
const readTools = [
  "admin_list_egress_rule_sets",
  "admin_get_egress_rule_set",
  "admin_get_egress_status",
  "admin_list_session_egress_rules",
  "admin_explain_egress",
];
const dangerousTools = [
  "admin_put_egress_rule_set",
  "admin_delete_egress_rule_set",
  "admin_put_egress_rule",
  "admin_delete_egress_rule",
];

describe("admin egress tools", { timeout: 10_000 }, () => {
  let fake: FakeApi;
  beforeEach(async () => {
    fake = await FakeApi.start();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await fake.close();
  });

  const envOf = (env: Record<string, string>): Record<string, string> => ({
    ...env,
    PI_API_URL: fake.url,
    PI_API_TOKEN: fake.token,
    PI_API_ADMIN_TOKEN: fake.adminToken,
  });

  it("exposes the dangerous egress tools only with the dangerous flag", async () => {
    for (const [env, writes] of [
      [adminEnv, false],
      [writesEnv, true],
    ] as const) {
      await withClient(envOf(env), async (client) => {
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        for (const name of readTools) expect(names, name).toContain(name);
        for (const name of dangerousTools)
          expect(names, `${name} ${String(writes)}`).not.toContain(name);
      });
    }
    await withClient(envOf(dangerousEnv), async (client) => {
      const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
      for (const name of dangerousTools) {
        expect(tools.get(name)?.annotations, name).toMatchObject({
          readOnlyHint: false,
          destructiveHint: true,
        });
      }
      for (const name of readTools) {
        expect(tools.get(name)?.annotations?.readOnlyHint, name).toBe(true);
      }
    });
  });

  it("validates names, ids and session ids before making a request", async () => {
    await withClient(envOf(dangerousEnv), async (client) => {
      const calls: [string, Record<string, unknown>][] = [
        ["admin_get_egress_rule_set", { name: "a".repeat(33) }],
        ["admin_list_session_egress_rules", { sessionId: "not-a-uuid" }],
        ["admin_list_session_egress_rules", { sessionId: "AAAAAAAA-2222-4333-8444-555555555555" }],
        ["admin_explain_egress", { host: "" }],
        ["admin_explain_egress", { host: "x".repeat(301) }],
        ["admin_explain_egress", { host: "a.test", port: 0 }],
        ["admin_explain_egress", { host: "a.test", port: 65536 }],
        ["admin_explain_egress", { host: "a.test", addresses: Array(17).fill("1.1.1.1") }],
        ["admin_put_egress_rule_set", { name: "Bad", expectedRevision: 1 }],
        ["admin_put_egress_rule_set", { name: "ok", expectedRevision: -1 }],
        ["admin_delete_egress_rule_set", { name: "ok", expectedRevision: 0 }],
        ["admin_delete_egress_rule", { id: "0", expectedRevision: 1 }],
        ["admin_delete_egress_rule", { id: "12/../x", expectedRevision: 1 }],
        ["admin_delete_egress_rule", { id: "1234567890123456789", expectedRevision: 1 }],
        ["admin_delete_egress_rule", { id: "5", expectedRevision: 0 }],
        ["admin_put_egress_rule", { id: "5x", expectedRevision: 1 }],
      ];
      for (const [name, args] of calls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
      }
      expect(fake.adminRequests).toEqual([]);
    });
  });

  it("reads status, a session's rules and the rule sets", async () => {
    fake.onAdmin("GET", "/admin/egress/status", { body: { revision: 7 } });
    fake.onAdmin("GET", `/admin/egress/sessions/${SESSION}/rules`, {
      body: { revision: 7, rules: [], networkMode: "proxied" },
    });
    fake.onAdmin("GET", "/admin/egress/rule-sets", { body: { revision: 7, ruleSets: [] } });
    fake.onAdmin("GET", "/admin/egress/rule-sets/demo", { body: { name: "demo", rules: [] } });
    await withClient(envOf(adminEnv), async (client) => {
      const status = await client.callTool({ name: "admin_get_egress_status", arguments: {} });
      expect(status.structuredContent).toEqual({ revision: 7 });
      const rules = await client.callTool({
        name: "admin_list_session_egress_rules",
        arguments: { sessionId: SESSION },
      });
      expect(rules.structuredContent).toMatchObject({ networkMode: "proxied" });
      await client.callTool({ name: "admin_list_egress_rule_sets", arguments: {} });
      await client.callTool({ name: "admin_get_egress_rule_set", arguments: { name: "demo" } });
      expect(fake.adminRequests.map((r) => `${r.method} ${r.path}`)).toEqual([
        "GET /admin/egress/status",
        `GET /admin/egress/sessions/${SESSION}/rules`,
        "GET /admin/egress/rule-sets",
        "GET /admin/egress/rule-sets/demo",
      ]);
    });
  });

  it("explains with a POST that carries only what was given, from the read tier", async () => {
    fake.onAdmin("POST", "/admin/egress/explain", {
      body: { decision: "deny", addressesChecked: false },
    });
    await withClient(envOf(adminEnv), async (client) => {
      const result = await client.callTool({
        name: "admin_explain_egress",
        arguments: { host: "Example.com" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ decision: "deny" });
      await client.callTool({
        name: "admin_explain_egress",
        arguments: {
          host: "example.com",
          port: 8443,
          sessionId: SESSION,
          profile: "coding",
          addresses: ["10.0.0.5"],
        },
      });
    });
    expect(fake.adminRequests.map((r) => r.body)).toEqual([
      { host: "Example.com" },
      {
        host: "example.com",
        port: 8443,
        sessionId: SESSION,
        profile: "coding",
        addresses: ["10.0.0.5"],
      },
    ]);
  });

  it("creates a rule set with a POST and updates it with a PUT", async () => {
    fake.onAdmin("POST", "/admin/egress/rule-sets", { status: 201, body: { name: "demo" } });
    fake.onAdmin("PUT", "/admin/egress/rule-sets/demo", { body: { name: "demo" } });
    await withClient(envOf(dangerousEnv), async (client) => {
      await client.callTool({
        name: "admin_put_egress_rule_set",
        arguments: {
          name: "demo",
          expectedRevision: 0,
          description: "d",
          appliesToAll: false,
          create: true,
        },
      });
      await client.callTool({
        name: "admin_put_egress_rule_set",
        arguments: { name: "demo", expectedRevision: 3, appliesToAll: true },
      });
    });
    expect(fake.adminRequests).toMatchObject([
      {
        method: "POST",
        path: "/admin/egress/rule-sets",
        body: { name: "demo", expectedRevision: 0, description: "d", appliesToAll: false },
      },
      {
        method: "PUT",
        path: "/admin/egress/rule-sets/demo",
        body: { expectedRevision: 3, appliesToAll: true },
      },
    ]);
    expect(fake.adminRequests[1]?.body).not.toHaveProperty("create");
    expect(fake.adminRequests[1]?.body).not.toHaveProperty("name");
  });

  it("deletes a rule set and a rule with expectedRevision in the query", async () => {
    fake.onAdmin("DELETE", "/admin/egress/rule-sets/demo", {
      body: { name: "demo", deleted: true },
    });
    fake.onAdmin("DELETE", "/admin/egress/rules/42", { body: { id: "42", deleted: true } });
    await withClient(envOf(dangerousEnv), async (client) => {
      await client.callTool({
        name: "admin_delete_egress_rule_set",
        arguments: { name: "demo", expectedRevision: 9 },
      });
      const result = await client.callTool({
        name: "admin_delete_egress_rule",
        arguments: { id: "42", expectedRevision: 10 },
      });
      expect(result.structuredContent).toEqual({ id: "42", deleted: true });
    });
    expect(fake.adminRequests).toMatchObject([
      {
        method: "DELETE",
        path: "/admin/egress/rule-sets/demo",
        query: { expectedRevision: "9" },
        body: undefined,
      },
      { method: "DELETE", path: "/admin/egress/rules/42", query: { expectedRevision: "10" } },
    ]);
  });

  it("creates a rule in a rule set or a session and updates one by id", async () => {
    fake.onAdmin("POST", "/admin/egress/rule-sets/demo/rules", { status: 201, body: { id: "1" } });
    fake.onAdmin("POST", `/admin/egress/sessions/${SESSION}/rules`, {
      status: 201,
      body: { id: "2" },
    });
    fake.onAdmin("PUT", "/admin/egress/rules/2", { body: { id: "2" } });
    await withClient(envOf(dangerousEnv), async (client) => {
      const expiresAt = "2030-01-01T00:00:00Z";
      for (const args of [
        {
          ruleSet: "demo",
          expectedRevision: 0,
          effect: "allow",
          host: ".example.com",
          ports: [443, 8443],
          route: "direct",
          note: "n",
        },
        { sessionId: SESSION, expectedRevision: 4, effect: "deny", host: "bad.test", expiresAt },
        { id: "2", expectedRevision: 5, expiresAt: null, private: false },
      ]) {
        const result = await client.callTool({ name: "admin_put_egress_rule", arguments: args });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
    });
    expect(fake.adminRequests).toMatchObject([
      {
        method: "POST",
        path: "/admin/egress/rule-sets/demo/rules",
        body: {
          expectedRevision: 0,
          effect: "allow",
          host: ".example.com",
          ports: [443, 8443],
          route: "direct",
          note: "n",
        },
      },
      {
        method: "POST",
        path: `/admin/egress/sessions/${SESSION}/rules`,
        body: {
          expectedRevision: 4,
          effect: "deny",
          host: "bad.test",
          expiresAt: "2030-01-01T00:00:00Z",
        },
      },
      {
        method: "PUT",
        path: "/admin/egress/rules/2",
        body: { expectedRevision: 5, expiresAt: null, private: false },
      },
    ]);
    // The owner and the id go in the path, never the body.
    for (const request of fake.adminRequests) {
      for (const key of ["id", "ruleSet", "sessionId"])
        expect(request.body, key).not.toHaveProperty(key);
    }
  });

  it("refuses a rule that names no owner or two, lacks effect and host, or moves an owner", () => {
    const ok = { expectedRevision: 1, effect: "allow", host: "a.test" };
    expect(putRuleInput.safeParse({ ...ok, ruleSet: "demo" }).success).toBe(true);
    expect(putRuleInput.safeParse({ ...ok, sessionId: SESSION }).success).toBe(true);
    expect(putRuleInput.safeParse({ expectedRevision: 1, id: "7", note: "x" }).success).toBe(true);
    expect(putRuleInput.safeParse(ok).success).toBe(false);
    expect(putRuleInput.safeParse({ ...ok, ruleSet: "demo", sessionId: SESSION }).success).toBe(
      false,
    );
    expect(
      putRuleInput.safeParse({ expectedRevision: 1, ruleSet: "demo", host: "a.test" }).success,
    ).toBe(false);
    expect(
      putRuleInput.safeParse({ expectedRevision: 1, ruleSet: "demo", effect: "allow" }).success,
    ).toBe(false);
    expect(putRuleInput.safeParse({ expectedRevision: 1, id: "7", ruleSet: "demo" }).success).toBe(
      false,
    );
    expect(
      putRuleInput.safeParse({ expectedRevision: 1, id: "7", sessionId: SESSION }).success,
    ).toBe(false);
  });

  it("refuses a rule put that fails the refine before making a request", async () => {
    await withClient(envOf(dangerousEnv), async (client) => {
      const result = await client.callTool({
        name: "admin_put_egress_rule",
        arguments: { expectedRevision: 1, effect: "allow", host: "a.test" },
      });
      expect(result.isError).toBe(true);
      expect(fake.adminRequests).toEqual([]);
    });
  });

  it.each([
    ["admin_put_egress_rule_set", { name: "demo", expectedRevision: 1 }],
    ["admin_delete_egress_rule_set", { name: "demo", expectedRevision: 1 }],
    ["admin_delete_egress_rule", { id: "3", expectedRevision: 1 }],
    ["admin_put_egress_rule", { id: "3", expectedRevision: 1 }],
  ])("passes a 409 of %s through as the error", async (name, args) => {
    fake.onAdmin("PUT", /.*/, {
      status: 409,
      body: { error: "the egress rules are at revision 5, not the expected 1" },
    });
    fake.onAdmin("DELETE", /.*/, {
      status: 409,
      body: { error: "the egress rules are at revision 5, not the expected 1" },
    });
    await withClient(envOf(dangerousEnv), async (client) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: "the egress rules are at revision 5, not the expected 1",
        status: 409,
      });
    });
  });

  it("passes the blockedBy of a refused rule set delete through as details", async () => {
    fake.onAdmin("DELETE", "/admin/egress/rule-sets/demo", {
      status: 409,
      body: {
        error: "rule set is named by a profile",
        blockedBy: { profiles: [{ name: "coding", version: 3 }] },
      },
    });
    await withClient(envOf(dangerousEnv), async (client) => {
      const result = await client.callTool({
        name: "admin_delete_egress_rule_set",
        arguments: { name: "demo", expectedRevision: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: "rule set is named by a profile",
        status: 409,
        details: { blockedBy: { profiles: [{ name: "coding", version: 3 }] } },
      });
    });
  });
});

describe("egress input shapes match session-core", () => {
  it("has exactly the fields of EgressRuleSpec and RuleSetSpec", () => {
    // `Record<keyof ..., true>` fails to compile when the type gains or loses a field.
    const rule: Record<keyof EgressRuleSpec, true> = {
      effect: true,
      host: true,
      ports: true,
      route: true,
      private: true,
      expiresAt: true,
      note: true,
    };
    const set: Record<keyof RuleSetSpec, true> = { description: true, appliesToAll: true };
    expect(Object.keys(EGRESS_RULE_SHAPE).sort()).toEqual(Object.keys(rule).sort());
    expect(Object.keys(EGRESS_RULE_SET_SHAPE).sort()).toEqual(Object.keys(set).sort());
    for (const [key, field] of [
      ...Object.entries(EGRESS_RULE_SHAPE),
      ...Object.entries(EGRESS_RULE_SET_SHAPE),
    ])
      expect(field.description, key).toBeTruthy();
  });

  it("has the enums and limits of session-core", () => {
    expect([...EGRESS_EFFECTS].sort()).toEqual(["allow", "deny"]);
    expect([...EGRESS_ROUTES].sort()).toEqual(["direct", "onecli"]);
    for (const effect of EGRESS_EFFECTS)
      expect(EGRESS_RULE_SHAPE.effect.safeParse(effect).success, effect).toBe(true);
    for (const route of EGRESS_ROUTES)
      expect(EGRESS_RULE_SHAPE.route.safeParse(route).success, route).toBe(true);
    expect(EGRESS_RULE_SHAPE.effect.safeParse("log").success).toBe(false);
    expect(EGRESS_RULE_SHAPE.route.safeParse("proxy").success).toBe(false);
    expect(MAX_NOTE).toBe(MAX_RULE_NOTE);
    expect(MAX_PORTS).toBe(MAX_RULE_PORTS);
    const ports = (count: number): number[] => Array.from({ length: count }, (_, i) => i + 1);
    expect(EGRESS_RULE_SHAPE.ports.safeParse(ports(MAX_RULE_PORTS)).success).toBe(true);
    expect(EGRESS_RULE_SHAPE.ports.safeParse(ports(MAX_RULE_PORTS + 1)).success).toBe(false);
    expect(EGRESS_RULE_SHAPE.ports.safeParse([]).success).toBe(false);
    expect(EGRESS_RULE_SHAPE.ports.safeParse([65536]).success).toBe(false);
    expect(EGRESS_RULE_SHAPE.note.safeParse("x".repeat(MAX_RULE_NOTE)).success).toBe(true);
    expect(EGRESS_RULE_SHAPE.note.safeParse("x".repeat(MAX_RULE_NOTE + 1)).success).toBe(false);
  });

  it("agrees with session-core's validators on the rule set description limit and the name", () => {
    // MAX_RULE_SET_DESCRIPTION is not exported: compare behaviour at its edge.
    const at = validateRuleSet("demo", { description: "x".repeat(MAX_DESCRIPTION) });
    const over = validateRuleSet("demo", { description: "x".repeat(MAX_DESCRIPTION + 1) });
    expect(typeof at).toBe("object");
    expect(typeof over).toBe("string");
    expect(EGRESS_RULE_SET_SHAPE.description.safeParse("x".repeat(MAX_DESCRIPTION)).success).toBe(
      true,
    );
    expect(
      EGRESS_RULE_SET_SHAPE.description.safeParse("x".repeat(MAX_DESCRIPTION + 1)).success,
    ).toBe(false);
    expect(RULE_SET_NAME.source).toBe("^[a-z][a-z0-9-]{0,31}$");
  });

  it("accepts what session-core's rule validator accepts in the shapes it types", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const rules = [
      { effect: "allow", host: "registry.npmjs.org" },
      { effect: "allow", host: ".example.com", ports: [443, 8443], route: "onecli", note: "n" },
      { effect: "deny", host: "*", expiresAt: "2030-01-01T00:00:00Z" },
      { effect: "allow", host: "10.20.0.0/16", private: true, ports: [5432], expiresAt: null },
    ];
    for (const rule of rules) {
      expect(typeof validateEgressRule(rule, now), JSON.stringify(rule)).toBe("object");
      for (const [key, value] of Object.entries(rule))
        expect(
          EGRESS_RULE_SHAPE[key as keyof typeof EGRESS_RULE_SHAPE].safeParse(value).success,
          key,
        ).toBe(true);
    }
  });
});
