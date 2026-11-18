import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateEgressRule } from "../src/egress-rules.ts";

const SQL = readFile(new URL("../migrations/024_egress.sql", import.meta.url), "utf8");

/** Architectural invariants of docs/decisions/0034-egress-rules.md, checked on the migration text. */
describe("migration 024_egress.sql", () => {
  it("keeps every table in the egress schema, and creates no principals or bindings yet (slices 4 and 5)", async () => {
    const sql = (await SQL).replace(/--.*$/gm, "");
    const tables = [...sql.matchAll(/create table if not exists ([\w.]+)/g)].map((m) => m[1]);
    expect(tables.sort()).toEqual([
      "egress.revisions",
      "egress.rule_sets",
      "egress.rules",
      "egress.rules_history",
    ]);
    expect(sql).not.toMatch(/principals|bindings/);
    expect(sql).not.toMatch(/\binbox\./);
  });

  it("is idempotent: no bare create or drop, seeds only without a revision", async () => {
    const sql = (await SQL).replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/create table (?!if not exists)/);
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).toMatch(/if exists \(select 1 from egress\.revisions\)/);
  });

  it("seeds the starter rule sets with valid rules, none applying to all", async () => {
    const sql = await SQL;
    const sets = [...sql.matchAll(/^\s+\('([a-z-]+)', '[^']*', rev,/gm)].map((m) => m[1]);
    expect(sets).toEqual(["npm", "pypi", "debian", "github-public", "go", "rust", "open-web"]);
    expect(sql).not.toMatch(/applies_to_all\s*(,|\))[^;]*true/);
    const rules = [...sql.matchAll(/^\s+\('([a-z-]+)', '([^']+)', '\{([\d,]+)\}'/gm)].map((m) => ({
      set: m[1],
      host: m[2] ?? "",
      ports: (m[3] ?? "").split(",").map(Number),
    }));
    expect(rules.map((r) => r.host)).toEqual([
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "deb.debian.org",
      "security.debian.org",
      "github.com",
      "codeload.github.com",
      ".githubusercontent.com",
      "proxy.golang.org",
      "sum.golang.org",
      "crates.io",
      "index.crates.io",
      "static.crates.io",
      "*",
    ]);
    for (const rule of rules) {
      const checked = validateEgressRule(
        { effect: "allow", host: rule.host, ports: rule.ports },
        new Date(),
      );
      expect(typeof checked, rule.host).toBe("object");
    }
    expect(rules.filter((r) => r.set === "debian").every((r) => r.ports.join() === "80,443")).toBe(
      true,
    );
    expect(rules.filter((r) => r.set !== "debian").every((r) => r.ports.join() === "443")).toBe(
      true,
    );
  });
});

const SQL_025 = readFile(new URL("../migrations/025_egress_proxy.sql", import.meta.url), "utf8");

/** The proxy's database access (ADR 0035): read the rules, write only its own status. */
describe("migration 025_egress_proxy.sql", () => {
  it("gives the proxy role no write access to rules, sets, revisions or history", async () => {
    const sql = (await SQL_025).replace(/--.*$/gm, "");
    const grants = [...sql.matchAll(/grant ([^']+?) (?:on|to)/gi)].map((m) => m[0]);
    const writes = [
      ...sql.matchAll(
        /grant\s+(?:[^']*?\b(?:insert|update|delete|all|truncate)\b[^']*?)\s+on\s+([\w., ]+?)\s+to/gi,
      ),
    ];
    expect(grants.length).toBeGreaterThan(0);
    expect(writes.map((m) => m[1])).toEqual(["egress.proxy_status"]);
    expect(sql).not.toMatch(/\binbox\./);
    expect(sql).not.toMatch(/create role|alter role/i);
  });

  it("is idempotent and keeps its table in the egress schema", async () => {
    const sql = (await SQL_025).replace(/--.*$/gm, "");
    expect([...sql.matchAll(/create table if not exists ([\w.]+)/g)].map((m) => m[1])).toEqual([
      "egress.proxy_status",
    ]);
    expect(sql).not.toMatch(/create table (?!if not exists)/);
    expect(sql).not.toMatch(/\bdrop\b/);
    expect(sql).toMatch(/create or replace function egress\.grant_proxy_reader/);
  });
});
