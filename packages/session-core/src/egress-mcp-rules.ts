import net from "node:net";
import type pg from "pg";
import { validateEgressRule } from "./egress-rules.js";
import type { EgressRuleSpec } from "./egress-rules.js";
import { writeWithin } from "./egress-store.js";
import type { McpServerConfig } from "./mcp-servers.js";
import { readMcpServers } from "./mcp-servers.js";

/**
 * The egress rules derived from the MCP catalog (docs/decisions/0040-mcp-egress-flow.md). The set `mcp-catalog` holds one
 * `allow` rule per host of an enabled server of `inbox.mcp_servers`: `route=onecli` when any server on that host names
 * a OneCLI secret, `direct` otherwise, on the URL's port. It is written only here, in the transaction of the catalog
 * write that changes it, so the catalog and the rules never disagree and one NOTIFY reaches the readers.
 *
 * It is a system set: it applies to no session and no profile may name it, so the egress proxy never judges a sandbox's
 * connection by it. What reads it is the orchestrator's OneCLI host-rule reconciler (the gateway is the gate for the
 * orchestrator's own MCP calls) and `explain`.
 */

export const MCP_RULE_SET = "mcp-catalog";
/** The `createdBy` and `updatedBy` of the rules and of the set, and the actor of their history. */
export const MCP_RULES_AUTHOR = "mcp-catalog";
const NOTE_LIMIT = 500;

/** One derived rule: a host, the ports of the servers on it, the route and the servers that cause it. */
export interface DerivedMcpRule {
  host: string;
  ports: number[];
  route: "direct" | "onecli";
  servers: string[];
}

export interface DerivedMcpRules {
  rules: DerivedMcpRule[];
  /** Enabled servers that cannot have a rule (an IP literal, a host the rule validator refuses), with the reason. */
  skipped: { server: string; reason: string }[];
}

/** The `note` of a derived rule; it names the servers, so an admin reading the set sees why a host is there. */
export function mcpRuleNote(servers: readonly string[]): string {
  const note = `MCP server ${servers.join(", ")}`;
  return note.length <= NOTE_LIMIT ? note : `${note.slice(0, NOTE_LIMIT - 3)}...`;
}

/**
 * Pure. Enabled servers only (a disabled server is unreachable: its host gets no rule). One rule per host, so servers
 * on one host never name two routes (two sets with different routes for a host are a deny, ADR 0034): the route is
 * `onecli` when any of them is credentialed.
 */
export function deriveMcpRules(servers: readonly McpServerConfig[]): DerivedMcpRules {
  const byHost = new Map<string, DerivedMcpRule>();
  const skipped: DerivedMcpRules["skipped"] = [];
  for (const server of [...servers].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!server.enabled) continue;
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      skipped.push({ server: server.name, reason: "the URL does not parse" });
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) {
      // A public rule never names an address (ADR 0034): the proxy decides on the resolved one.
      skipped.push({ server: server.name, reason: "the URL names an IP address, not a host name" });
      continue;
    }
    const port = url.port === "" ? 443 : Number(url.port);
    const route = server.onecliSecret === null ? "direct" : "onecli";
    const checked = validateEgressRule({ effect: "allow", host, ports: [port], route }, new Date());
    if (typeof checked === "string") {
      skipped.push({ server: server.name, reason: checked });
      continue;
    }
    const found = byHost.get(host);
    if (found === undefined) {
      byHost.set(host, { host, ports: [port], route, servers: [server.name] });
      continue;
    }
    if (!found.ports.includes(port)) found.ports = [...found.ports, port].sort((a, b) => a - b);
    if (route === "onecli") found.route = "onecli";
    found.servers.push(server.name);
  }
  return {
    rules: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)),
    skipped,
  };
}

interface ExistingRule {
  id: string | number;
  host: string;
  ports: number[];
  route: string;
  note: string;
}

const snapshot = (rule: EgressRuleSpec) => ({
  ruleSet: MCP_RULE_SET,
  sessionId: null,
  effect: rule.effect,
  host: rule.host,
  ports: rule.ports,
  route: rule.route,
  private: rule.private,
  expiresAt: null,
  note: rule.note,
});

/**
 * Makes the rules of `mcp-catalog` equal to what `servers` derive: creates, changes and removes only what differs, each
 * with a history entry under one new revision and one NOTIFY, and writes nothing when the set already matches. Must run
 * in the transaction of the catalog write (`client` is its connection); a rule an admin added to the set by hand (the API
 * refuses that) or a stale row is replaced all the same. Returns what it derived.
 */
export async function syncMcpRules(
  client: pg.PoolClient,
  servers: readonly McpServerConfig[],
  by: string = MCP_RULES_AUTHOR,
): Promise<DerivedMcpRules> {
  const derived = deriveMcpRules(servers);
  await writeWithin(client, by, undefined, async (db, record) => {
    const { rows: sets } = await db.query<{ name: string }>(
      "select name from egress.rule_sets where name = $1 for update",
      [MCP_RULE_SET],
    );
    if (sets[0] === undefined) {
      // The migration seeds it; a database that lost the row gets it back.
      const revision = await record("rule-set", MCP_RULE_SET, "create", null, {
        description: "Derived from the MCP server catalog.",
        appliesToAll: false,
      });
      await db.query(
        `insert into egress.rule_sets (name, description, system, revision, created_by, updated_by)
         values ($1, $2, true, $3, $4, $4)`,
        [MCP_RULE_SET, "Derived from the MCP server catalog.", revision, MCP_RULES_AUTHOR],
      );
    }
    const { rows: existing } = await db.query<ExistingRule>(
      "select id, host, ports, route, note from egress.rules where rule_set = $1 order by id",
      [MCP_RULE_SET],
    );
    const wanted = new Map(derived.rules.map((rule) => [rule.host, rule]));
    const kept = new Set<string>();
    for (const row of existing) {
      const want = wanted.get(row.host);
      if (want === undefined || kept.has(row.host)) {
        await db.query("delete from egress.rules where id = $1", [String(row.id)]);
        await record("rule", String(row.id), "delete", { host: row.host, route: row.route }, null);
        continue;
      }
      kept.add(row.host);
      const note = mcpRuleNote(want.servers);
      if (
        row.route === want.route &&
        row.note === note &&
        JSON.stringify(row.ports) === JSON.stringify(want.ports)
      ) {
        continue;
      }
      const revision = await record(
        "rule",
        String(row.id),
        "update",
        { host: row.host, ports: row.ports, route: row.route },
        { host: want.host, ports: want.ports, route: want.route },
      );
      await db.query(
        `update egress.rules set effect = $2, host = $3, ports = $4, route = $5, allows_private = $6, expires_at = $7,
           note = $8, revision = $9, updated_at = clock_timestamp(), updated_by = $10 where id = $1`,
        [
          String(row.id),
          "allow",
          want.host,
          want.ports,
          want.route,
          false,
          null,
          note,
          revision,
          by,
        ],
      );
    }
    for (const want of derived.rules) {
      if (kept.has(want.host)) continue;
      const note = mcpRuleNote(want.servers);
      const spec = validateEgressRule(
        { effect: "allow", host: want.host, ports: want.ports, route: want.route, note },
        new Date(),
      );
      if (typeof spec === "string") continue;
      const revision = await record("rule", "", "create", null, snapshot(spec));
      const { rows } = await db.query<{ id: string | number }>(
        `insert into egress.rules
           (rule_set, session_id, effect, host, ports, route, allows_private, expires_at, note, revision, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning id`,
        [
          MCP_RULE_SET,
          null,
          "allow",
          want.host,
          want.ports,
          want.route,
          false,
          null,
          note,
          revision,
          by,
        ],
      );
      await db.query(
        "update egress.rules_history set ref = $1 where revision = $2 and kind = 'rule' and ref = ''",
        [String(rows[0]?.id), revision],
      );
    }
  });
  return derived;
}

/**
 * The hook the catalog writes run in their transaction (`putMcpServer`'s and `deleteMcpServer`'s `within`): reads the
 * whole catalog as the transaction sees it, with the change just made, and derives the rules from it.
 */
export async function syncMcpRulesFromCatalog(client: pg.PoolClient, by: string): Promise<void> {
  const catalog = await readMcpServers(client);
  await syncMcpRules(
    client,
    catalog.servers.map((stored) => stored.server),
    by === "" ? MCP_RULES_AUTHOR : by,
  );
}
