import type pg from "pg";

export const SESSION = "11111111-2222-4333-8444-555555555555";

export interface StoredEvent {
  id: string;
  sessionId: string;
  source: string;
  sourceEventId: string;
  kind: string;
  status: string;
}

/**
 * An in-memory stand-in for the two inbox tables, answering only the statements ingest issues. It dedups on
 * (source, source_event_id) like the unique index, so tests can see which rows exist.
 */
export class FakeInboxDb {
  status = "active";
  readonly events: StoredEvent[] = [];
  /** Runs once, right before the event insert: lets a test change the session "between" two statements. */
  beforeInsert: (() => void) | undefined;

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  /** Makes the next event insert throw, as a crash or connection loss between two statements would. */
  failNextInsert = false;
  #snapshot: { status: string; events: StoredEvent[] } | undefined;

  /** One client, enough for a transaction: `begin` snapshots, `rollback` restores, `commit` keeps. */
  connect(): Promise<{ query: FakeInboxDb["query"]; release: () => void }> {
    return Promise.resolve({ query: (sql, params) => this.query(sql, params), release: () => {} });
  }

  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const done = (rows: unknown[] = []) => Promise.resolve({ rows, rowCount: rows.length });
    if (sql === "begin") {
      this.#snapshot = { status: this.status, events: this.events.map((e) => ({ ...e })) };
      return done();
    }
    if (sql === "commit") {
      this.#snapshot = undefined;
      return done();
    }
    if (sql === "rollback") {
      if (this.#snapshot !== undefined) {
        this.status = this.#snapshot.status;
        this.events.splice(0, this.events.length, ...this.#snapshot.events);
      }
      this.#snapshot = undefined;
      return done();
    }
    if (sql.includes("select * from inbox.sessions")) {
      return done([
        {
          id: SESSION,
          owner: "alice",
          owner_subject: "static:alice",
          status: this.status,
          conversation_id: null,
          model_provider: null,
          model_id: null,
          model_reasoning: null,
          failure: null,
          repo: null,
          repo_branch: null,
          onecli_agent_id: null,
          onecli_secret_ids: null,
          workspace_ready_at: null,
          created_at: new Date(),
          last_activity_at: new Date(),
        },
      ]);
    }
    if (sql.includes("insert into inbox.events")) {
      this.beforeInsert?.();
      if (this.failNextInsert) {
        this.failNextInsert = false;
        return Promise.reject(new Error("connection lost"));
      }
      const [sessionId, source, sourceEventId, kind] = params as string[];
      if (sql.includes("status = 'active'") && this.status !== "active") return done();
      if (this.events.some((e) => e.source === source && e.sourceEventId === sourceEventId)) {
        return done();
      }
      const id = String(this.events.length + 1);
      this.events.push({
        id,
        sessionId: sessionId ?? "",
        source: source ?? "",
        sourceEventId: sourceEventId ?? "",
        kind: kind ?? "",
        status: "pending",
      });
      return done([{ id }]);
    }
    if (sql.includes("from inbox.events where source")) {
      const [source, sourceEventId] = params as string[];
      const found = this.events.find(
        (e) => e.source === source && e.sourceEventId === sourceEventId,
      );
      return done(found === undefined ? [] : [{ id: found.id, session_id: found.sessionId }]);
    }
    if (sql.includes("set status = 'pending'") && sql.includes("kind = 'delete'")) {
      for (const e of this.events) {
        if (e.kind === "delete" && e.status === "failed") e.status = "pending";
      }
      return done();
    }
    if (sql.includes("set status = 'deleting'")) {
      if (this.status === "active" || this.status === "failed") this.status = "deleting";
      return done();
    }
    if (sql.includes("select status from inbox.sessions")) return done([{ status: this.status }]);
    return done();
  }
}
