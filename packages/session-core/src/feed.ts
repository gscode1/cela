import type pg from "pg";

/**
 * The owner-scoped event feed (ADR 0058). Rows are written by triggers (migration 036); this module reads and prunes
 * them. A position is the pair (xid, id): the writing transaction's id and the row id. Readers only see rows whose
 * transaction is below the oldest one still open, so every row that will ever sort before a returned one is already
 * visible, and a cursor never skips a row that commits late.
 */

export type FeedType = "session.created" | "session.status" | "input.settled";

export interface FeedEvent {
  /** The row id, stable: the MCP Events `eventId`. */
  id: string;
  type: FeedType;
  sessionId: string;
  timestamp: string;
  data: Record<string, unknown>;
  /** The position of this row: resuming from it continues after it. */
  cursor: string;
}

export interface FeedPage {
  events: FeedEvent[];
  /** Where the next read continues; returned even when no event was. */
  cursor: string;
  hasMore: boolean;
  /** The cursor was older than the retained rows: rows were deleted that the caller never read. */
  truncated: boolean;
}

interface Position {
  xid: string;
  id: string;
}

const START: Position = { xid: "0", id: "0" };
const MAX_BIGINT = "9223372036854775807";
export const FEED_LIMIT_DEFAULT = 100;
export const FEED_LIMIT_MAX = 500;

/** `<xid>-<id>`, both decimal. Opaque to clients. */
export function formatCursor(position: Position): string {
  return `${position.xid}-${position.id}`;
}

/** The position of a cursor, `latest`, or undefined for anything else (a 400). */
export function parseCursor(raw: string): Position | "latest" | undefined {
  if (raw === "latest") return "latest";
  const match = /^([0-9]{1,20})-([0-9]{1,19})$/.exec(raw);
  if (match === null) return undefined;
  const [, xid, id] = match;
  if (xid === undefined || id === undefined) return undefined;
  // xid8 and bigint bounds; past them Postgres would answer an error, not an empty page.
  if (BigInt(xid) > 18446744073709551615n || BigInt(id) > BigInt(MAX_BIGINT)) return undefined;
  return { xid, id };
}

interface FeedRow {
  id: string;
  xid: string;
  session_id: string;
  type: FeedType;
  data: Record<string, unknown>;
  created_at: Date;
}

/**
 * One page of the caller's feed after `cursor` (undefined: from the oldest retained row; `latest`: no rows, only the
 * head). A cursor below the retention horizon continues from the horizon with `truncated: true`.
 */
export async function readFeed(
  db: Pick<pg.Pool, "query">,
  ownerSubject: string,
  cursor: Position | "latest" | undefined,
  limit: number = FEED_LIMIT_DEFAULT,
): Promise<FeedPage> {
  if (cursor === "latest") {
    // Every row at or above the oldest open transaction is still to come, so the head sits just below it.
    const { rows } = await db.query<{ xid: string }>(
      "select (pg_snapshot_xmin(pg_current_snapshot())::text::numeric - 1)::text as xid",
    );
    const xid = rows[0]?.xid ?? "0";
    return {
      events: [],
      cursor: formatCursor({ xid, id: MAX_BIGINT }),
      hasMore: false,
      truncated: false,
    };
  }
  const horizon = await readHorizon(db);
  let from = cursor ?? START;
  let truncated = false;
  if (horizon !== undefined && comparePositions(from, horizon) < 0) {
    // A caller that never had a cursor asked for "what is retained": that is not a gap.
    truncated = cursor !== undefined;
    from = horizon;
  }
  const { rows } = await db.query<FeedRow>(
    `select id::text, xid::text, session_id, type, data, created_at from inbox.feed
      where owner_subject = $1 and (xid, id) > ($2::xid8, $3::bigint)
        and xid < pg_snapshot_xmin(pg_current_snapshot())
      order by xid, id
      limit $4`,
    [ownerSubject, from.xid, from.id, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.id,
      type: row.type,
      sessionId: row.session_id,
      timestamp: row.created_at.toISOString(),
      data: row.data,
      cursor: formatCursor({ xid: row.xid, id: row.id }),
    })),
    cursor: formatCursor(last === undefined ? from : { xid: last.xid, id: last.id }),
    hasMore: rows.length > limit,
    truncated,
  };
}

async function readHorizon(db: Pick<pg.Pool, "query">): Promise<Position | undefined> {
  const { rows } = await db.query<Position>("select xid::text, id::text from inbox.feed_horizon");
  return rows[0];
}

function comparePositions(a: Position, b: Position): number {
  const byXid = BigInt(a.xid) - BigInt(b.xid);
  if (byXid !== 0n) return byXid < 0n ? -1 : 1;
  const byId = BigInt(a.id) - BigInt(b.id);
  return byId === 0n ? 0 : byId < 0n ? -1 : 1;
}

/**
 * Deletes the rows older than `retentionHours`, by position: the cutoff is the newest position among old rows, and
 * every row at or below it goes, so no younger row is left behind the horizon unread. Records the cutoff as the
 * horizon. Returns the number of rows deleted. One transaction; runs on shard 0 only.
 */
export async function pruneFeed(pool: pg.Pool, retentionHours: number): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<Position>(
      `select xid::text, id::text from inbox.feed
        where created_at < clock_timestamp() - make_interval(hours => $1)
          and xid < pg_snapshot_xmin(pg_current_snapshot())
        order by xid desc, id desc limit 1`,
      [retentionHours],
    );
    const cutoff = rows[0];
    if (cutoff === undefined) {
      await client.query("commit");
      return 0;
    }
    const deleted = await client.query(
      "delete from inbox.feed where (xid, id) <= ($1::xid8, $2::bigint)",
      [cutoff.xid, cutoff.id],
    );
    await client.query(
      `insert into inbox.feed_horizon (singleton, xid, id) values (true, $1::xid8, $2::bigint)
       on conflict (singleton) do update set xid = excluded.xid, id = excluded.id
        where (inbox.feed_horizon.xid, inbox.feed_horizon.id) < (excluded.xid, excluded.id)`,
      [cutoff.xid, cutoff.id],
    );
    await client.query("commit");
    return deleted.rowCount ?? 0;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Age in seconds of the oldest transaction still open in this database, which holds the feed back (never loses rows).
 * 0 when none is open. Without `pg_read_all_stats`, Postgres shows only this role's transactions; cela's processes
 * share one role, so those are the ones that matter.
 */
export async function feedLagSeconds(db: Pick<pg.Pool, "query">): Promise<number> {
  const { rows } = await db.query<{ age: number | null }>(
    `select extract(epoch from clock_timestamp() - min(xact_start))::float8 as age
       from pg_stat_activity
      where datname = current_database() and backend_xid is not null and pid <> pg_backend_pid()`,
  );
  return Math.max(0, Math.floor(rows[0]?.age ?? 0));
}
