import { describe, expect, it } from "vitest";
import type { EgressHistoryEntry, EgressRule } from "@/lib/api/egress";
import {
  describeEgressChange,
  EMPTY_RULE_FORM,
  effectiveRoute,
  formFromRule,
  isStaleMessage,
  parsePorts,
  routeLocked,
  ruleBody,
  ruleProblems,
  ruleSetNameProblem,
} from "@/lib/egress-form";
import type { RuleForm } from "@/lib/egress-form";
import { rule } from "./fake-egress";

const form = (change: Partial<RuleForm>): RuleForm => ({ ...EMPTY_RULE_FORM, ...change });
const NOW = new Date("2026-11-18T12:00:00");

describe("rule validation, mirroring the server", () => {
  it("accepts an exact host, a suffix with two labels, * and nothing else public", () => {
    expect(ruleProblems(form({ host: "registry.npmjs.org" }), NOW)).toEqual([]);
    expect(ruleProblems(form({ host: ".githubusercontent.com" }), NOW)).toEqual([]);
    expect(ruleProblems(form({ host: "*" }), NOW)).toEqual([]);
    expect(ruleProblems(form({ host: "" }), NOW)).toEqual(["the host is required"]);
    expect(ruleProblems(form({ host: "*.example.com" }), NOW)[0]).toMatch(/wildcard/);
    expect(ruleProblems(form({ host: "10.0.0.1" }), NOW)[0]).toMatch(/IP address/);
    expect(ruleProblems(form({ host: "https://example.com" }), NOW)).not.toEqual([]);
  });

  it("normalises case and a trailing dot before checking", () => {
    expect(ruleProblems(form({ host: " Registry.NPMJS.org. " }), NOW)).toEqual([]);
    expect(ruleBody(form({ host: " Registry.NPMJS.org. " })).host).toBe("registry.npmjs.org");
  });

  it("refuses an allow suffix over a whole top-level domain, but lets a deny have it", () => {
    expect(ruleProblems(form({ host: ".ru" }), NOW)[0]).toMatch(/two labels/);
    expect(ruleProblems(form({ host: ".ru", effect: "deny" }), NOW)).toEqual([]);
  });

  it("requires private for a cidr", () => {
    expect(ruleProblems(form({ host: "10.20.0.0/16", ports: "80" }), NOW)[0]).toMatch(
      /needs private/,
    );
    expect(ruleProblems(form({ host: "10.20.0.0/16", ports: "80", private: true }), NOW)).toEqual(
      [],
    );
    expect(ruleProblems(form({ host: "10.0.0.0/4", ports: "80", private: true }), NOW)[0]).toMatch(
      /\/8 to \/32/,
    );
    expect(ruleProblems(form({ host: "fd00::/8", ports: "80", private: true }), NOW)[0]).toMatch(
      /\/32/,
    );
  });

  it("requires a private rule to be an allow of an exact host or cidr with explicit ports", () => {
    const base = { private: true, ports: "8080" };
    expect(
      ruleProblems(form({ ...base, host: "billing.payments.svc.cluster.local" }), NOW),
    ).toEqual([]);
    expect(ruleProblems(form({ ...base, host: "*" }), NOW)[0]).toMatch(/narrow target/);
    expect(ruleProblems(form({ ...base, host: ".example.com" }), NOW)[0]).toMatch(/narrow target/);
    expect(ruleProblems(form({ ...base, host: "localhost" }), NOW)[0]).toMatch(/localhost/);
    expect(ruleProblems(form({ ...base, host: "a.internal", effect: "deny" }), NOW)).toContain(
      "private applies to an allow rule only",
    );
    expect(ruleProblems(form({ private: true, host: "a.internal" }), NOW)).toContain(
      "a private rule needs explicit ports",
    );
  });

  it("forces route direct for *, a deny and a private rule", () => {
    expect(routeLocked(form({ host: "*" }))).toMatch(/always direct/);
    expect(routeLocked(form({ host: "a.example.com", effect: "deny" }))).toMatch(/always direct/);
    expect(routeLocked(form({ host: "a.internal", private: true }))).toMatch(/always direct/);
    expect(routeLocked(form({ host: "api.github.com" }))).toBeUndefined();
    // A route chosen earlier is not sent once the rule can only be direct.
    const stale = form({ host: "*", route: "onecli" });
    expect(effectiveRoute(stale)).toBe("direct");
    expect(ruleBody(stale).route).toBe("direct");
    expect(ruleBody(form({ host: "api.github.com", route: "onecli" })).route).toBe("onecli");
  });

  it("reads ports as a sorted set of 1 to 65535", () => {
    expect(parsePorts("443, 80 443")).toEqual([80, 443]);
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts("0")).toMatch(/1 to 65535/);
    expect(parsePorts("65536")).toMatch(/1 to 65535/);
    expect(parsePorts("http")).toMatch(/not a port/);
    expect(parsePorts(Array.from({ length: 33 }, (_, i) => String(i + 1)).join(","))).toMatch(
      /at most 32/,
    );
    expect(ruleBody(form({ host: "a.example.com" })).ports).toEqual([443]);
  });

  it("wants an expiry in the future, except one the operator did not touch", () => {
    expect(
      ruleProblems(form({ host: "a.example.com", expiresAt: "2026-11-18T11:00" }), NOW),
    ).toEqual(["the expiry must lie in the future"]);
    expect(
      ruleProblems(form({ host: "a.example.com", expiresAt: "2026-11-19T11:00" }), NOW),
    ).toEqual([]);
    const past = rule({ id: "5", host: "a.example.com", expiresAt: "2026-11-01T10:00:00.000Z" });
    const original = formFromRule(past);
    expect(ruleProblems(original, NOW, original)).toEqual([]);
    expect(ruleBody(original, past).expiresAt).toBe("2026-11-01T10:00:00.000Z");
    expect(ruleBody(form({ host: "a.example.com" })).expiresAt).toBeNull();
  });

  it("limits the note", () => {
    expect(ruleProblems(form({ host: "a.example.com", note: "x".repeat(501) }), NOW)).toEqual([
      "the note has at most 500 characters",
    ]);
  });
});

describe("names and messages", () => {
  it("checks a rule set name like the server", () => {
    expect(ruleSetNameProblem("open-web")).toBeUndefined();
    expect(ruleSetNameProblem("Open")).toBeDefined();
    expect(ruleSetNameProblem("1set")).toBeDefined();
    expect(ruleSetNameProblem("x".repeat(33))).toBeDefined();
  });

  it("tells a stale revision from the other 409s", () => {
    expect(
      isStaleMessage("the egress rules are at revision 4, not the expected 3: reload and retry"),
    ).toBe(true);
    expect(isStaleMessage("rule set npm already exists: choose another name")).toBe(false);
  });
});

describe("history sentences", () => {
  const entry = (change: Partial<EgressHistoryEntry>): EgressHistoryEntry => ({
    id: "1",
    revision: 4,
    changedAt: "2026-11-17T00:00:00.000Z",
    changedBy: "alice",
    kind: "rule",
    ref: "7",
    action: "create",
    old: null,
    new: null,
    ...change,
  });
  const snapshot = (over: Partial<EgressRule> = {}) => ({
    ruleSet: "npm",
    sessionId: null,
    effect: "allow",
    host: "a.example.com",
    ports: [443],
    route: "direct",
    private: false,
    expiresAt: null,
    note: "",
    ...over,
  });

  it("describes rule and rule set changes", () => {
    expect(describeEgressChange(entry({ new: snapshot() }))).toBe(
      "created rule #7 in npm: allow a.example.com ports 443 via direct",
    );
    expect(
      describeEgressChange(
        entry({ action: "update", old: snapshot(), new: snapshot({ ports: [80] }) }),
      ),
    ).toBe(
      "changed rule #7 in npm: allow a.example.com ports 443 via direct to allow a.example.com ports 80 via direct",
    );
    expect(
      describeEgressChange(
        entry({
          kind: "rule-set",
          ref: "npm",
          action: "delete",
          old: { description: "d", appliesToAll: true, rules: [{}, {}] },
        }),
      ),
    ).toBe('deleted rule set npm with 2 rules: "d", applies to all sessions');
    expect(
      describeEgressChange(entry({ new: snapshot({ ruleSet: null, sessionId: "abc" }) })),
    ).toContain("of session abc");
  });
});
