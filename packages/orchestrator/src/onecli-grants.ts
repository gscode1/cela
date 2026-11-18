import type { OneCliAdmin, OneCliGrant } from "./onecli-admin.js";

/** The grant check proved the agent holds more than it should (as opposed to failing to check). */
export class AgentNotNarrowError extends Error {}

/**
 * OneCLI grants every new agent the LLM keys (seen live), so after creating an agent every grant except the secrets it
 * should have is removed, then the grant list is read back and must be exactly those. An answer that cannot be read counts
 * as a failure: the agent is not used unless it is proven narrow. Shared by the repo sessions' agents (their GitHub secrets)
 * and the per-session MCP agents (the credentialed servers of the profile, docs/decisions/0040-mcp-egress-flow.md).
 */
export async function narrowAgent(
  onecli: OneCliAdmin,
  agentId: string,
  secretIds: readonly string[],
  what: string,
): Promise<void> {
  const mine = new Set(secretIds);
  const have = await onecli.listGrants(agentId);
  for (const id of mine) {
    if (!have.some((g) => g.kind === "secret" && g.id === id))
      await onecli.grantSecret(agentId, id);
  }
  for (const grant of have) {
    if (grant.kind === "secret" && mine.has(grant.id)) continue;
    await onecli.revokeGrant(agentId, grant);
  }
  const left: OneCliGrant[] = await onecli.listGrants(agentId);
  const ok = left.length === mine.size && left.every((g) => g.kind === "secret" && mine.has(g.id));
  if (!ok) {
    throw new AgentNotNarrowError(
      `OneCLI agent still holds ${String(left.length)} grants after narrowing; expected only ${what}`,
    );
  }
}
