import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { lockCatalog } from "./deletion.js";
import { THINKING_LEVELS } from "./models.js";
import type { ModelChoice } from "./models.js";
import type { NetworkMode } from "./network-mode.js";
import { isSandboxFlavour } from "./sandbox-flavour.js";
import type { SandboxFlavour } from "./sandbox-flavour.js";
import type { ProfileSnapshot } from "./profiles.js";
import type { RepoSpec } from "./repo.js";

/** `failed` is terminal: the model credentials were rejected or the turn budget is used up. Only DELETE is accepted. */
export type SessionStatus = "active" | "deleting" | "deleted" | "failed";
export type EventKind = "message" | "steer" | "cancel" | "delete";
export type EventStatus = "pending" | "submitted" | "failed";

/**
 * How a submitted input ended, as Pi Durable settled it (ADR 0029, ADR 0058): answered, or unanswered with Pi's reason
 * (`model_error`, `aborted`, `run_failed`, `turn_limit`, ...). Never the provider's text.
 */
export type EventOutcome =
  { state: "answered"; settledAt: Date } | { state: "unanswered"; reason: string; settledAt: Date };

/**
 * A session's spend so far: the totals of its conversation's `pi.usage` (every model, attempt and tool that reports
 * usage), copied by the orchestrator when a run settles (#185). `cost` is in USD, pi-ai's best total: the billed cost
 * where the provider reports it, else its catalog estimate, and 0 for a model it has no price for.
 */
export interface SessionUsage {
  totalTokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** When the orchestrator last copied it (database clock). */
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  owner: string;
  /** Subject of the creating principal; the owner check compares this, not `owner`. */
  ownerSubject: string | null;
  status: SessionStatus;
  /** The orchestrator shard that owns the session; assigned at creation and never changed. */
  shard: number;
  /** Pi Durable conversation id, minted per shard schema (so unique only with `shard`); null until created. */
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
  /**
   * The profile the session was created with and the definition it resolved to then (docs/decisions/0010-session-profiles.md).
   * `snapshot` is raw JSON: whoever acts on it validates it first. Null for sessions that predate profiles (`coding`
   * version 1: today's behaviour).
   */
  profile: { name: string; version: number; snapshot: unknown } | null;
  /** Null until the first run of the session settles. */
  usage: SessionUsage | null;
  /** The sandbox size it was created with (docs/decisions/0030-sandbox-sizes.md); null before sizes: `pi-env-pool`. */
  sandboxSize: string | null;
  /** How its sandbox reaches the network, fixed at creation (docs/decisions/0038-network-modes.md); `proxied` before modes. */
  networkMode: NetworkMode;
  /** Which sandbox image it got, fixed at creation (docs/decisions/0041-browser-sandbox.md); `default` before flavours. */
  sandboxFlavour: SandboxFlavour;
  /** The named sandbox runtime it was created with (issue #406); null: the default runtime. Never coerced. */
  sandboxRuntime: string | null;
  /**
   * The secret path segment of the public view-only live view (issue #418, ADR 0066); null: the live view is off.
   * Whoever holds it can watch the desktop, so it is never logged and only its owner's API calls return it.
   */
  liveViewToken: string | null;
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
  /** Absent until Pi Durable settled the submission, and always for `cancel` and `delete`. */
  outcome?: EventOutcome;
}

interface SessionDbRow {
  id: string;
  owner: string;
  owner_subject: string | null;
  status: SessionStatus;
  shard: number;
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
  profile_name: string | null;
  profile_version: number | null;
  profile_snapshot: unknown;
  /** Absent in rows read before migration 021 was applied, and in test fakes. */
  usage?: SessionUsage | null;
  /** Absent in rows read before migration 022 was applied, and in test fakes. */
  sandbox_size?: string | null;
  /** Absent in rows read before migration 028 was applied, and in test fakes. */
  network_mode?: string | null;
  /** Absent in rows read before migration 031 was applied, and in test fakes. */
  sandbox_flavour?: string | null;
  /** Absent in rows read before migration 038 was applied, and in test fakes. */
  sandbox_runtime?: string | null;
  /** Absent in rows read before migration 040 was applied, and in test fakes. */
  live_view_token?: string | null;
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
  /** Absent in rows read before migration 035 was applied, and in test fakes. */
  outcome?: "answered" | "unanswered" | null;
  outcome_reason?: string | null;
  settled_at?: Date | null;
}

const toSession = (row: SessionDbRow): SessionRow => ({
  id: row.id,
  owner: row.owner,
  ownerSubject: row.owner_subject,
  status: row.status,
  shard: row.shard,
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
  profile:
    row.profile_name === null || row.profile_version === null
      ? null
      : {
          name: row.profile_name,
          version: row.profile_version,
          snapshot: row.profile_snapshot ?? null,
        },
  usage: row.usage ?? null,
  sandboxSize: row.sandbox_size ?? null,
  networkMode: row.network_mode === "direct" ? "direct" : "proxied",
  sandboxFlavour: isSandboxFlavour(row.sandbox_flavour) ? row.sandbox_flavour : "default",
  sandboxRuntime: row.sandbox_runtime ?? null,
  liveViewToken: row.live_view_token ?? null,
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
  ...outcomeOf(row),
});

function outcomeOf(row: EventDbRow): { outcome?: EventOutcome } {
  const settledAt = row.settled_at;
  if (settledAt === undefined || settledAt === null) return {};
  if (row.outcome === "answered") return { outcome: { state: "answered", settledAt } };
  if (row.outcome === "unanswered") {
    return { outcome: { state: "unanswered", reason: row.outcome_reason ?? "unknown", settledAt } };
  }
  return {};
}

/** Longest reason stored: Pi's reasons are short identifiers, so anything longer is not one. */
const MAX_OUTCOME_REASON = 64;

/**
 * Records how Pi Durable settled the submission of an input (the row id is its `requestId`). Written once: a second
 * call, from a watch recovered after a restart, changes nothing. False when the row has no outcome to take.
 */
export async function recordEventOutcome(
  db: Pick<pg.Pool, "query">,
  eventId: string,
  outcome: { state: "answered" } | { state: "unanswered"; reason: string },
): Promise<boolean> {
  const reason =
    outcome.state === "unanswered" ? outcome.reason.slice(0, MAX_OUTCOME_REASON) : null;
  const result = await db.query(
    `update inbox.events set outcome = $2, outcome_reason = $3, settled_at = clock_timestamp()
      where id = $1 and kind in ('message', 'steer') and outcome is null`,
    [eventId, outcome.state, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

/** One event of one session; undefined when the id is not an event of that session. */
export async function getEvent(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
  eventId: string,
): Promise<InboxEvent | undefined> {
  const { rows } = await db.query<EventDbRow>(
    "select * from inbox.events where id = $1 and session_id = $2",
    [eventId, sessionId],
  );
  const row = rows[0];
  return row === undefined ? undefined : toEvent(row);
}

/** The profile changed (a new version, closed or deleted) between reading it and storing the session: retry. */
export class StaleProfileError extends Error {}

/**
 * Session ids are random UUIDs (v4), never sequential: an id cannot be guessed from another. The session goes to the
 * shard (of `shardCount`) with the fewest active sessions, the lowest on a tie. The count and the insert are not
 * atomic: two racing creates may pick the same shard, which only affects balance.
 *
 * The insert holds the catalog lock shared and happens only if the profile is still at the snapshot's version and open
 * to new sessions (ADR 0027): a skill delete then sees every session that may pin its files, and a session never pins
 * a skill that a newer profile version dropped and a delete removed. Otherwise it throws `StaleProfileError`.
 */
export async function createSession(
  pool: pg.Pool,
  principal: { owner: string; subject: string },
  model: ModelChoice,
  repo?: RepoSpec,
  profile?: ProfileSnapshot,
  shardCount = 1,
  sandboxSize: string | null = null,
  networkMode: NetworkMode = "proxied",
  sandboxFlavour: SandboxFlavour = "default",
  sandboxRuntime: string | null = null,
  liveViewToken: string | null = null,
): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("begin");
    await lockCatalog(client, "shared");
    const { rows } = await client.query(
      `insert into inbox.sessions (id, owner, owner_subject, model_provider, model_id, model_reasoning, repo, repo_branch,
         profile_name, profile_version, profile_snapshot, shard, sandbox_size, network_mode, sandbox_flavour,
         sandbox_runtime, live_view_token)
       select $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
         coalesce((select c.shard from generate_series(0, $12::int - 1) as c(shard)
                    left join (select shard, count(*) as n from inbox.sessions where status = 'active' group by shard) a
                      on a.shard = c.shard
                    order by coalesce(a.n, 0), c.shard limit 1), 0),
         $13, $14, $15, $16, $17
        where $9::text is null
           or exists (select 1 from inbox.profiles p
                       where p.name = $9 and p.current_version = $10 and p.enabled_for_new)
       returning id`,
      [
        id,
        principal.owner,
        principal.subject,
        model.provider,
        model.model,
        model.reasoning ?? null,
        repo?.repo ?? null,
        repo?.branch ?? null,
        profile?.name ?? null,
        profile?.version ?? null,
        profile === undefined ? null : JSON.stringify(profile.definition),
        shardCount,
        sandboxSize,
        networkMode,
        sandboxFlavour,
        sandboxRuntime,
        liveViewToken,
      ],
    );
    if (rows.length === 0) {
      throw new StaleProfileError(
        `profile "${String(profile?.name)}" changed while the session was created: retry`,
      );
    }
    await client.query("commit");
    return id;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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

/**
 * Copies a session's usage totals. Totals only grow, so a write that would lower `totalTokens` (an older read that lost
 * a race with a newer one) changes nothing. Any status: a failed session's spend is still worth showing.
 */
export async function recordSessionUsage(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
  usage: Omit<SessionUsage, "updatedAt">,
): Promise<boolean> {
  const result = await db.query(
    `update inbox.sessions
        set usage = $2::jsonb || jsonb_build_object('updatedAt', to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      where id = $1 and (usage is null or (usage->>'totalTokens')::bigint <= $3)`,
    [sessionId, JSON.stringify(usage), usage.totalTokens],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Moves `last_activity_at` of a live session to now: a run is working on it or just ended (issue #333). `active` only:
 * a failed, deleting or deleted session keeps the time its status changed.
 */
export async function touchSessionActivity(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
): Promise<void> {
  await db.query(
    "update inbox.sessions set last_activity_at = clock_timestamp() where id = $1 and status = 'active'",
    [sessionId],
  );
}

export async function getSession(
  db: Pick<pg.Pool, "query">,
  id: string,
): Promise<SessionRow | undefined> {
  const { rows } = await db.query<SessionDbRow>("select * from inbox.sessions where id = $1", [id]);
  const row = rows[0];
  return row === undefined ? undefined : toSession(row);
}

/** A new live view token: 256 random bits, base64url, so it fits a URL path segment and cannot be guessed. */
export const newLiveViewToken = (): string => randomBytes(32).toString("base64url");

/**
 * Turns the live view of an active session on or off (`null`), or replaces its token (rotation). False when the
 * session is not active: a deleting or deleted session never gets a token, and a failed one has no desktop to show.
 */
export async function setLiveViewToken(
  db: Pick<pg.Pool, "query">,
  sessionId: string,
  token: string | null,
): Promise<boolean> {
  const result = await db.query(
    "update inbox.sessions set live_view_token = $2 where id = $1 and (status = 'active' or $2::text is null)",
    [sessionId, token],
  );
  return (result.rowCount ?? 0) > 0;
}

/** The session a live view token opens, or undefined. The lookup the unauthenticated viewer route makes. */
export async function sessionByLiveViewToken(
  db: Pick<pg.Pool, "query">,
  token: string,
): Promise<SessionRow | undefined> {
  const { rows } = await db.query<SessionDbRow>(
    "select * from inbox.sessions where live_view_token = $1",
    [token],
  );
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
  pool: Pick<pg.Pool, "query">,
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
export async function requestDelete(
  pool: Pick<pg.Pool, "query">,
  sessionId: string,
): Promise<void> {
  await pool.query(
    "update inbox.sessions set status = 'deleting', live_view_token = null, last_activity_at = clock_timestamp() where id = $1 and status in ('active', 'failed')",
    [sessionId],
  );
}

/**
 * DELETE's two writes as one transaction: the status change to `deleting` and the delete row. A crash or database
 * error between two separate statements left a `deleting` session with no delete row, which nothing recovers
 * (events are refused for it and the sweep treats `deleting` as live). Rolled back, the session stays as it was and the
 * client's retry starts over; a session already stuck that way is healed by a repeated DELETE, which still inserts the
 * (deduplicated) row.
 */
export async function beginDelete(pool: pg.Pool, sessionId: string): Promise<EnqueueResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await requestDelete(client, sessionId);
    const result = await enqueueEvent(client, {
      sessionId,
      ...deleteEventKey(sessionId),
      kind: "delete",
      payload: {},
    });
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
  shard: number,
  conversationId: number,
  inFlight: boolean,
): Promise<void> {
  await db.query(
    "update inbox.sessions set exec_in_flight_at = case when $3::boolean then clock_timestamp() else null end where shard = $1 and conversation_id = $2",
    [shard, conversationId, inFlight],
  );
}

/** Conversations whose sandbox had a command in flight when the last orchestrator process stopped. */
export async function conversationsWithExecInFlight(
  db: Pick<pg.Pool, "query">,
  shard: number,
): Promise<number[]> {
  const { rows } = await db.query<{ conversation_id: string }>(
    "select conversation_id from inbox.sessions where shard = $1 and exec_in_flight_at is not null and conversation_id is not null and status in ('active', 'failed', 'deleting')",
    [shard],
  );
  return rows.map((row) => Number(row.conversation_id));
}

/** What the orphan sweep needs to know about every session: no owner, model or repo. */
export interface SessionRef {
  id: string;
  status: SessionStatus;
  shard: number;
  conversationId: number | null;
}

export async function listSessionRefs(db: Pick<pg.Pool, "query">): Promise<SessionRef[]> {
  const { rows } = await db.query<{
    id: string;
    status: SessionStatus;
    shard: number;
    conversation_id: string | null;
  }>("select id, status, shard, conversation_id from inbox.sessions");
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    shard: row.shard,
    conversationId: row.conversation_id === null ? null : Number(row.conversation_id),
  }));
}

/**
 * The session of one conversation. Conversation ids repeat across shards, so this is the only way orchestrator code
 * looks a session up by conversation id.
 */
export async function sessionByConversation(
  db: Pick<pg.Pool, "query">,
  shard: number,
  conversationId: number,
): Promise<SessionRow | undefined> {
  const { rows } = await db.query<SessionDbRow>(
    "select * from inbox.sessions where shard = $1 and conversation_id = $2",
    [shard, conversationId],
  );
  const row = rows[0];
  return row === undefined ? undefined : toSession(row);
}
