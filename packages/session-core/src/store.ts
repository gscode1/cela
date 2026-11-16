import { randomUUID } from "node:crypto";
import type pg from "pg";
import { THINKING_LEVELS } from "./models.js";
import type { ModelChoice } from "./models.js";
import type { RepoSpec } from "./repo.js";

/** `failed` is terminal: the model credentials were rejected or the turn budget is used up. Only DELETE is accepted. */
export type SessionStatus = "active" | "deleting" | "deleted" | "failed";
export type EventKind = "message" | "steer" | "cancel" | "delete";
export type EventStatus = "pending" | "submitted" | "failed";

export interface SessionRow {
  id: string;
  owner: string;
  /** Subject of the creating principal; the owner check compares this, not `owner`. */
  ownerSubject: string | null;
  status: SessionStatus;
  /** Pi Durable conversation id; null until the orchestrator has created it. */
  conversationId: number | null;
  /** The model chosen at creation; null for sessions that predate migration 002 (they run the default). */
  model: ModelChoice | null;
  /** Why the session is `failed`; null otherwise. */
  failure: string | null;
  /** The repository workspace asked for at creation; null for a plain session (no OneCLI objects exist). */
  repo: RepoSpec | null;
  /** OneCLI agent and secret ids of a repo session, once provisioned. Ids only, never values. */
  onecli: { agentId: string; secretIds: string[] } | null;
  /** When the clone and the workspace marker were first completed; null before. */
  workspaceReadyAt: Date | null;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface InboxEvent {
  /** bigint, so a string. Also the Pi Durable `requestId` of the submission. */
  id: string;
  sessionId: string;
  source: string;
  sourceEventId: string;
  kind: EventKind;
  payload: { text?: string; [key: string]: unknown };
  status: EventStatus;
  attempts: number;
  createdAt: Date;
  submittedAt: Date | null;
  error: string | null;
}

interface SessionDbRow {
  id: string;
  owner: string;
  owner_subject: string | null;
  status: SessionStatus;
  conversation_id: string | null;
  model_provider: string | null;
  model_id: string | null;
  model_reasoning: string | null;
  failure: string | null;
  repo: string | null;
  repo_branch: string | null;
  onecli_agent_id: string | null;
  onecli_secret_ids: string[] | null;
  workspace_ready_at: Date | null;
  created_at: Date;
  last_activity_at: Date;
}

export interface EventDbRow {
  id: string;
  session_id: string;
  source: string;
  source_event_id: string;
  kind: EventKind;
  payload: InboxEvent["payload"];
  status: EventStatus;
  attempts: number;
  created_at: Date;
  submitted_at: Date | null;
  error: string | null;
}

const toSession = (row: SessionDbRow): SessionRow => ({
  id: row.id,
  owner: row.owner,
  ownerSubject: row.owner_subject,
  status: row.status,
  conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
  model:
    row.model_provider === null || row.model_id === null
      ? null
      : {
          provider: row.model_provider,
          model: row.model_id,
          ...reasoningOf(row.model_reasoning),
        },
  failure: row.failure,
  repo:
    row.repo === null
      ? null
      : { repo: row.repo, ...(row.repo_branch === null ? {} : { branch: row.repo_branch }) },
  onecli:
    row.onecli_agent_id === null
      ? null
      : { agentId: row.onecli_agent_id, secretIds: row.onecli_secret_ids ?? [] },
  workspaceReadyAt: row.workspace_ready_at,
  createdAt: row.created_at,
  lastActivityAt: row.last_activity_at,
});

function reasoningOf(value: string | null): Pick<ModelChoice, "reasoning"> {
  const level = THINKING_LEVELS.find((candidate) => candidate === value);
  return level === undefined ? {} : { reasoning: level };
}

export const toEvent = (row: EventDbRow): InboxEvent => ({
  id: row.id,
  sessionId: row.session_id,
  source: row.source,
  sourceEventId: row.source_event_id,
  kind: row.kind,
  payload: row.payload,
  status: row.status,
  attempts: row.attempts,
  createdAt: row.created_at,
  submittedAt: row.submitted_at,
  error: row.error,
});

/** Session ids are random UUIDs (v4), never sequential: an id cannot be guessed from another. */
export async function createSession(
  pool: pg.Pool,
  principal: { owner: string; subject: string },
  model: ModelChoice,
  repo?: RepoSpec,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "insert into inbox.sessions (id, owner, owner_subject, model_provider, model_id, model_reasoning, repo, repo_branch) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [
      id,
      principal.owner,
      principal.subject,
      model.provider,
      model.model,
      model.reasoning ?? null,
      repo?.repo ?? null,
      repo?.branch ?? null,
    ],
  );
  return id;
}

/** Moves an active session to the terminal `failed` state. False if it was not active (failed already, deleting, deleted). */
export async function failSession(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
  failure: string,
): Promise<boolean> {
  const result = await db.query(
    `update inbox.sessions set status = 'failed', failure = $2, last_activity_at = clock_timestamp()
      where id = $1 and status = 'active'`,
    [sessionId, failure.slice(0, 500)],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getSession(
  db: Pick<pg.Pool, "query">,
  id: string,
): Promise<SessionRow | undefined> {
  const { rows } = await db.query<SessionDbRow>("select * from inbox.sessions where id = $1", [id]);
  const row = rows[0];
  return row === undefined ? undefined : toSession(row);
}

export type EnqueueResult =
  | { outcome: "accepted"; eventId: string }
  /** The same (source, source_event_id) was already stored: nothing new was written. */
  | { outcome: "duplicate"; eventId: string }
  /** The (source, source_event_id) belongs to another session. */
  | { outcome: "conflict" }
  /** `requireActive` was set and the session is not active (any more): nothing was written. */
  | { outcome: "inactive"; status: SessionStatus };

/**
 * Writes one event and returns. The unique index on (source, source_event_id) makes a repeated post a no-op that
 * returns the first event's id. The orchestrator is not involved: this works while it is down.
 */
export async function enqueueEvent(
  pool: pg.Pool,
  event: {
    sessionId: string;
    source: string;
    sourceEventId: string;
    kind: EventKind;
    payload: InboxEvent["payload"];
  },
  options: { requireActive?: boolean } = {},
): Promise<EnqueueResult> {
  // With requireActive the status test and the insert are one statement: a caller that read the session earlier
  // (ingest does, before it reads the request body) cannot get an event accepted for a session that was deleted
  // meanwhile. `for share` makes the insert wait for a concurrent status change to commit and then see it, and
  // makes a concurrent DELETE wait for this insert, so an accepted event always precedes the delete row.
  const columns = "(session_id, source, source_event_id, kind, payload)";
  const inserted = await pool.query<{ id: string }>(
    `insert into inbox.events ${columns}
     ${
       options.requireActive === true
         ? `select s.id, $2, $3, $4, $5::jsonb from inbox.sessions s where s.id = $1 and s.status = 'active' for share of s`
         : `values ($1, $2, $3, $4, $5)`
     }
     on conflict (source, source_event_id) do nothing
     returning id`,
    [event.sessionId, event.source, event.sourceEventId, event.kind, JSON.stringify(event.payload)],
  );
  const fresh = inserted.rows[0];
  if (fresh !== undefined) {
    await pool.query(
      "update inbox.sessions set last_activity_at = clock_timestamp() where id = $1",
      [event.sessionId],
    );
    return { outcome: "accepted", eventId: fresh.id };
  }
  const { rows } = await pool.query<{ id: string; session_id: string }>(
    "select id, session_id from inbox.events where source = $1 and source_event_id = $2",
    [event.source, event.sourceEventId],
  );
  const existing = rows[0];
  if (existing === undefined && options.requireActive === true) {
    const current = await pool.query<{ status: SessionStatus }>(
      "select status from inbox.sessions where id = $1",
      [event.sessionId],
    );
    return { outcome: "inactive", status: current.rows[0]?.status ?? "deleted" };
  }
  if (existing === undefined || existing.session_id !== event.sessionId) {
    return { outcome: "conflict" };
  }
  return { outcome: "duplicate", eventId: existing.id };
}

/**
 * The dedup key of a session's delete row. Client events use `source = api:<owner>` with a client-chosen id, so the
 * server's own row lives in a source no client can write: a client id such as `delete:<id>` can then never
 * occupy the key and make DELETE a no-op. (Delete rows written before this carry `api:<owner>` / `delete:<id>`;
 * they stay as they are and a new DELETE simply adds one under this key.)
 */
export function deleteEventKey(sessionId: string): { source: string; sourceEventId: string } {
  return { source: "system:delete", sourceEventId: sessionId };
}

/**
 * Puts a `failed` delete row back to `pending`. A repeated DELETE calls it: the row is deduplicated, so without this
 * a delete that failed (rows from before deletes were retried without limit, or a permanent error since fixed) could
 * never run again.
 */
export async function requeueFailedDelete(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    `update inbox.events set status = 'pending', attempts = 0, error = null
      where session_id = $1 and kind = 'delete' and status = 'failed'`,
    [sessionId],
  );
}

/** Marks an active session as being deleted, so no further events are accepted. Idempotent. */
export async function requestDelete(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query(
    "update inbox.sessions set status = 'deleting', last_activity_at = clock_timestamp() where id = $1 and status in ('active', 'failed')",
    [sessionId],
  );
}

export interface SessionSummary {
  status: SessionStatus;
  lastActivityAt: Date;
  events: Record<EventStatus, number>;
}

export async function summarize(pool: pg.Pool, session: SessionRow): Promise<SessionSummary> {
  const { rows } = await pool.query<{ status: EventStatus; n: string }>(
    "select status, count(*) as n from inbox.events where session_id = $1 group by status",
    [session.id],
  );
  const events: Record<EventStatus, number> = { pending: 0, submitted: 0, failed: 0 };
  for (const row of rows) events[row.status] = Number(row.n);
  return { status: session.status, lastActivityAt: session.lastActivityAt, events };
}

/** Records the OneCLI objects of a repo session. Ids only: no token or secret value is ever stored here. */
export async function setOneCliObjects(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
  agentId: string,
  secretIds: readonly string[],
): Promise<void> {
  await db.query(
    "update inbox.sessions set onecli_agent_id = $2, onecli_secret_ids = $3 where id = $1",
    [sessionId, agentId, [...secretIds]],
  );
}

/** Marks the repo workspace as cloned. Keeps the first time if called again. */
export async function markWorkspaceReady(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
): Promise<void> {
  await db.query(
    "update inbox.sessions set workspace_ready_at = coalesce(workspace_ready_at, clock_timestamp()) where id = $1",
    [sessionId],
  );
}

/**
 * First step of session deletion: records what the session held, so a crash before the OneCLI objects and the claim
 * are gone still leaves the list of what to revoke. Safe to repeat; the first record stays.
 */
export async function writeTombstone(
  db: Pick<pg.Pool, "query">,
  session: SessionRow,
): Promise<void> {
  await db.query(
    `insert into inbox.tombstones (session_id, conversation_id, repo, onecli_agent_id, onecli_secret_ids)
     values ($1, $2, $3, $4, $5)
     on conflict (session_id) do nothing`,
    [
      session.id,
      session.conversationId,
      session.repo?.repo ?? null,
      session.onecli?.agentId ?? null,
      session.onecli === null ? null : [...session.onecli.secretIds],
    ],
  );
}

export async function completeTombstone(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
): Promise<void> {
  await db.query(
    "update inbox.tombstones set completed_at = coalesce(completed_at, clock_timestamp()) where session_id = $1",
    [sessionId],
  );
}

/**
 * Records that a command may be running (or was interrupted) in the sandbox of this conversation. Called when a
 * burst of commands starts; a process that dies mid-command never clears it, which is the signal to recycle the Pod.
 * A conversation without a session row (the test-only control sessions) updates nothing.
 */
export async function setExecInFlight(
  db: Pick<pg.Pool, "query">,
  conversationId: number,
  inFlight: boolean,
): Promise<void> {
  await db.query(
    "update inbox.sessions set exec_in_flight_at = case when $2::boolean then clock_timestamp() else null end where conversation_id = $1",
    [conversationId, inFlight],
  );
}

/** Conversations whose sandbox had a command in flight when the last orchestrator process stopped. */
export async function conversationsWithExecInFlight(db: Pick<pg.Pool, "query">): Promise<number[]> {
  const { rows } = await db.query<{ conversation_id: string }>(
    "select conversation_id from inbox.sessions where exec_in_flight_at is not null and conversation_id is not null and status in ('active', 'failed', 'deleting')",
  );
  return rows.map((row) => Number(row.conversation_id));
}

/** What the orphan sweep needs to know about every session: no owner, model or repo. */
export interface SessionRef {
  id: string;
  status: SessionStatus;
  conversationId: number | null;
}

export async function listSessionRefs(db: Pick<pg.Pool, "query">): Promise<SessionRef[]> {
  const { rows } = await db.query<{
    id: string;
    status: SessionStatus;
    conversation_id: string | null;
  }>("select id, status, conversation_id from inbox.sessions");
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
  }));
}
