import type pg from "pg";
import { errorMessage, getSession, toEvent } from "@pi-durable-k8s/session-core";
import type { EventDbRow, InboxEvent, SessionRow } from "@pi-durable-k8s/session-core";
import { log } from "./log.js";
import { PermanentError } from "./sessions.js";

const POLL_MS = 1_000;
const BATCH = 20;
const MAX_PARALLEL_SESSIONS = 8;
const MAX_ATTEMPTS = 5;
const DELETE_RETRY_BASE_MS = 1_000;
const DELETE_RETRY_MAX_MS = 60_000;

/**
 * Wait before the next try of a failing `delete` row: 1 s, 2 s, 4 s ... capped at 60 s. A delete is not given up after
 * MAX_ATTEMPTS like other events (docs/decisions/0006-deletes-retry-until-done.md): five tries a second apart end
 * inside one short Kubernetes or OneCLI outage, and a failed delete leaks the sandbox, PVC and OneCLI agent.
 */
export function deleteRetryDelayMs(attempt: number): number {
  return Math.min(DELETE_RETRY_MAX_MS, DELETE_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export type ApplyEvent = (event: InboxEvent, session: SessionRow) => Promise<void>;
/** The slow, idempotent work an input needs before it is submitted. Runs outside any transaction. */
export type PrepareEvent = (event: InboxEvent, session: SessionRow) => Promise<void>;

/**
 * The orchestrator's side of the inbox. It claims `pending` rows, hands each to Pi Durable (the row id is the
 * `requestId`), and only then marks the row `submitted`. Pi Durable owns run recovery: a row that is
 * already `submitted` is never touched again, so a run that died is never re-run from here.
 *
 *  - Wake-up: LISTEN on `inbox_events` (sent by a trigger on insert) plus a short poll as the safety net.
 *  - Prepare: before the claim, with no transaction and no pool client held, the session's slow idempotent work
 *    (repo workspace: OneCLI agent, token, clone) runs for the first input of the batch (docs/decisions/0005). It
 *    writes nothing the claim depends on; a crash leaves the rows `pending` and the retry runs it again. A failure
 *    is recorded on that row exactly as a failure in apply is.
 *  - Claim: one short transaction per session batch, `FOR UPDATE SKIP LOCKED`, oldest first. The row locks are held
 *    until the rows are marked, so a crash in between rolls the batch back to `pending`; the retry submits
 *    with the same `requestId` and Pi Durable returns the original submission.
 *  - Ordering: one drain per session at a time, rows in (created_at, id) order. A transient failure stops
 *    that session's batch so later rows cannot overtake it; other sessions are unaffected.
 *  - Batching: rows of a session are claimed up to 20 at a time and submitted one by one, in order. They are
 *    not merged into one input: each keeps its own requestId and therefore its own idempotent submission.
 */
export class InboxLoop {
  readonly #pool: pg.Pool;
  /** The orchestrator shard: it drains only the events of its own sessions (docs/decisions/0017). */
  readonly #shard: number;
  readonly #apply: ApplyEvent;
  readonly #prepare: PrepareEvent | undefined;
  readonly #inFlight = new Set<string>();
  /** Sessions whose failing delete waits out its backoff (epoch ms). In memory: a restart simply retries at once. */
  readonly #notBefore = new Map<string, number>();
  #listener: pg.PoolClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #again = false;
  #stopped = false;

  constructor(pool: pg.Pool, shard: number, apply: ApplyEvent, prepare?: PrepareEvent) {
    this.#pool = pool;
    this.#shard = shard;
    this.#apply = apply;
    this.#prepare = prepare;
  }

  start(): void {
    void this.#listen();
    this.#timer = setInterval(() => this.wake(), POLL_MS);
    this.wake();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#listener?.removeAllListeners();
    this.#listener?.release(true);
    // Let drains in flight finish their current step: a claim holds row locks and a transaction.
    while (this.#inFlight.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  wake(): void {
    if (this.#stopped) return;
    if (this.#ticking) {
      this.#again = true;
      return;
    }
    this.#ticking = true;
    void this.#tick().finally(() => {
      this.#ticking = false;
      if (this.#again) {
        this.#again = false;
        this.wake();
      }
    });
  }

  /** A method, not a field read: TypeScript narrows `#stopped` to false inside the loop, but stop() can flip it at an await. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  async #listen(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.#pool.connect();
        // stop() ran while the connect was pending, so it found no listener to release.
        if (this.#isStopped()) {
          client.release(true);
          return;
        }
        this.#listener = client;
        await new Promise<void>((resolve) => {
          client.on("notification", () => this.wake());
          client.on("error", () => resolve());
          client.on("end", () => resolve());
          client.query("listen inbox_events").catch(() => resolve());
        });
        client.removeAllListeners();
        client.release(true);
      } catch (error) {
        log("inbox-listen-failed", { message: errorMessage(error) });
      }
      // The poll covers the gap until the listener is back.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  async #tick(): Promise<void> {
    try {
      // Sessions that cannot be started now (in flight, or waiting out a delete backoff) stay out of the query: with
      // a bare `limit` 100 of them would fill the page and starve every other session. Oldest pending event first.
      const now = Date.now();
      const skip = [...this.#inFlight];
      for (const [id, until] of this.#notBefore) if (until > now) skip.push(id);
      const { rows } = await this.#pool.query<{ session_id: string }>(
        `select e.session_id from inbox.events e join inbox.sessions s on s.id = e.session_id
          where e.status = 'pending' and s.shard = $1 and not (e.session_id = any($2::uuid[]))
          group by e.session_id order by min(e.created_at), e.session_id limit 100`,
        [this.#shard, skip],
      );
      for (const { session_id: sessionId } of rows) {
        if (this.#inFlight.has(sessionId) || this.#inFlight.size >= MAX_PARALLEL_SESSIONS) continue;
        if ((this.#notBefore.get(sessionId) ?? 0) > Date.now()) continue;
        this.#inFlight.add(sessionId);
        void this.#drain(sessionId)
          .then((progressed) => {
            if (progressed) this.wake();
          })
          .catch((error: unknown) => {
            log("inbox-drain-failed", { session: sessionId, message: errorMessage(error) });
          })
          .finally(() => this.#inFlight.delete(sessionId));
      }
    } catch (error) {
      log("inbox-poll-failed", { message: errorMessage(error) });
    }
  }

  /** Prepares, then claims and applies batches for one session until none is pending. True if it made progress. */
  async #drain(sessionId: string): Promise<boolean> {
    let progressed = false;
    while (!this.#stopped) {
      const prep = await this.#prepareHead(sessionId);
      if (prep === "none") return progressed;
      // A row that ended `failed` is progress; one left pending for a retry is not (no hot loop). Nothing is claimed
      // after it: the inputs behind it have not been prepared, so the next step prepares for the next one first.
      if (prep.gaveUp) {
        progressed = true;
        continue;
      }
      let finished = prep.blocked === undefined;
      let reprepare = false;
      let submitted = 0;
      const client = await this.#pool.connect();
      try {
        await client.query("begin");
        const { rows } = await client.query<EventDbRow>(
          `select * from inbox.events
            where session_id = $1 and status = 'pending'
            order by created_at, id
            limit $2
            for update skip locked`,
          [sessionId, BATCH],
        );
        if (rows.length === 0) {
          await client.query("commit");
          return progressed;
        }
        for (const row of rows) {
          // The row whose prepare failed was already recorded; the rows behind it must not overtake it.
          if (row.id === prep.blocked) {
            finished = false;
            break;
          }
          // An input prepare did not cover (it ran for no input, or the input arrived after its snapshot) is never
          // submitted unprepared: stop here, commit what precedes it, and prepare again.
          if (!prep.prepared && (row.kind === "message" || row.kind === "steer")) {
            reprepare = true;
            break;
          }
          const outcome = await this.#applyRow(client, toEvent(row));
          if (outcome === "retry-later") {
            finished = false;
            break;
          }
          progressed = true;
          if (outcome === "submitted") submitted += 1;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      // Once per batch and after the commit. Inside the transaction this update would hold the session row's lock
      // until the commit, and a later row of the batch (delete, a failSession) updates the same row on another
      // connection: it would wait for a lock that only this transaction's end releases, until statement_timeout.
      if (submitted > 0) await this.#touchSession(sessionId);
      if (reprepare) continue;
      if (!finished) return progressed;
    }
    return progressed;
  }

  /**
   * The prepare phase of one drain step, on the pool with no transaction: reads the pending rows without locking
   * them and prepares for the first input that precedes any delete (a session about to be deleted is not worth a
   * clone). Prepare is per session, so one run covers every input of the batch, including rows that arrive meanwhile.
   * A failure is recorded on that input's row (`blocked` when it stays pending, so the claim stops in front of it).
   * `prepared` says prepare ran for this step: only then may the claim submit an input (otherwise it stops in front of
   * the first one, which the next step prepares for). When the failure ended the row (`gaveUp`) nothing is claimed.
   */
  async #prepareHead(
    sessionId: string,
  ): Promise<"none" | { blocked?: string; gaveUp?: boolean; prepared?: boolean }> {
    const { rows } = await this.#pool.query<EventDbRow>(
      `select * from inbox.events
        where session_id = $1 and status = 'pending'
        order by created_at, id
        limit $2`,
      [sessionId, BATCH],
    );
    if (rows.length === 0) return "none";
    const prepare = this.#prepare;
    if (prepare === undefined) return { prepared: true };
    let head: InboxEvent | undefined;
    for (const row of rows) {
      if (row.kind === "delete") break;
      if (row.kind === "message" || row.kind === "steer") {
        head = toEvent(row);
        break;
      }
    }
    if (head === undefined) return {};
    try {
      const session = await getSession(this.#pool, sessionId);
      // A missing session is apply's PermanentError; there is nothing to prepare for it.
      if (session !== undefined) await prepare(head, session);
      return { prepared: true };
    } catch (error) {
      const outcome = await this.#recordFailure(this.#pool, head, error);
      return outcome === "gave-up" ? { gaveUp: true } : { blocked: head.id };
    }
  }

  async #touchSession(sessionId: string): Promise<void> {
    try {
      await this.#pool.query(
        "update inbox.sessions set last_activity_at = clock_timestamp() where id = $1",
        [sessionId],
      );
    } catch (error) {
      // Only the idle clock; the rows are already committed.
      log("inbox-touch-failed", { session: sessionId, message: errorMessage(error) });
    }
  }

  async #applyRow(
    client: pg.PoolClient,
    event: InboxEvent,
  ): Promise<"submitted" | "gave-up" | "retry-later"> {
    const attempt = event.attempts + 1;
    try {
      const session = await getSession(client, event.sessionId);
      if (session === undefined) throw new PermanentError("session does not exist");
      await this.#apply(event, session);
      await client.query(
        `update inbox.events
            set status = 'submitted', submitted_at = clock_timestamp(), attempts = $2, error = null
          where id = $1`,
        [event.id, attempt],
      );
      this.#notBefore.delete(event.sessionId);
      log("event-submitted", { eventId: event.id, session: event.sessionId, kind: event.kind });
      return "submitted";
    } catch (error) {
      return this.#recordFailure(client, event, error);
    }
  }

  /** A failed event becomes the row's outcome: `failed` when it can never succeed, else `pending` with one more attempt. */
  async #recordFailure(
    db: Pick<pg.Pool, "query">,
    event: InboxEvent,
    error: unknown,
  ): Promise<"gave-up" | "retry-later"> {
    const attempt = event.attempts + 1;
    const message = errorMessage(error).slice(0, 500);
    const permanent =
      error instanceof PermanentError || (attempt >= MAX_ATTEMPTS && event.kind !== "delete");
    if (!permanent && event.kind === "delete") {
      this.#notBefore.set(event.sessionId, Date.now() + deleteRetryDelayMs(attempt));
    }
    await db.query(
      "update inbox.events set status = $2, attempts = $3, error = $4 where id = $1 and status = 'pending'",
      [event.id, permanent ? "failed" : "pending", attempt, message],
    );
    log("event-failed", {
      eventId: event.id,
      session: event.sessionId,
      attempt,
      permanent,
      message,
    });
    return permanent ? "gave-up" : "retry-later";
  }
}
