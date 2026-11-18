/** What a run that ended without an answer means for the session (Pi Durable `RunFailure`, plus the text of the error). */
export interface RunOutcome {
  reason: string;
  detail?: string;
}

/** The stored failure of a session that used its token budget (checked before each input, ADR 0028). */
export const TOKEN_BUDGET_EXHAUSTED =
  "token budget exhausted: the session used all the model tokens it is allowed";

/**
 * Model-side signs that the credentials are not accepted: an HTTP status of 401 or 403 from the provider (a missing
 * or revoked key, a revoked OneCLI grant leaves the gateway injecting nothing), 407 from the gateway itself (the
 * agent token was deleted or regenerated), the gateway's own answer when the agent has no grant for the host (a 401
 * whose JSON body, which is all pi-ai keeps, reads `access_restricted` / `this agent does not have access`), or the
 * usual wording. Status codes must stand alone, so a request id or a
 * byte count that happens to contain 401 does not match.
 */
const REJECTED =
  /(?<![a-z0-9])(?:401|403|407)(?![a-z0-9])|unauthori[sz]ed|forbidden|invalid[ _-]?api[ _-]?key|incorrect api key|proxy authentication|authentication[ _-]?(?:error|failed)|permission[ _-]?denied|access_restricted|does not have access/i;

/**
 * The terminal failure a run outcome maps to, or undefined when the session stays usable.
 *  - A model error that reads as rejected credentials is terminal: nothing in the orchestrator can fix a grant, and
 *    retrying only repeats paid or rate-limited calls. (pi-ai does not retry these statuses either.)
 *  - `turn_limit` is the per-session turn budget (`maxTurns`).
 *  - Everything else (a 429 that outlasted the retries, a network error, an abort) leaves the session active: the
 *    next message starts a new run.
 */
export function terminalFailure(outcome: RunOutcome): string | undefined {
  if (outcome.reason === "turn_limit") {
    return "turn budget exhausted: the session used all the model turns it is allowed";
  }
  if (outcome.reason === "model_error" && REJECTED.test(outcome.detail ?? "")) {
    return "model credentials were rejected (401/403): the OneCLI agent token or its grant for this provider is missing or revoked";
  }
  return undefined;
}
