/**
 * Names of the OneCLI objects of one orchestrator. Every orchestrator that shares a OneCLI workspace (the long-lived
 * stack and each e2e run, docs/e2e.md) has its own prefix, so the orphan sweep of one never judges, and so never
 * revokes, the agents of another (docs/decisions/0013-e2e-namespace-per-run.md).
 */

import { isOnecliSecretRef } from "@cela/session-core";

/** What production uses; the names of existing agents and secrets do not change. */
export const DEFAULT_ONECLI_NAME_PREFIX = "pi-session-";

/** OneCLI refuses an agent identifier longer than this (seen live: HTTP 400 at 51). */
export const ONECLI_IDENTIFIER_MAX = 50;
/** A session id is a UUID: 36 characters. */
const SESSION_ID_LENGTH = 36;
/** The MCP agent is `<prefix><session id>-m` (see `mcpAgentIdentifier`), the longest identifier built from the prefix. */
const MCP_AGENT_SUFFIX = "-m";
/**
 * The longest prefix that keeps every identifier within OneCLI's limit: 12 today. Checked at startup, so a too-long
 * prefix fails there and not on the first repo or MCP session with a 400 that looks like a OneCLI fault.
 */
export const ONECLI_NAME_PREFIX_MAX =
  ONECLI_IDENTIFIER_MAX - SESSION_ID_LENGTH - MCP_AGENT_SUFFIX.length;

const PREFIX = new RegExp(`^[a-z0-9-]{1,${String(ONECLI_NAME_PREFIX_MAX)}}$`);
const UUID_SHAPE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A short lowercase `[a-z0-9-]+` that ends in `-`, so `<prefix><uuid>` stays readable and unambiguous. */
export function validateNamePrefix(prefix: string): string {
  if (!PREFIX.test(prefix) || !prefix.endsWith("-") || prefix === "-")
    throw new Error(
      `PI_ONECLI_NAME_PREFIX must be 2 to ${String(ONECLI_NAME_PREFIX_MAX)} characters of a-z, 0-9 and -, ending in - (for example pi-session-): OneCLI refuses agent names over ${String(ONECLI_IDENTIFIER_MAX)} characters`,
    );
  return prefix;
}

export const agentIdentifier = (
  sessionId: string,
  prefix: string = DEFAULT_ONECLI_NAME_PREFIX,
): string => `${prefix}${sessionId}`;

/**
 * The agent that carries a session's credentialed MCP calls (docs/decisions/0040-mcp-egress-flow.md); swept with the session.
 * OneCLI limits an identifier to 50 characters, and `pi-session-<uuid>` is 47: the suffix is two characters on purpose.
 */
export const mcpAgentIdentifier = (
  sessionId: string,
  prefix: string = DEFAULT_ONECLI_NAME_PREFIX,
): string => `${agentIdentifier(sessionId, prefix)}${MCP_AGENT_SUFFIX}`;

/** The agent that lists the tools of one credentialed MCP server (no session: the catalog's own, `tools/list` only): `<prefix>d-<server>`. */
export const mcpDiscoveryPrefix = (prefix: string = DEFAULT_ONECLI_NAME_PREFIX): string =>
  `${prefix}d-`;

export const secretName = (
  sessionId: string,
  suffix: string,
  prefix: string = DEFAULT_ONECLI_NAME_PREFIX,
): string => `${agentIdentifier(sessionId, prefix)}-${suffix}`;

/**
 * The patterns the sweep judges by. Both are anchored at the start, so a name made with another prefix never
 * matches: `pi-session-` does not match `pi-e2e-ab12cd-session-<uuid>`, and the UUID is exactly 36 characters, so it
 * does not match a longer prefix that merely starts with this one.
 */
export function namePatterns(prefix: string): { agent: RegExp; secret: RegExp } {
  // The prefix is validated to [a-z0-9-], none of which is a regex metacharacter outside a class.
  const p = validateNamePrefix(prefix);
  return {
    agent: new RegExp(`^${p}(${UUID_SHAPE})(?:-m)?$`),
    secret: new RegExp(`^${p}(${UUID_SHAPE})-(git|api)$`),
  };
}

/**
 * A per-session secret of any orchestrator (`<prefix><uuid>-git|api`, `secretName`), whatever its prefix: every prefix
 * ends in `-`, so the name ends in `-<uuid>-git` or `-<uuid>-api`.
 */
const SESSION_SECRET = new RegExp(`-${UUID_SHAPE}-(git|api)$`);

/**
 * The names an MCP server could name as its `onecliSecret`, for the admin console (ADR 0040 amendment): sorted, without
 * duplicates, without the secrets orchestrators create for sessions (of this orchestrator or another sharing the OneCLI
 * workspace) and without names the API would refuse. Names only: no value or id ever leaves here.
 */
export function mcpSecretCandidates(secrets: readonly { name: string }[]): string[] {
  const names = new Set<string>();
  for (const { name } of secrets) {
    if (isOnecliSecretRef(name) && !SESSION_SECRET.test(name)) names.add(name);
  }
  return [...names].sort();
}
