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

/**
 * The orchestrator's side of the inbox. It claims `pending` rows, hands each to Pi Durable (the row id is the
 * `requestId`), and only then marks the row `submitted`. Pi Durable owns run recovery: a row that is
 * already `submitted` is never touched again, so a run that died is never re-run from here.
 *
 *  - Wake-up: LISTEN on `inbox_events` (sent by a trigger on insert) plus a short poll as the safety net.
 *  - Claim: one transaction per session batch, `FOR UPDATE SKIP LOCKED`, oldest first. The row locks are held
 *    until the rows are marked, so a crash in between rolls the batch back to `pending`; the retry submits
 *    with the same `requestId` and Pi Durable returns the original submission.
 *  - Ordering: one drain per session at a time, rows in (created_at, id) order. A transient failure stops
 *    that session's batch so later rows cannot overtake it; other sessions are unaffected.
 *  - Batching: rows of a session are claimed up to 20 at a time and submitted one by one, in order. They are
 *    not merged into one input: each keeps its own requestId and therefore its own idempotent submission.
 */
export class InboxLoop {
  readonly #pool: pg.Pool;
  readonly #apply: ApplyEvent;
  readonly #inFlight = new Set<string>();
  /** Sessions whose failing delete waits out its backoff (epoch ms). In memory: a restart simply retries at once. */
  readonly #notBefore = new Map<string, number>();
  #listener: pg.PoolClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;
  #again = false;
  #stopped = false;

  constructor(pool: pg.Pool, apply: ApplyEvent) {
    this.#pool = pool;
    this.#apply = apply;
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
    // Let drains in flight finish their current row: they hold row locks and a transaction.
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

  async #listen(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.#pool.connect();
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
      const { rows } = await this.#pool.query<{ session_id: string }>(
        "select distinct session_id from inbox.events where status = 'pending' limit 100",
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

  /** Claims and applies batches for one session until none is pending. True if it made progress. */
  async #drain(sessionId: string): Promise<boolean> {
    let progressed = false;
    while (!this.#stopped) {
      const client = await this.#pool.connect();
      let finished = true;
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
          const event = toEvent(row);
          const outcome = await this.#applyRow(client, event);
          if (outcome === "retry-later") {
            finished = false;
            break;
          }
          progressed = true;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (!finished) return progressed;
    }
    return progressed;
  }

  async #applyRow(client: pg.PoolClient, event: InboxEvent): Promise<"done" | "retry-later"> {
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
      await client.query(
        "update inbox.sessions set last_activity_at = clock_timestamp() where id = $1",
        [event.sessionId],
      );
      this.#notBefore.delete(event.sessionId);
      log("event-submitted", { eventId: event.id, session: event.sessionId, kind: event.kind });
      return "done";
    } catch (error) {
      const message = errorMessage(error).slice(0, 500);
      const permanent =
        error instanceof PermanentError || (attempt >= MAX_ATTEMPTS && event.kind !== "delete");
      if (!permanent && event.kind === "delete") {
        this.#notBefore.set(event.sessionId, Date.now() + deleteRetryDelayMs(attempt));
      }
      await client.query(
        "update inbox.events set status = $2, attempts = $3, error = $4 where id = $1",
        [event.id, permanent ? "failed" : "pending", attempt, message],
      );
      log("event-failed", {
        eventId: event.id,
        session: event.sessionId,
        attempt,
        permanent,
        message,
      });
      return permanent ? "done" : "retry-later";
    }
  }
}
