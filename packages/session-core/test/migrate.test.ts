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
  readerComplete = false;
  readerExists = true;
  dropReaderOnLock = false;
  grantRoles: unknown[] = [];

  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: ({ version: string } | { complete: boolean } | { exists: boolean })[] }> {
    this.statements.push(sql.trim().split("\n")[0] ?? "");
    if (this.failOn !== undefined && sql.includes(this.failOn)) {
      return Promise.reject(
        Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" }),
      );
    }
    if (this.dropReaderOnLock && sql.includes("pg_advisory_xact_lock")) this.readerExists = false;
    if (sql.startsWith("select exists")) {
      return Promise.resolve({ rows: [{ exists: this.readerExists }] });
    }
    if (sql.startsWith("select has_schema_privilege")) {
      if (!this.readerExists) throw new Error('role "custom-reader" does not exist');
      return Promise.resolve({ rows: [{ complete: this.readerComplete }] });
    }
    if (sql.startsWith("select egress.grant_proxy_reader")) {
      this.grantRoles.push(params?.[0]);
      this.readerComplete = true;
    }
    if (sql.startsWith("select version")) {
      if (this.recorded === undefined)
        throw Object.assign(new Error("no table"), { code: "42P01" });
      return Promise.resolve({ rows: this.recorded.map((version) => ({ version })) });
    }
    if (sql.startsWith("create table if not exists inbox.schema_migrations")) this.recorded ??= [];
    if (sql.startsWith("insert into inbox.schema_migrations"))
      this.recorded?.push(String(params?.[0]));
    return Promise.resolve({ rows: [] });
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

  it("grants the configured role after all missing migrations, with a bound parameter", async () => {
    const db = new FakeDb();
    await applyMigrations(db.asPool(), dir, 'custom-reader"');
    expect(db.grantRoles).toEqual(['custom-reader"']);
    const grant = db.statements.findIndex((s) => s.startsWith("select egress.grant_proxy_reader"));
    expect(grant).toBeGreaterThan(db.statements.indexOf("-- b"));
    expect(db.statements.at(-1)).toBe("commit");
  });

  it("repairs missing grants on a current schema, then restarts with only SELECTs", async () => {
    const db = new FakeDb();
    db.recorded = ["001_a.sql", "002_b.sql"];
    await applyMigrations(db.asPool(), dir, "custom-reader");
    expect(db.grantRoles).toEqual(["custom-reader"]);
    expect(ran(db)).toEqual([]);
    expect(db.statements.some((s) => s.startsWith("create"))).toBe(false);
    expect(db.statements.some((s) => s.includes("pg_advisory_xact_lock"))).toBe(true);
    db.statements = [];
    await applyMigrations(db.asPool(), dir, "custom-reader");
    expect(db.statements).toHaveLength(3);
    expect(db.statements.every((s) => s.startsWith("select"))).toBe(true);
    expect(db.grantRoles).toHaveLength(1);
  });

  it.each([false, true])("skips a missing role with a current schema: %s", async (current) => {
    const db = new FakeDb();
    db.readerExists = false;
    if (current) db.recorded = ["001_a.sql", "002_b.sql"];
    await expect(applyMigrations(db.asPool(), dir, "custom-reader")).resolves.toEqual({
      missingEgressReaderRole: "custom-reader",
    });
    expect(db.grantRoles).toEqual([]);
    expect(db.recorded).toEqual(["001_a.sql", "002_b.sql"]);
    expect(db.statements.some((s) => s.startsWith("select has_schema_privilege"))).toBe(false);
    expect(db.statements.includes("begin")).toBe(!current);
    db.readerExists = true;
    await applyMigrations(db.asPool(), dir, "custom-reader");
    expect(db.grantRoles).toEqual(["custom-reader"]);
  });

  it("rechecks role existence inside the lock", async () => {
    const db = new FakeDb();
    db.recorded = ["001_a.sql", "002_b.sql"];
    db.dropReaderOnLock = true;
    await expect(applyMigrations(db.asPool(), dir, "custom-reader")).resolves.toEqual({
      missingEgressReaderRole: "custom-reader",
    });
    expect(db.grantRoles).toEqual([]);
    expect(db.statements.at(-1)).toBe("commit");
  });

  it("rolls back a failed grant instead of recording a partial migration", async () => {
    const db = new FakeDb();
    db.failOn = "select egress.grant_proxy_reader";
    await expect(applyMigrations(db.asPool(), dir, "custom-reader")).rejects.toThrow(
      /lock timeout/,
    );
    expect(db.statements.at(-1)).toBe("rollback");
  });

  it.each(["", "x".repeat(64), "é".repeat(32)])("rejects an invalid role name %j", async (role) => {
    const db = new FakeDb();
    await expect(applyMigrations(db.asPool(), dir, role)).rejects.toThrow(/1 to 63 bytes/);
    expect(db.statements).toEqual([]);
  });

  it("rolls back and rethrows when DDL cannot get its lock", async () => {
    const db = new FakeDb();
    db.failOn = "-- a";
    await expect(applyMigrations(db.asPool(), dir)).rejects.toThrow(/lock timeout/);
    expect(db.statements.at(-1)).toBe("rollback");
  });
});
