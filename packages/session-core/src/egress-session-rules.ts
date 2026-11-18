import type pg from "pg";
import { createEgressRule, deleteEgressRule, readEgress } from "./egress-store.js";

/**
 * Session rules that route a session's credentialed hosts through OneCLI (docs/decisions/0037-egress-onecli-route.md).
 * A session rule of an exact host beats the same host in a rule set (ADR 0034 precedence), which is how `github.com`
 * leaves the `github-public` set's direct route for the one session that has a OneCLI agent. The orchestrator owns
 * them: created when the session's OneCLI agent is, removed with the session (and by the orphan sweep).
 */

export const SESSION_RULES_AUTHOR = "orchestrator";

/**
 * Makes sure the session has an allow rule with route `onecli` on port 443 for each host. Returns the revision of the
 * last rule it created (the proxy serves it once it reports at least that revision), or undefined when nothing was
 * missing. A rule an admin edited to something else counts as missing only if no onecli allow for that host exists.
 */
export async function ensureSessionOneCliRules(
  pool: pg.Pool,
  sessionId: string,
  hosts: readonly string[],
): Promise<number | undefined> {
  const data = await readEgress(pool);
  const have = new Set(
    data.rules
      .filter(
        (r) =>
          r.sessionId === sessionId &&
          r.effect === "allow" &&
          r.route === "onecli" &&
          r.ports.includes(443),
      )
      .map((r) => r.host),
  );
  let revision: number | undefined;
  for (const host of hosts) {
    if (have.has(host)) continue;
    const made = await createEgressRule(
      pool,
      { sessionId },
      {
        effect: "allow",
        host,
        ports: [443],
        route: "onecli",
        note: "OneCLI injects this session's repository credential (repo session)",
      },
      SESSION_RULES_AUTHOR,
    );
    if (typeof made === "string") throw new Error(`session rule for ${host} refused: ${made}`);
    if (made !== undefined) revision = made.revision;
  }
  return revision;
}

/** Deletes every rule of the session (the history keeps them). Returns how many there were. Idempotent. */
export async function removeSessionRules(pool: pg.Pool, sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ id: string | number }>(
    "select id from egress.rules where session_id = $1",
    [sessionId],
  );
  let removed = 0;
  for (const row of rows) {
    if (await deleteEgressRule(pool, String(row.id), SESSION_RULES_AUTHOR)) removed += 1;
  }
  return removed;
}

/** Session ids that own at least one rule (the sweep clears those whose session is gone). */
export async function sessionsWithRules(pool: Pick<pg.Pool, "query">): Promise<string[]> {
  const { rows } = await pool.query<{ session_id: string }>(
    "select distinct session_id from egress.rules where session_id is not null order by session_id",
  );
  return rows.map((row) => row.session_id);
}
