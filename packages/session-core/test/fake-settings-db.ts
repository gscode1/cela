import { EventEmitter } from "node:events";
import type pg from "pg";

interface Row {
  default_model: string;
  allowlist: unknown;
  default_reasoning: string | null;
  max_reasoning: string | null;
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

export interface McpRow {
  name: string;
  url: string;
  transport: string;
  enabled: boolean;
  read_only: boolean;
  timeout_ms: number;
  max_output_bytes: number;
  onecli_secret: string | null;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

interface McpHistoryRow {
  id: string;
  changed_at: Date;
  changed_by: string;
  name: string;
  action: string;
  old: unknown;
  new: unknown;
}

/**
 * An in-memory stand-in for inbox.settings, inbox.settings_history, inbox.mcp_servers and its history that answers only
 * the statements settings.ts and mcp-servers.ts issue (the same approach as the ingest FakeInboxDb). `begin` snapshots and `rollback` restores;
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
  /** inbox.mcp_servers by name, and its history. */
  mcp = new Map<string, McpRow>();
  readonly mcpHistory: McpHistoryRow[] = [];
  #pending: string[] = [];
  #snapshot:
    | {
        row: Row | undefined;
        history: HistoryRow[];
        mcp: Map<string, McpRow>;
        mcpHistory: McpHistoryRow[];
      }
    | undefined;

  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }

  /** Sets the row as a writer would, without notifying. */
  setRow(partial: Partial<Row> = {}): void {
    this.row = {
      default_model: "scripted/scripted-1",
      allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
      default_reasoning: null,
      max_reasoning: null,
      turn_budget: 100,
      updated_at: new Date(0),
      updated_by: "seed",
      ...partial,
    };
  }

  /** What `pg_notify` of a committed writer does. */
  notify(channel = "pi_settings"): void {
    for (const listener of this.listeners) {
      if (listener.channels.has(channel)) listener.emit("notification", { channel });
    }
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
        mcp: new Map([...this.mcp].map(([name, row]) => [name, { ...row }])),
        mcpHistory: [...this.mcpHistory],
      };
      return done();
    }
    if (text === "commit") {
      this.#snapshot = undefined;
      const sent = this.#pending;
      this.#pending = [];
      for (const channel of new Set(sent)) this.notify(channel);
      return done();
    }
    if (text === "rollback") {
      if (this.#snapshot !== undefined) {
        this.row = this.#snapshot.row;
        this.history.splice(0, this.history.length, ...this.#snapshot.history);
        this.mcp = this.#snapshot.mcp;
        this.mcpHistory.splice(0, this.mcpHistory.length, ...this.#snapshot.mcpHistory);
      }
      this.#snapshot = undefined;
      this.#pending = [];
      return done();
    }
    if (text.includes("inbox.mcp_servers")) return this.#mcpQuery(text, params, done);
    if (text.startsWith("select default_model")) {
      if (this.failReads) return Promise.reject(new Error("connection lost"));
      return done(this.row === undefined ? [] : [{ ...this.row }]);
    }
    if (text.startsWith("insert into inbox.settings (")) {
      const [model, list, reasoning, maxReasoning, budget, by] = params as [
        string,
        string,
        string | null,
        string | null,
        number,
        string | undefined,
      ];
      const next: Row = {
        default_model: model,
        allowlist: JSON.parse(list) as unknown,
        default_reasoning: reasoning,
        max_reasoning: maxReasoning,
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

  /** The statements of mcp-servers.ts, matched by their first words. */
  #mcpQuery(
    text: string,
    params: unknown[],
    done: (rows?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>,
  ) {
    if (this.failReads && text.startsWith("select")) {
      return Promise.reject(new Error("connection lost"));
    }
    if (text.startsWith("select name, url")) {
      if (text.includes("where name = $1")) {
        const row = this.mcp.get(String(params[0]));
        return done(row === undefined ? [] : [{ ...row }]);
      }
      return done(
        [...this.mcp.values()].sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({ ...r })),
      );
    }
    if (text.startsWith("insert into inbox.mcp_servers (")) {
      const [name, url, transport, enabled, readOnly, timeoutMs, maxOut, secret, by] = params as [
        string,
        string,
        string,
        boolean,
        boolean,
        number,
        number,
        string | null,
        string,
      ];
      const before = this.mcp.get(name);
      const now = new Date();
      const row: McpRow = {
        name,
        url,
        transport,
        enabled,
        read_only: readOnly,
        timeout_ms: timeoutMs,
        max_output_bytes: maxOut,
        onecli_secret: secret,
        created_at: before?.created_at ?? now,
        created_by: before?.created_by ?? by,
        updated_at: now,
        updated_by: by,
      };
      this.mcp.set(name, row);
      return done([{ ...row }]);
    }
    if (text.startsWith("delete from inbox.mcp_servers")) {
      const row = this.mcp.get(String(params[0]));
      this.mcp.delete(String(params[0]));
      return done(row === undefined ? [] : [{ ...row }]);
    }
    if (text.startsWith("insert into inbox.mcp_servers_history")) {
      const [by, name, action, old, next] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
      ];
      this.mcpHistory.push({
        id: String(this.mcpHistory.length + 1),
        changed_at: new Date(),
        changed_by: by,
        name,
        action,
        old: old === null ? null : (JSON.parse(old) as unknown),
        new: next === null ? null : (JSON.parse(next) as unknown),
      });
      return done();
    }
    if (text.startsWith("select id, changed_at, changed_by, name")) {
      const [limit, name] = params as [number, string | null];
      return done(
        [...this.mcpHistory]
          .filter((entry) => name === null || entry.name === name)
          .reverse()
          .slice(0, limit),
      );
    }
    throw new Error(`FakeSettingsDb: unexpected MCP statement ${text.slice(0, 60)}`);
  }
}

/** One pooled client: transaction statements go to the db; `listen` registers it for notifications. */
export class FakeListener extends EventEmitter {
  released = false;
  /** Channels this client LISTENs on. */
  readonly channels = new Set<string>();
  /** Every client handed out, so a test can check each was released once. */
  constructor(private readonly db: FakeSettingsDb) {
    super();
  }

  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.startsWith("listen ")) {
      this.channels.add(sql.slice("listen ".length).trim());
      this.db.listeners.add(this);
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return this.db.query(sql, params);
  }

  release(): void {
    // node-postgres throws on a second release; the fake must too.
    if (this.released)
      throw new Error("Release called on client which has already been released to the pool.");
    this.released = true;
    this.db.listeners.delete(this);
  }

  /** The server dropped the connection. */
  drop(): void {
    this.db.listeners.delete(this);
    this.emit("error", new Error("terminating connection"));
  }
}
