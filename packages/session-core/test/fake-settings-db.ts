import { EventEmitter } from "node:events";
import type pg from "pg";

interface Row {
  default_model: string;
  allowlist: unknown;
  default_reasoning: string | null;
  turn_budget: number;
  updated_at: Date;
  updated_by: string;
}

interface HistoryRow {
  id: string;
  changed_at: Date;
  changed_by: string;
  old: unknown;
  new: unknown;
}

/**
 * An in-memory stand-in for inbox.settings and inbox.settings_history that answers only the statements
 * settings.ts issues (the same approach as the ingest FakeInboxDb). `begin` snapshots and `rollback` restores;
 * notifications are delivered to listening clients at `commit`, like Postgres does.
 */
export class FakeSettingsDb {
  row: Row | undefined;
  readonly history: HistoryRow[] = [];
  /** Statements run, first line only. */
  readonly statements: string[] = [];
  /** Makes the next settings select throw, as a lost connection would. */
  failReads = false;
  readonly listeners = new Set<FakeListener>();
  #pending: string[] = [];
  #snapshot: { row: Row | undefined; history: HistoryRow[] } | undefined;

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  /** Sets the row as a writer would, without notifying. */
  setRow(partial: Partial<Row> = {}): void {
    this.row = {
      default_model: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
      default_reasoning: null,
      turn_budget: 100,
      updated_at: new Date(0),
      updated_by: "seed",
      ...partial,
    };
  }

  /** What `pg_notify` of a committed writer does. */
  notify(): void {
    for (const listener of this.listeners)
      listener.emit("notification", { channel: "pi_settings" });
  }

  connect(): Promise<FakeListener> {
    return Promise.resolve(new FakeListener(this));
  }

  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push(sql.trim().split("\n")[0] ?? "");
    const done = (rows: unknown[] = []) => Promise.resolve({ rows, rowCount: rows.length });
    const text = sql.replace(/\s+/g, " ").trim();
    if (text === "begin") {
      this.#snapshot = {
        row: this.row === undefined ? undefined : { ...this.row },
        history: [...this.history],
      };
      return done();
    }
    if (text === "commit") {
      this.#snapshot = undefined;
      const sent = this.#pending;
      this.#pending = [];
      if (sent.length > 0) this.notify();
      return done();
    }
    if (text === "rollback") {
      if (this.#snapshot !== undefined) {
        this.row = this.#snapshot.row;
        this.history.splice(0, this.history.length, ...this.#snapshot.history);
      }
      this.#snapshot = undefined;
      this.#pending = [];
      return done();
    }
    if (text.startsWith("select default_model")) {
      if (this.failReads) return Promise.reject(new Error("connection lost"));
      return done(this.row === undefined ? [] : [{ ...this.row }]);
    }
    if (text.startsWith("insert into inbox.settings (")) {
      const [model, list, reasoning, budget, by] = params as [
        string,
        string,
        string | null,
        number,
        string | undefined,
      ];
      const next: Row = {
        default_model: model,
        allowlist: JSON.parse(list) as unknown,
        default_reasoning: reasoning,
        turn_budget: budget,
        updated_at: new Date(),
        updated_by: by ?? "seed",
      };
      if (text.includes("do nothing")) {
        if (this.row !== undefined) return done();
        this.row = next;
        return done([{ default_model: model }]);
      }
      this.row = next;
      return done([{ ...next }]);
    }
    if (text.startsWith("insert into inbox.settings_history")) {
      const [by, old, next] = params as [string, string | null, string];
      this.history.push({
        id: String(this.history.length + 1),
        changed_at: new Date(),
        changed_by: by,
        old: old === null ? null : (JSON.parse(old) as unknown),
        new: JSON.parse(next) as unknown,
      });
      return done();
    }
    if (text.startsWith("select pg_notify")) {
      this.#pending.push(String(params[0]));
      return done();
    }
    if (text.startsWith("select id, changed_at")) {
      return done([...this.history].reverse().slice(0, Number(params[0])));
    }
    throw new Error(`FakeSettingsDb: unexpected statement ${text.slice(0, 60)}`);
  }
}

/** One pooled client: transaction statements go to the db; `listen` registers it for notifications. */
export class FakeListener extends EventEmitter {
  released = false;
  constructor(private readonly db: FakeSettingsDb) {
    super();
  }

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("listen ")) {
      this.db.listeners.add(this);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return this.db.query(sql, params);
  }

  release(): void {
    this.released = true;
    this.db.listeners.delete(this);
  }

  /** The server dropped the connection. */
  drop(): void {
    this.db.listeners.delete(this);
    this.emit("error", new Error("terminating connection"));
  }
}
