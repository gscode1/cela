import { describe, expect, it } from "vitest";
import {
  classifyAddress,
  evaluateEgress,
  normalizeHost,
  validateEgressRule,
  validateRuleSet,
} from "../src/egress-rules.ts";
import type {
  EgressRequest,
  EgressRuleSpec,
  EvaluableRule,
  EvaluableRuleSet,
} from "../src/egress-rules.ts";

const NOW = new Date("2026-11-18T12:00:00Z");
const SESSION = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-2222-4333-8444-555555555555";

let next = 1;
/** A rule of rule set `set` (default "base"); `set: null` with a `sessionId` makes a session rule. */
const rule = (host: string, extra: Partial<EvaluableRule> = {}): EvaluableRule => ({
  id: String(next++),
  ruleSet: "base",
  sessionId: null,
  effect: "allow",
  host,
  ports: [443],
  route: "direct",
  private: false,
  expiresAt: null,
  note: "",
  ...extra,
});
const sessionRule = (host: string, extra: Partial<EvaluableRule> = {}): EvaluableRule =>
  rule(host, { ruleSet: null, sessionId: SESSION, ...extra });

const SETS: EvaluableRuleSet[] = [
  { name: "base", appliesToAll: true },
  { name: "web", appliesToAll: false },
  { name: "other", appliesToAll: false },
];
const ask = (rules: EvaluableRule[], host: string, extra: Partial<EgressRequest> = {}) =>
  evaluateEgress(SETS, rules, { host, port: 443, now: NOW, ...extra });

describe("evaluateEgress precedence", () => {
  it("denies by default", () => {
    const result = ask([], "example.com");
    expect(result).toMatchObject({
      decision: "deny",
      route: null,
      matchedRuleId: null,
      ruleSet: null,
    });
    expect(result.reason).toContain("default deny");
  });

  it("allows an exact host, returns the route and the rule set", () => {
    const allow = rule("api.github.com", { route: "onecli" });
    expect(ask([allow], "api.github.com")).toMatchObject({
      decision: "allow",
      route: "onecli",
      matchedRuleId: allow.id,
      ruleSet: "base",
    });
  });

  it("matches a suffix on subdomains only, not the bare domain", () => {
    const allow = rule(".githubusercontent.com");
    expect(ask([allow], "raw.githubusercontent.com").decision).toBe("allow");
    expect(ask([allow], "a.b.githubusercontent.com").decision).toBe("allow");
    expect(ask([allow], "githubusercontent.com").decision).toBe("deny");
    expect(ask([allow], "evilgithubusercontent.com").decision).toBe("deny");
  });

  it("is case-insensitive and ignores one trailing dot", () => {
    const allow = rule("registry.npmjs.org");
    expect(ask([allow], "Registry.NPMJS.org.").decision).toBe("allow");
    expect(normalizeHost("A.B.")).toBe("a.b");
    expect(ask([allow], "registry.npmjs.org..").decision).toBe("deny");
  });

  it("matches only listed ports", () => {
    const allow = rule("example.com", { ports: [443, 8443] });
    expect(
      evaluateEgress(SETS, [allow], { host: "example.com", port: 8443, now: NOW }).decision,
    ).toBe("allow");
    expect(
      evaluateEgress(SETS, [allow], { host: "example.com", port: 80, now: NOW }).decision,
    ).toBe("deny");
  });

  it("applies a rule set only when it applies to all or the profile names it", () => {
    const web = rule("example.com", { ruleSet: "web" });
    expect(ask([web], "example.com").decision).toBe("deny");
    expect(ask([web], "example.com", { profileRuleSets: ["other"] }).decision).toBe("deny");
    expect(ask([web], "example.com", { profileRuleSets: ["web"] })).toMatchObject({
      decision: "allow",
      ruleSet: "web",
    });
    const orphan = rule("example.org", { ruleSet: "gone" });
    expect(ask([orphan], "example.org", { profileRuleSets: ["gone"] }).decision).toBe("deny");
  });

  it("applies a session's own rules to that session only, case-insensitively", () => {
    const own = sessionRule("example.com");
    expect(ask([own], "example.com").decision).toBe("deny");
    expect(ask([own], "example.com", { sessionId: OTHER }).decision).toBe("deny");
    expect(ask([own], "example.com", { sessionId: SESSION.toUpperCase() })).toMatchObject({
      decision: "allow",
      ruleSet: null,
      matchedRuleId: own.id,
    });
  });

  it("lets any matching deny win over a more specific allow, wherever it comes from", () => {
    const allow = sessionRule("api.example.com");
    const deny = rule(".example.com", { effect: "deny" });
    const result = ask([allow, deny], "api.example.com", { sessionId: SESSION });
    expect(result).toMatchObject({ decision: "deny", matchedRuleId: deny.id, ruleSet: "base" });
  });

  it("prefers an exact allow over a suffix allow, and a longer suffix over a shorter", () => {
    const suffix = rule(".example.com");
    const exact = rule("a.b.example.com", { route: "onecli" });
    const longer = rule(".b.example.com");
    expect(ask([suffix, longer, exact], "a.b.example.com").matchedRuleId).toBe(exact.id);
    expect(ask([suffix, longer], "a.b.example.com").matchedRuleId).toBe(longer.id);
    expect(ask([longer, suffix], "x.example.com").matchedRuleId).toBe(suffix.id);
  });

  it("ranks host specificity before who owns the rule", () => {
    const setExact = rule("api.example.com", { route: "onecli" });
    const sessionSuffix = sessionRule(".example.com");
    expect(
      ask([sessionSuffix, setExact], "api.example.com", { sessionId: SESSION }).matchedRuleId,
    ).toBe(setExact.id);
  });

  it("lets a session rule beat a rule set's rule on the same host, even with another route", () => {
    const set = rule("example.com", { route: "onecli" });
    const own = sessionRule("example.com", { route: "direct" });
    expect(ask([set, own], "example.com", { sessionId: SESSION })).toMatchObject({
      matchedRuleId: own.id,
      route: "direct",
    });
  });

  it("denies, with both rules, when two rule sets tie and disagree on the route", () => {
    const a = rule("example.com", { ruleSet: "base", route: "direct" });
    const b = rule("example.com", { ruleSet: "web", route: "onecli" });
    const result = ask([a, b], "example.com", { profileRuleSets: ["web"] });
    expect(result).toMatchObject({
      decision: "deny",
      route: null,
      matchedRuleId: null,
      conflictingRuleIds: [a.id, b.id],
    });
    expect(result.reason).toContain("conflicting routes");
    expect(result.reason).toContain("rule set base");
    expect(result.reason).toContain("rule set web");
  });

  it("allows when tied rule sets agree on the route, reporting the older rule", () => {
    const a = rule("example.com", { id: "10", ruleSet: "base" });
    const b = rule("example.com", { id: "9", ruleSet: "web" });
    expect(ask([a, b], "example.com", { profileRuleSets: ["web"] })).toMatchObject({
      decision: "allow",
      matchedRuleId: "9",
      ruleSet: "web",
    });
  });

  it("ignores expired rules, deny included", () => {
    const allow = rule("example.com", { expiresAt: new Date("2026-11-19T00:00:00Z") });
    const expiredDeny = rule("example.com", {
      effect: "deny",
      expiresAt: new Date("2026-11-18T11:00:00Z"),
    });
    const atNow = rule("example.com", { effect: "deny", expiresAt: NOW });
    expect(ask([allow, expiredDeny, atNow], "example.com").matchedRuleId).toBe(allow.id);
    expect(ask([allow], "example.com", { now: new Date("2026-11-19T00:00:00Z") }).decision).toBe(
      "deny",
    );
  });

  it("denies IP literals, malformed names and bad ports without consulting rules", () => {
    const any = rule("*");
    for (const host of [
      "10.0.0.1",
      "127.1",
      "2130706433",
      "0x7f.0.0.1",
      "[::1]",
      "::ffff:10.0.0.1",
      "a b.com",
      "",
      "a..b",
    ]) {
      expect(ask([any], host).decision, host).toBe("deny");
    }
    for (const port of [0, 70000, 1.5]) {
      expect(evaluateEgress(SETS, [any], { host: "example.com", port, now: NOW }).decision).toBe(
        "deny",
      );
    }
  });
});

describe('evaluateEgress with "*" (any host)', () => {
  const profile = { profileRuleSets: ["web"] };

  it("allows any named host on its ports, direct, only for a profile that names the set", () => {
    const open = rule("*", { ruleSet: "web" });
    expect(ask([open], "anything.example.net", profile)).toMatchObject({
      decision: "allow",
      route: "direct",
      matchedRuleId: open.id,
    });
    expect(ask([open], "anything.example.net").decision).toBe("deny");
    expect(
      evaluateEgress(SETS, [open], { host: "x.com", port: 80, now: NOW, ...profile }).decision,
    ).toBe("deny");
  });

  it("loses to a deny for a host in any set that applies", () => {
    const open = rule("*", { ruleSet: "web" });
    const deny = rule("evil.example.com", { effect: "deny" });
    expect(ask([open, deny], "evil.example.com", profile)).toMatchObject({
      decision: "deny",
      matchedRuleId: deny.id,
    });
    expect(ask([open, deny], "good.example.com", profile).decision).toBe("allow");
  });

  it("is beaten by a named onecli rule, and direct for every other host", () => {
    const open = rule("*", { ruleSet: "web" });
    const github = rule("api.github.com", { route: "onecli" });
    expect(ask([open, github], "api.github.com", profile)).toMatchObject({
      route: "onecli",
      matchedRuleId: github.id,
    });
    expect(ask([open, github], "example.com", profile)).toMatchObject({
      route: "direct",
      matchedRuleId: open.id,
    });
    const suffix = rule(".github.com", { route: "onecli" });
    expect(ask([open, suffix], "x.github.com", profile).matchedRuleId).toBe(suffix.id);
  });

  it("can also be a deny, which beats every allow", () => {
    const lock = sessionRule("*", { effect: "deny" });
    const allow = rule("example.com");
    expect(ask([lock, allow], "example.com", { sessionId: SESSION }).decision).toBe("deny");
    expect(ask([lock, allow], "example.com").decision).toBe("allow");
  });

  it("prefers a session's any-host rule to a rule set's", () => {
    const set = rule("*", { ruleSet: "web" });
    const own = sessionRule("*");
    expect(ask([set, own], "a.example.com", { ...profile, sessionId: SESSION }).matchedRuleId).toBe(
      own.id,
    );
  });
});

describe("classifyAddress", () => {
  it("separates public, private and always-blocked addresses", () => {
    const expected: Record<string, string> = {
      "8.8.8.8": "public",
      "93.184.216.34": "public",
      "2606:4700::1111": "public",
      "10.1.2.3": "private",
      "172.16.0.1": "private",
      "172.31.255.255": "private",
      "172.32.0.1": "public",
      "192.168.1.1": "private",
      "100.64.0.1": "private",
      "100.127.255.255": "private",
      "fc00::1": "private",
      "fd12:3456::1": "private",
      "127.0.0.1": "blocked",
      "127.255.255.255": "blocked",
      "::1": "blocked",
      "169.254.169.254": "blocked",
      "169.254.0.1": "blocked",
      "fe80::1": "blocked",
      "febf::1": "blocked",
      "fd00:ec2::254": "blocked",
      "0.0.0.0": "blocked",
      "::": "blocked",
      "224.0.0.1": "blocked",
      "255.255.255.255": "blocked",
      "ff02::1": "blocked",
      "::ffff:127.0.0.1": "blocked",
      "::ffff:169.254.169.254": "blocked",
      "::ffff:10.0.0.1": "private",
      "::ffff:8.8.8.8": "public",
      "::FFFF:A00:1": "private",
      "not-an-ip": "invalid",
      "10.0.0": "invalid",
      "10.0.0.256": "invalid",
      "010.0.0.1": "invalid",
      "1::2::3": "invalid",
    };
    for (const [address, kind] of Object.entries(expected)) {
      expect(classifyAddress(address), address).toBe(kind);
    }
  });
});

describe("evaluateEgress with resolved addresses and private rules", () => {
  const priv = (host: string, extra: Partial<EvaluableRule> = {}) =>
    rule(host, { private: true, ports: [8080], ...extra });
  const at = (
    rules: EvaluableRule[],
    host: string,
    addresses: string[],
    extra: Partial<EgressRequest> = {},
  ) => evaluateEgress(SETS, rules, { host, port: 8080, addresses, now: NOW, ...extra });

  it("judges public addresses by the ordinary rules", () => {
    const allow = rule("example.com", { ports: [8080] });
    expect(at([allow], "example.com", ["93.184.216.34", "2606:4700::1111"])).toMatchObject({
      decision: "allow",
      matchedRuleId: allow.id,
    });
    expect(at([], "example.com", ["93.184.216.34"]).decision).toBe("deny");
  });

  it("denies a host that is allowed but resolves to a private address, and says a private rule is needed", () => {
    const allow = rule("svc.example.com", { ports: [8080] });
    const result = at([allow], "svc.example.com", ["10.0.0.5"]);
    expect(result).toMatchObject({ decision: "deny", needsPrivate: true });
    expect(result.reason).toContain("private: true");
    expect(result.reason).toContain("10.0.0.5");
  });

  it("allows a private address through a private exact-host rule", () => {
    const allow = priv("billing.payments.svc.cluster.local");
    expect(at([allow], "billing.payments.svc.cluster.local", ["10.43.1.2"])).toMatchObject({
      decision: "allow",
      route: "direct",
      matchedRuleId: allow.id,
      needsPrivate: true,
    });
    expect(at([allow], "other.payments.svc.cluster.local", ["10.43.1.2"]).decision).toBe("deny");
  });

  it("allows a private address through a cidr that contains it, and only that cidr", () => {
    const allow = priv("10.20.0.0/16");
    expect(at([allow], "db.internal.example", ["10.20.3.4"]).decision).toBe("allow");
    expect(at([allow], "db.internal.example", ["10.21.3.4"]).decision).toBe("deny");
    expect(at([allow], "db.internal.example", ["192.168.0.1"]).decision).toBe("deny");
    const v6 = priv("fd12:3456::/32");
    expect(at([v6], "db.internal.example", ["fd12:3456:1::9"]).decision).toBe("allow");
    expect(at([v6], "db.internal.example", ["fd12:3457::9"]).decision).toBe("deny");
  });

  it("applies a cidr rule's ports and scope like any rule", () => {
    const allow = priv("10.20.0.0/16", { ruleSet: "web" });
    expect(at([allow], "x.example", ["10.20.0.1"]).decision).toBe("deny");
    expect(at([allow], "x.example", ["10.20.0.1"], { profileRuleSets: ["web"] }).decision).toBe(
      "allow",
    );
    expect(
      evaluateEgress(SETS, [allow], {
        host: "x.example",
        port: 443,
        addresses: ["10.20.0.1"],
        profileRuleSets: ["web"],
        now: NOW,
      }).decision,
    ).toBe("deny");
  });

  it("requires every address to be allowed", () => {
    const allow = priv("10.20.0.0/16");
    const pub = rule("mixed.example.com", { ports: [8080] });
    expect(at([allow], "x.example", ["10.20.0.1", "10.30.0.1"]).decision).toBe("deny");
    expect(at([allow], "x.example", ["10.20.0.1", "10.20.0.2"]).decision).toBe("allow");
    expect(at([allow, pub], "mixed.example.com", ["93.184.216.34", "10.20.0.1"]).decision).toBe(
      "allow",
    );
    expect(at([pub], "mixed.example.com", ["93.184.216.34", "10.20.0.1"]).decision).toBe("deny");
  });

  it("never lets a rule open a loopback, link-local or metadata address, or the IPv4-mapped forms", () => {
    const rules = [rule("*", { ports: [8080] }), priv("billing.local"), priv("10.0.0.0/8")];
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fe80::1",
      "fd00:ec2::254",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
    ]) {
      const result = at(rules, "billing.local", [address]);
      expect(result.decision, address).toBe("deny");
      expect(result.reason, address).toContain("always-blocked");
    }
  });

  it("does not let '*' or a public allow reach a private address", () => {
    expect(at([rule("*", { ports: [8080] })], "anything.example", ["10.0.0.1"])).toMatchObject({
      decision: "deny",
      needsPrivate: true,
    });
    expect(at([rule(".example", { ports: [8080] })], "a.example", ["192.168.1.1"]).decision).toBe(
      "deny",
    );
  });

  it("still lets a deny win over a private allow", () => {
    const allow = priv("billing.local");
    const deny = rule("billing.local", { effect: "deny", ports: [8080] });
    expect(at([allow, deny], "billing.local", ["10.0.0.1"])).toMatchObject({
      decision: "deny",
      matchedRuleId: deny.id,
    });
  });

  it("denies an address that is not an IP, and judges names only without addresses", () => {
    expect(at([rule("a.example", { ports: [8080] })], "a.example", ["nope"]).decision).toBe("deny");
    const allow = priv("billing.local");
    expect(
      evaluateEgress(SETS, [allow], { host: "billing.local", port: 8080, now: NOW }),
    ).toMatchObject({ decision: "allow" });
    expect(
      evaluateEgress(SETS, [priv("10.0.0.0/8")], { host: "x.example", port: 8080, now: NOW })
        .decision,
    ).toBe("deny");
  });
});

describe("validateEgressRule", () => {
  const ok = (input: unknown, current?: EgressRuleSpec): EgressRuleSpec => {
    const result = validateEgressRule(input, NOW, current);
    if (typeof result === "string") throw new Error(result);
    return result;
  };
  const bad = (input: unknown, current?: EgressRuleSpec): string => {
    const result = validateEgressRule(input, NOW, current);
    if (typeof result !== "string") throw new Error("expected a refusal");
    return result;
  };

  it("fills defaults and normalises", () => {
    expect(ok({ effect: "allow", host: "Registry.NPMJS.org." })).toEqual({
      effect: "allow",
      host: "registry.npmjs.org",
      ports: [443],
      route: "direct",
      private: false,
      expiresAt: null,
      note: "",
    });
    expect(
      ok({ effect: "allow", host: ".githubusercontent.com", ports: [8443, 443, 443] }).ports,
    ).toEqual([443, 8443]);
  });

  it("accepts exact, suffix and * hosts", () => {
    for (const host of [
      "a.com",
      "a.b.c.example.com",
      ".example.com",
      "*",
      "xn--nxasmq6b.com",
      "localhost",
    ]) {
      expect(ok({ effect: "allow", host }).host, host).toBe(host);
    }
  });

  it("refuses wildcards other than a leading dot or *, IP literals and bad syntax", () => {
    const hosts = [
      "*.example.com",
      "a.*.com",
      "exa*mple.com",
      "**",
      "..example.com",
      "example.com/path",
      "example.com:443",
      "https://example.com",
      "user@example.com",
      "-a.com",
      "a-.com",
      "a_b.com",
      "bücher.de",
      "a..com",
      "",
      ".",
      "10.0.0.1",
      ".10.0.0.1",
      "1.2.3",
      "0x7f.0.0.1",
      "[::1]",
      "::1",
      "a".repeat(64) + ".com",
      "a.".repeat(130) + "com",
    ];
    for (const host of hosts)
      expect(bad({ effect: "allow", host }), JSON.stringify(host)).toBeTruthy();
  });

  it("refuses an allow on a whole top-level domain but permits a deny", () => {
    expect(bad({ effect: "allow", host: ".com" })).toContain("two labels");
    expect(ok({ effect: "deny", host: ".ru" }).host).toBe(".ru");
  });

  it("checks ports", () => {
    for (const ports of [
      [],
      [0],
      [65536],
      [1.5],
      ["443"],
      "443",
      Array.from({ length: 33 }, (_, i) => i + 1),
    ]) {
      expect(bad({ effect: "allow", host: "a.com", ports }), JSON.stringify(ports)).toContain(
        "ports",
      );
    }
    expect(ok({ effect: "allow", host: "a.com", ports: [1, 65535] }).ports).toEqual([1, 65535]);
  });

  it("requires effect and host, and refuses unknown keys (scope fields included) and bad enums", () => {
    expect(bad({ host: "a.com" })).toContain("effect");
    expect(bad({ effect: "allow" })).toContain("host is required");
    expect(bad({ effect: "maybe", host: "a.com" })).toContain("effect");
    expect(bad({ effect: "allow", host: "a.com", route: "proxy" })).toContain("route");
    expect(bad({ effect: "allow", host: "a.com", scope: "global" })).toContain(
      'unknown field "scope"',
    );
    expect(bad({ effect: "allow", host: "a.com", id: "1" })).toContain('unknown field "id"');
    expect(bad([])).toContain("JSON object");
    expect(bad({ effect: "allow", host: "a.com", note: "x".repeat(501) })).toContain("note");
  });

  it("allows route onecli only on an allow of a named host", () => {
    expect(ok({ effect: "allow", host: "a.com", route: "onecli" }).route).toBe("onecli");
    expect(bad({ effect: "deny", host: "a.com", route: "onecli" })).toContain("deny");
    expect(bad({ effect: "allow", host: "*", route: "onecli" })).toContain("route direct");
    expect(ok({ effect: "allow", host: "*" }).route).toBe("direct");
    expect(ok({ effect: "deny", host: "*" }).host).toBe("*");
  });

  it("checks expiresAt", () => {
    expect(
      ok({ effect: "allow", host: "a.com", expiresAt: "2026-12-01T00:00:00Z" }).expiresAt,
    ).toEqual(new Date("2026-12-01T00:00:00Z"));
    expect(bad({ effect: "allow", host: "a.com", expiresAt: "2026-11-01T00:00:00Z" })).toContain(
      "future",
    );
    expect(bad({ effect: "allow", host: "a.com", expiresAt: "tomorrow" })).toContain("ISO");
    expect(bad({ effect: "allow", host: "a.com", expiresAt: 5 })).toContain("ISO");
  });

  it("lays a partial update over the stored rule", () => {
    const current = ok({ effect: "allow", host: "a.com", note: "n", route: "onecli" });
    expect(ok({ note: "m" }, current)).toEqual({ ...current, note: "m" });
    expect(bad({ host: "*" }, current)).toContain("route direct");
    expect(ok({ host: "*", route: "direct" }, current).host).toBe("*");
  });

  it("keeps an expiresAt the stored rule already had, and clears it with null", () => {
    const current = ok({ effect: "allow", host: "a.com", expiresAt: "2026-12-01T00:00:00Z" });
    expect(ok({ note: "x" }, current).expiresAt).toEqual(current.expiresAt);
    expect(ok({ expiresAt: null }, current).expiresAt).toBeNull();
  });
});

describe("validateEgressRule: private rules", () => {
  const priv = (extra: Record<string, unknown> = {}) => ({
    effect: "allow",
    private: true,
    host: "10.20.0.0/16",
    ports: [8080],
    ...extra,
  });
  const result = (input: unknown, current?: EgressRuleSpec) =>
    validateEgressRule(input, NOW, current);

  it("accepts an exact host or a cidr with explicit ports", () => {
    expect(result(priv())).toMatchObject({
      private: true,
      host: "10.20.0.0/16",
      ports: [8080],
      route: "direct",
    });
    expect(result(priv({ host: "Billing.Payments.svc.cluster.local" }))).toMatchObject({
      host: "billing.payments.svc.cluster.local",
    });
    expect(result(priv({ host: "fd12:3456::/32" }))).toMatchObject({ host: "fd12:3456::/32" });
    expect(result(priv({ host: "10.1.2.3/32" }))).toMatchObject({ host: "10.1.2.3/32" });
    expect(result(priv({ host: "192.168.0.0/16", ports: [80, 443] }))).toMatchObject({
      ports: [80, 443],
    });
  });

  it("needs explicit ports, so there is no default", () => {
    const without: Record<string, unknown> = priv();
    delete without.ports;
    expect(result(without)).toContain("explicit ports");
  });

  it("is refused with *, a suffix, route onecli and a deny", () => {
    expect(result(priv({ host: "*" }))).toContain("narrow");
    expect(result(priv({ host: ".svc.cluster.local" }))).toContain("narrow");
    expect(result(priv({ route: "onecli" }))).toContain("route direct");
    expect(result(priv({ effect: "deny" }))).toContain("allow rule only");
    expect(result(priv({ private: "yes" }))).toContain("boolean");
  });

  it("refuses a cidr on a public rule", () => {
    expect(result({ effect: "allow", host: "10.20.0.0/16" })).toContain("needs private: true");
    expect(result({ effect: "allow", host: "10.20.0.0/16", private: false })).toContain(
      "needs private: true",
    );
  });

  it("refuses a cidr that is too wide, malformed or not a network address", () => {
    for (const host of [
      "0.0.0.0/0",
      "10.0.0.0/7",
      "::/0",
      "fc00::/31",
      "10.20.0.0/33",
      "10.20.0.1/16",
      "10.20.0/16",
      "10.20.0.0/",
      "10.20.0.0/016x",
      "fd12::/129",
      "nope/8",
      "10.0.0.0/8/8",
    ]) {
      expect(typeof result(priv({ host })), host).toBe("string");
    }
    expect(result(priv({ host: "10.0.0.0/8" }))).toMatchObject({ host: "10.0.0.0/8" });
    expect(result(priv({ host: "fc00::/32" }))).toMatchObject({ host: "fc00::/32" });
  });

  it("refuses a cidr that overlaps an always-blocked range, on either side", () => {
    const hosts = [
      "127.0.0.0/8",
      "127.0.0.1/32",
      "169.254.0.0/16",
      "169.254.169.254/32",
      "169.0.0.0/8",
      "0.0.0.0/8",
      "128.0.0.0/1",
      "224.0.0.0/4",
      "240.0.0.0/4",
      "::1/128",
      "fe80::/10",
      "fe80::/64",
      "fd00:ec2::254/128",
      "fd00:ec2::/32",
      "fc00::/7",
      "::ffff:0:0/96",
      "ff00::/8",
      "::/128",
      "::/32",
    ];
    for (const host of hosts) expect(typeof result(priv({ host })), host).toBe("string");
    expect(result(priv({ host: "169.254.169.254/32" }))).toContain("always-blocked");
    // Neighbours of the blocked ranges are fine.
    for (const host of ["126.0.0.0/8", "169.253.0.0/16", "172.16.0.0/12", "fec0::/32"]) {
      expect(typeof result(priv({ host })), host).toBe("object");
    }
  });

  it("refuses an exact host of localhost or an IP literal", () => {
    expect(result(priv({ host: "localhost" }))).toContain("localhost");
    expect(result(priv({ host: "api.localhost" }))).toContain("localhost");
    expect(result(priv({ host: "10.0.0.1" }))).toContain("IP");
  });

  it("keeps explicit ports when a private rule is updated without them, but not when a public rule becomes private", () => {
    const current = result(priv()) as EgressRuleSpec;
    expect(result({ note: "x" }, current)).toMatchObject({ ports: [8080], private: true });
    const open = validateEgressRule(
      { effect: "allow", host: "a.example.com" },
      NOW,
    ) as EgressRuleSpec;
    expect(result({ private: true }, open)).toContain("explicit ports");
    expect(result({ private: true, ports: [8080] }, open)).toMatchObject({ private: true });
  });
});

describe("validateRuleSet", () => {
  it("fills defaults, lays a partial update and checks the shape", () => {
    expect(validateRuleSet("web", {})).toEqual({ description: "", appliesToAll: false });
    const current = { description: "d", appliesToAll: true };
    expect(validateRuleSet("web", { description: "e" }, current)).toEqual({
      description: "e",
      appliesToAll: true,
    });
    expect(validateRuleSet("web", { name: "web", appliesToAll: false }, current)).toEqual({
      description: "d",
      appliesToAll: false,
    });
    expect(validateRuleSet("web", { name: "other" })).toContain("immutable");
    expect(validateRuleSet("Web", {})).toContain("name");
    expect(validateRuleSet("web", { appliesToAll: "yes" })).toContain("boolean");
    expect(validateRuleSet("web", { description: "x".repeat(501) })).toContain("description");
    expect(validateRuleSet("web", { rules: [] })).toContain("unknown field");
    expect(validateRuleSet("web", [])).toContain("JSON object");
  });
});
