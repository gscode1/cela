import type pg from "pg";
import type { EgressData } from "./egress-store.js";
import type { StoredMcpServer } from "./mcp-servers.js";
import type { ProfileDefinition } from "./profiles.js";

/**
 * How a session's sandbox reaches the network (docs/decisions/0038-network-modes.md). `proxied`: the egress proxy only,
 * under the rules and the audit. `direct`: the open internet (private, cluster, metadata and platform addresses stay
 * blocked), no rules, no audit, behind the chart gate `security.allowDirectSandboxEgress`.
 */
export const NETWORK_MODES = ["proxied", "direct"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];
export const DEFAULT_NETWORK_MODE: NetworkMode = "proxied";

/** The label the SandboxTemplate bakes into its Pods and the NetworkPolicies select on. */
export const NETWORK_MODE_LABEL = "cela.dev/network-mode";

export const isNetworkMode = (value: unknown): value is NetworkMode =>
  typeof value === "string" && (NETWORK_MODES as readonly string[]).includes(value);

/** The mode a profile definition asks for; absent is `proxied`. */
export const networkModeOf = (definition: ProfileDefinition): NetworkMode =>
  definition.networkMode ?? DEFAULT_NETWORK_MODE;

export const DIRECT_NOT_ALLOWED =
  "networkMode direct is not allowed: this deployment has not set security.allowDirectSandboxEgress";

/**
 * Why a direct session cannot have this profile, or undefined. A direct sandbox has no proxy, so nothing could inject a
 * credential for it: refusing the combination is better than a profile that looks credentialed and is not. Checks the
 * credentialed MCP servers the profile names and the `onecli` allow rules of the rule sets that apply to it (the ones
 * that apply to all, and the ones it names). A repo is checked by the caller (it is not part of the profile).
 */
export function directModeConflict(
  definition: ProfileDefinition,
  state: { mcpServers: readonly StoredMcpServer[]; egress: EgressData },
): string | undefined {
  const source = credentialSource(definition, state);
  return source === undefined ? undefined : `networkMode direct cannot be combined with ${source}`;
}

/**
 * What in a profile would need a credential injected by the platform (a credentialed MCP server, a `route=onecli`
 * allow rule of an applying rule set), described for an error message, or undefined. Shared by the direct network mode
 * and the browser flavour (ADR 0041): neither can carry one. `exceptServer` is the browser flavour's one exception, the
 * session mail server (ADR 0068); the direct mode never passes it. A `route=onecli` rule is never excepted.
 */
export function credentialSource(
  definition: ProfileDefinition,
  state: { mcpServers: readonly StoredMcpServer[]; egress: EgressData },
  exceptServer?: string,
): string | undefined {
  const credentialed = (definition.mcpServers ?? []).find(
    (name) =>
      name !== exceptServer &&
      state.mcpServers.some((s) => s.server.name === name && s.server.onecliSecret !== null),
  );
  if (credentialed !== undefined) return `the credentialed MCP server "${credentialed}"`;
  const applying = new Set([
    ...state.egress.ruleSets.filter((s) => s.appliesToAll).map((s) => s.name),
    ...(definition.egressRuleSets ?? []),
  ]);
  const route = state.egress.rules.find(
    (r) =>
      r.ruleSet !== null && applying.has(r.ruleSet) && r.effect === "allow" && r.route === "onecli",
  );
  if (route !== undefined) {
    return `the route onecli rule for "${route.host}" in rule set "${String(route.ruleSet)}"`;
  }
  return undefined;
}

/**
 * Live sessions whose sandbox has the open internet (`direct`): the number an operator watches while the gate is on
 * (`GET /admin/status`). Sessions that are deleting or deleted no longer hold one.
 */
export async function countDirectSessions(pool: Pick<pg.Pool, "query">): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    "select count(*) as n from inbox.sessions where network_mode = 'direct' and status = 'active'",
  );
  return Number(rows[0]?.n ?? 0);
}
