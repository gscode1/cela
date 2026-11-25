import type pg from "pg";
import { UUID } from "./http.js";
import { THINKING_LEVELS } from "./models.js";
import type { ModelChoice } from "./models.js";
import type { RepoSpec } from "./repo.js";
import type { SessionStatus } from "./store.js";

/**
 * The session list (issue #511): one page of sessions, newest first, as metadata only. It selects an explicit column
 * list that holds no transcript, event payload, token or OneCLI id, so a caller of this module cannot leak one by
 * mistake. `inbox.sessions` keeps one owner, session-core; ingest reads it through here.
 */

export const SESSION_LIST_DEFAULT = 50;
export const SESSION_LIST_MAX = 200;
export const SESSION_STATUSES: readonly SessionStatus[] = [
  "active",
  "deleting",
  "deleted",
  "failed",
];

export interface SessionListItem {
  id: string;
  /** The owner name, set only for the admin list. */
  owner?: string;
  status: SessionStatus;
  /** Null for a session that predates profiles; the caller fills in the legacy profile. */
  profile: { name: string; version: number } | null;
  /** Null for a session that predates migration 002; the caller fills in the default model. */
  model: ModelChoice | null;
  repo: RepoSpec | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface SessionListPage {
  sessions: SessionListItem[];
  /** Pass it as `cursor` for the next page; absent on the last page. */
  nextCursor?: string;
}

export interface SessionListQuery {
  /** Only this subject's sessions: the owner check of every session route. Absent only for the admin list. */
  ownerSubject?: string;
  /** Admin list only: the owner name to filter by. */
  owner?: string;
  /** Absent: every status except `deleted`. */
  status?: SessionStatus;
  limit: number;
  cursor?: SessionCursor;
  /** Include the `owner` field of each item. */
  withOwner?: boolean;
}

/** A position in (created_at desc, id desc): the microsecond timestamp as Postgres holds it, and the id. */
export interface SessionCursor {
  createdAt: string;
  id: string;
}

const CURSOR_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}$/;

/** Opaque to clients. The timestamp keeps its microseconds: a JavaScript Date would round them and repeat a row. */
export function formatSessionCursor(cursor: SessionCursor): string {
  return Buffer.from(`${cursor.createdAt}_${cursor.id}`).toString("base64url");
}

/** The position of a cursor this module issued, or undefined for anything else (a 400). */
export function parseSessionCursor(raw: string): SessionCursor | undefined {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) return undefined;
  const [createdAt, id, ...rest] = Buffer.from(raw, "base64url").toString("utf8").split("_");
  if (rest.length > 0 || createdAt === undefined || id === undefined) return undefined;
  if (!CURSOR_TIME.test(createdAt) || !UUID.test(id)) return undefined;
  return { createdAt, id };
}

interface ListRow {
  id: string;
  owner: string;
  status: SessionStatus;
  profile_name: string | null;
  profile_version: number | null;
  model_provider: string | null;
  model_id: string | null;
  model_reasoning: string | null;
  repo: string | null;
  repo_branch: string | null;
  created_at: Date;
  last_activity_at: Date;
  /** created_at to the microsecond, for the cursor. */
  created_us: string;
}

/** One page of sessions, newest first. Fetches one row more than `limit` to know whether another page follows. */
export async function listSessions(
  db: Pick<pg.Pool, "query">,
  query: SessionListQuery,
): Promise<SessionListPage> {
  const where: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${String(params.length)}`;
  };
  if (query.ownerSubject !== undefined) where.push(`owner_subject = ${bind(query.ownerSubject)}`);
  if (query.owner !== undefined) where.push(`owner = ${bind(query.owner)}`);
  where.push(query.status === undefined ? "status <> 'deleted'" : `status = ${bind(query.status)}`);
  if (query.cursor !== undefined) {
    where.push(
      `(created_at, id) < (${bind(query.cursor.createdAt)}::timestamp at time zone 'UTC', ${bind(query.cursor.id)}::uuid)`,
    );
  }
  const { rows } = await db.query<ListRow>(
    `select id, owner, status, profile_name, profile_version, model_provider, model_id, model_reasoning, repo,
            repo_branch, created_at, last_activity_at,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as created_us
       from inbox.sessions
      where ${where.join(" and ")}
      order by created_at desc, id desc
      limit ${bind(query.limit + 1)}`,
    params,
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    sessions: page.map((row) => toItem(row, query.withOwner === true)),
    ...(rows.length > query.limit && last !== undefined
      ? { nextCursor: formatSessionCursor({ createdAt: last.created_us, id: last.id }) }
      : {}),
  };
}

function toItem(row: ListRow, withOwner: boolean): SessionListItem {
  const reasoning = THINKING_LEVELS.find((level) => level === row.model_reasoning);
  return {
    id: row.id,
    ...(withOwner ? { owner: row.owner } : {}),
    status: row.status,
    profile:
      row.profile_name === null || row.profile_version === null
        ? null
        : { name: row.profile_name, version: row.profile_version },
    model:
      row.model_provider === null || row.model_id === null
        ? null
        : {
            provider: row.model_provider,
            model: row.model_id,
            ...(reasoning === undefined ? {} : { reasoning }),
          },
    repo:
      row.repo === null
        ? null
        : { repo: row.repo, ...(row.repo_branch === null ? {} : { branch: row.repo_branch }) },
    createdAt: row.created_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
  };
}
