import type pg from "pg";
import { AdminConflictError } from "./revision.js";

/**
 * Deleting session profiles, skills and MCP servers (docs/decisions/0027-admin-delete.md). A delete removes the rows
 * only while nothing live refers to them, and the name is never used again.
 */

type Db = Pick<pg.PoolClient, "query">;

/**
 * One advisory lock for every write that changes what refers to what: profile, skill and MCP server writes and deletes
 * take it exclusively, before any other lock they take; session creation takes it shared, so creations never wait for
 * each other. A delete then sees every reference that was committed, and nothing new can refer to what it removes.
 */
export const CATALOG_LOCK = "catalog";

export async function lockCatalog(client: Db, mode: "exclusive" | "shared"): Promise<void> {
  await client.query(
    mode === "shared"
      ? "select pg_advisory_xact_lock_shared(hashtext($1))"
      : "select pg_advisory_xact_lock(hashtext($1))",
    [CATALOG_LOCK],
  );
}

export type DeletedKind = "profile" | "skill" | "mcp-server";

const LABEL: Record<DeletedKind, string> = {
  profile: "profile",
  skill: "skill",
  "mcp-server": "MCP server",
};

/** What keeps a delete from happening; the 409 carries it as `blockedBy`. */
export interface BlockedBy {
  /** Profiles whose current version refers to it. */
  profiles?: { name: string; version: number }[];
  /** Sessions that are not deleted and pin it: how many, and up to five of their ids. */
  sessions?: { count: number; sample: string[] };
  /** It is the default profile for new sessions. */
  defaultProfile?: true;
  /** The profile is still open to new sessions. */
  enabledForNew?: true;
}

/** A delete the stored state refuses: a 409 that names what blocks it. */
export class AdminBlockedError extends AdminConflictError {
  readonly blockedBy: BlockedBy;
  constructor(message: string, blockedBy: BlockedBy) {
    super(message);
    this.blockedBy = blockedBy;
  }
}

/** Throws `AdminConflictError` when `name` of `kind` was deleted: a deleted name is never created again. */
export async function refuseDeletedName(
  client: Db,
  kind: DeletedKind,
  name: string,
): Promise<void> {
  const { rows } = await client.query(
    "select 1 from inbox.deleted_names where kind = $1 and name = $2",
    [kind, name],
  );
  if (rows.length > 0) {
    throw new AdminConflictError(
      `${LABEL[kind]} name "${name}" was deleted and cannot be used again: choose another name`,
    );
  }
}

/** The names among `names` that were deleted (none for an empty list). */
export async function deletedAmong(
  client: Db,
  kind: DeletedKind,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const { rows } = await client.query<{ name: string }>(
    "select name from inbox.deleted_names where kind = $1 and name = any($2::text[]) order by name",
    [kind, [...names]],
  );
  return rows.map((row) => row.name);
}

/**
 * Lets this transaction delete version rows (the immutability triggers allow it under this setting only) and records
 * the deleted name. Call it after the reference checks, right before the deletes.
 */
export async function recordDeletion(
  client: Db,
  kind: DeletedKind,
  name: string,
  by: string,
  lastVersion: number | null,
): Promise<void> {
  await client.query("set local pi.allow_delete = 'on'");
  await client.query(
    "insert into inbox.deleted_names (kind, name, last_version, deleted_by) values ($1, $2, $3, $4)",
    [kind, name, lastVersion, by],
  );
}

/** Profiles whose current version pins the skill or names the MCP server, by name. */
export async function profilesReferring(
  client: Db,
  kind: "skill" | "mcp-server",
  name: string,
): Promise<{ name: string; version: number }[]> {
  const { rows } = await client.query<{ name: string; version: number }>(
    `select p.name, p.current_version as version from inbox.profiles p
       join inbox.profile_versions v on v.name = p.name and v.version = p.current_version
      where ${
        kind === "skill"
          ? "v.definition->'skills' @> jsonb_build_array(jsonb_build_object('name', $1::text))"
          : "v.definition->'mcpServers' ? $1"
      }
      order by p.name`,
    [name],
  );
  return rows.map((row) => ({ name: row.name, version: row.version }));
}

/** Sessions that are not deleted and whose profile snapshot pins the skill: they read its files at every attach. */
export async function sessionsPinningSkill(
  client: Db,
  name: string,
): Promise<{ count: number; sample: string[] }> {
  const { rows } = await client.query<{ id: string; total: string | number }>(
    `select id, count(*) over () as total from inbox.sessions
      where status <> 'deleted'
        and profile_snapshot->'skills' @> jsonb_build_array(jsonb_build_object('name', $1::text))
      order by created_at limit 5`,
    [name],
  );
  return {
    count: rows[0] === undefined ? 0 : Number(rows[0].total),
    sample: rows.map((row) => row.id),
  };
}

/** A sentence for the 409 from what blocks a delete. */
export function blockedMessage(kind: DeletedKind, name: string, blockedBy: BlockedBy): string {
  const reasons: string[] = [];
  if (blockedBy.defaultProfile === true) reasons.push("it is the default profile for new sessions");
  if (blockedBy.enabledForNew === true)
    reasons.push("it is open to new sessions (disable it first)");
  if (blockedBy.profiles !== undefined && blockedBy.profiles.length > 0) {
    reasons.push(`profiles use it: ${blockedBy.profiles.map((p) => p.name).join(", ")}`);
  }
  if (blockedBy.sessions !== undefined && blockedBy.sessions.count > 0) {
    reasons.push(`${String(blockedBy.sessions.count)} session(s) that are not deleted pin it`);
  }
  return `${LABEL[kind]} "${name}" cannot be deleted: ${reasons.join("; ")}`;
}
