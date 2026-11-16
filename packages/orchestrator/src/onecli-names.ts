/**
 * Names of the OneCLI objects of one orchestrator. Every orchestrator that shares a OneCLI workspace (the long-lived
 * stack and each e2e run, docs/e2e.md) has its own prefix, so the orphan sweep of one never judges, and so never
 * revokes, the agents of another (docs/decisions/0013-e2e-namespace-per-run.md).
 */

/** What production uses; the names of existing agents and secrets do not change. */
export const DEFAULT_ONECLI_NAME_PREFIX = "pi-session-";

const PREFIX = /^[a-z0-9-]{1,40}$/;
const UUID_SHAPE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A short lowercase `[a-z0-9-]+` that ends in `-`, so `<prefix><uuid>` stays readable and unambiguous. */
export function validateNamePrefix(prefix: string): string {
  if (!PREFIX.test(prefix) || !prefix.endsWith("-") || prefix === "-")
    throw new Error(
      "PI_ONECLI_NAME_PREFIX must be 2 to 40 characters of a-z, 0-9 and -, ending in - (for example pi-session-)",
    );
  return prefix;
}

export const agentIdentifier = (
  sessionId: string,
  prefix: string = DEFAULT_ONECLI_NAME_PREFIX,
): string => `${prefix}${sessionId}`;

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
    agent: new RegExp(`^${p}(${UUID_SHAPE})$`),
    secret: new RegExp(`^${p}(${UUID_SHAPE})-(git|api)$`),
  };
}
