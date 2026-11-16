import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.ts";

/** Records every statement; `recorded` stands for the rows of inbox.schema_migrations (undefined: no table). */
class FakeDb {
  statements: string[] = [];
  recorded: string[] | undefined;
  failOn: string | undefined;

  async query(sql: string, params?: unknown[]): Promise<{ rows: { version: string }[] }> {
    this.statements.push(sql.trim().split("\n")[0] ?? "");
    if (this.failOn !== undefined && sql.includes(this.failOn)) {
      throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
    }
    if (sql.startsWith("select version")) {
      if (this.recorded === undefined)
        throw Object.assign(new Error("no table"), { code: "42P01" });
      return { rows: this.recorded.map((version) => ({ version })) };
    }
    if (sql.startsWith("create table if not exists inbox.schema_migrations")) this.recorded ??= [];
    if (sql.startsWith("insert into inbox.schema_migrations"))
      this.recorded?.push(String(params?.[0]));
    return { rows: [] };
  }

  connect(): Promise<{ query: FakeDb["query"]; release: () => void }> {
    return Promise.resolve({
      query: (sql, params) => this.query(sql, params),
      release: () => undefined,
    });
  }
  asPool(): pg.Pool {
    return this as unknown as pg.Pool;
  }
}

let dir: URL;
beforeEach(async () => {
  const path = await mkdtemp(join(tmpdir(), "migrate-test-"));
  await writeFile(join(path, "001_a.sql"), "-- a");
  await writeFile(join(path, "002_b.sql"), "-- b");
  await writeFile(join(path, "README.txt"), "ignored");
  dir = pathToFileURL(path + "/");
});

const ran = (db: FakeDb): string[] => db.statements.filter((s) => s.startsWith("-- "));

describe("applyMigrations", () => {
  it("issues one SELECT and nothing else when every file is recorded", async () => {
    const db = new FakeDb();
    db.recorded = ["001_a.sql", "002_b.sql"];
    await applyMigrations(db.asPool(), dir);
    expect(db.statements).toEqual(["select version from inbox.schema_migrations"]);
  });

  it("applies only the missing files, under a short lock timeout", async () => {
    const db = new FakeDb();
    db.recorded = ["001_a.sql"];
    await applyMigrations(db.asPool(), dir);
    expect(ran(db)).toEqual(["-- b"]);
    expect(db.recorded).toEqual(["001_a.sql", "002_b.sql"]);
    const lock = db.statements.findIndex((s) => s.includes("pg_advisory_xact_lock"));
    expect(db.statements.findIndex((s) => s.includes("lock_timeout"))).toBeLessThan(lock);
    expect(db.statements.at(-1)).toBe("commit");
  });

  it("backfills a database that predates the version table, then takes the fast path", async () => {
    const db = new FakeDb(); // recorded undefined: the first rollout
    await applyMigrations(db.asPool(), dir);
    expect(ran(db)).toEqual(["-- a", "-- b"]);
    expect(db.recorded).toEqual(["001_a.sql", "002_b.sql"]);
    db.statements = [];
    await applyMigrations(db.asPool(), dir);
    expect(db.statements).toEqual(["select version from inbox.schema_migrations"]);
  });

  it("rolls back and rethrows when DDL cannot get its lock", async () => {
    const db = new FakeDb();
    db.failOn = "-- a";
    await expect(applyMigrations(db.asPool(), dir)).rejects.toThrow(/lock timeout/);
    expect(db.statements.at(-1)).toBe("rollback");
  });
});
