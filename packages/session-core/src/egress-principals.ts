import { createHash, createHmac, randomBytes } from "node:crypto";
import type pg from "pg";

/**
 * Egress principals (docs/decisions/0036-egress-principals.md): the proxy's view of one session. The orchestrator is the
 * only writer; the proxy reads the table (without the salt) over its own role. A principal holds the sha256 of the egress
 * token, never the token. A write notifies the proxy through the table's trigger (migration 026), so a revocation does not
 * wait for the proxy's poll.
 */

type Db = Pick<pg.Pool, "query">;

/** The token's size before encoding: an HMAC-SHA256 output. */
export const EGRESS_TOKEN_BYTES = 32;

/**
 * The egress token of one session: base64url(HMAC-SHA256(master, "egress:<session id>:<salt>")). `salt` is random per
 * principal (stored beside the hash), so a new salt rotates the token, and the same row gives the same token after an
 * orchestrator restart without the token being stored. Unpredictable without the master key, which never leaves the
 * orchestrator.
 */
export function deriveEgressToken(master: string, sessionId: string, salt: string): string {
  if (master === "") throw new Error("sandbox master key is empty");
  return createHmac("sha256", master)
    .update(`egress:${sessionId}:${salt}`)
    .digest()
    .toString("base64url");
}

/** What the proxy stores and compares: lowercase hex of sha256 over the token's UTF-8 bytes. */
export function hashEgressToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newEgressSalt(): string {
  return randomBytes(EGRESS_TOKEN_BYTES).toString("hex");
}

export interface PrincipalSpec {
  sessionId: string;
  profile: { name: string; version: number } | null;
  /** The profile's `egressRuleSets` as resolved when the session was created. */
  ruleSets: readonly string[];
}

/**
 * The principal of a session, created if it has none. Returns the token for the live row, or undefined when the row is
 * revoked (a deleted session is never reopened, so a revoked row stays revoked). Reads first: an existing row is not
 * written, so reopening an env does not notify the proxy.
 */
export async function ensurePrincipal(
  db: Db,
  spec: PrincipalSpec,
  master: string,
): Promise<{ token: string } | undefined> {
  const read = async () => {
    const { rows } = await db.query<{ token_salt: string; revoked_at: Date | null }>(
      "select token_salt, revoked_at from egress.principals where session_id = $1",
      [spec.sessionId],
    );
    return rows[0];
  };
  let row = await read();
  if (row === undefined) {
    const salt = newEgressSalt();
    await db.query(
      `insert into egress.principals (session_id, token_hash, token_salt, profile_name, profile_version, rule_sets)
       values ($1, $2, $3, $4, $5, $6) on conflict (session_id) do nothing`,
      [
        spec.sessionId,
        hashEgressToken(deriveEgressToken(master, spec.sessionId, salt)),
        salt,
        spec.profile?.name ?? null,
        spec.profile?.version ?? null,
        [...spec.ruleSets],
      ],
    );
    row = await read();
  }
  if (row === undefined || row.revoked_at !== null) return undefined;
  return { token: deriveEgressToken(master, spec.sessionId, row.token_salt) };
}

/** Records (or clears, with null) the sandbox Pod's address; a no-op for an unknown or revoked principal. */
export async function setPrincipalPodIp(
  db: Db,
  sessionId: string,
  podIp: string | null,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `update egress.principals set pod_ip = $2, updated_at = clock_timestamp()
      where session_id = $1 and revoked_at is null and pod_ip is distinct from $2::inet`,
    [sessionId, podIp],
  );
  return (rowCount ?? 0) > 0;
}

/** Revokes a session's principal; its token is refused by the proxy from then on. Idempotent. */
export async function revokePrincipal(db: Db, sessionId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update egress.principals set revoked_at = clock_timestamp(), pod_ip = null, updated_at = clock_timestamp()
      where session_id = $1 and revoked_at is null`,
    [sessionId],
  );
  return (rowCount ?? 0) > 0;
}

/** Session ids whose principal is not revoked (the sweep revokes those whose session is gone). */
export async function livePrincipalSessions(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ session_id: string }>(
    "select session_id from egress.principals where revoked_at is null order by session_id",
  );
  return rows.map((row) => row.session_id);
}

export interface PrincipalCounts {
  active: number;
  /** Active, and the sandbox Pod's address is known: its token works. */
  withPodIp: number;
  revoked: number;
}

export async function principalCounts(db: Db): Promise<PrincipalCounts> {
  const { rows } = await db.query<{ active: string; with_pod_ip: string; revoked: string }>(
    `select count(*) filter (where revoked_at is null) as active,
            count(*) filter (where revoked_at is null and pod_ip is not null) as with_pod_ip,
            count(*) filter (where revoked_at is not null) as revoked
       from egress.principals`,
  );
  const row = rows[0];
  return {
    active: Number(row?.active ?? 0),
    withPodIp: Number(row?.with_pod_ip ?? 0),
    revoked: Number(row?.revoked ?? 0),
  };
}

/** The rule sets the session's principal stored at creation, for `explain` when no profile is named. */
export async function principalRuleSets(
  db: Db,
  sessionId: string,
): Promise<{ profile: string | null; ruleSets: string[]; revoked: boolean } | undefined> {
  const { rows } = await db.query<{
    profile_name: string | null;
    rule_sets: string[];
    revoked_at: Date | null;
  }>("select profile_name, rule_sets, revoked_at from egress.principals where session_id = $1", [
    sessionId,
  ]);
  const row = rows[0];
  return row === undefined
    ? undefined
    : { profile: row.profile_name, ruleSets: row.rule_sets, revoked: row.revoked_at !== null };
}
