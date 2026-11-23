import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrate.ts";

// Like feed-db.test.ts, this uses a throwaway database. Creating test roles also requires CREATEROLE.
const url = process.env.CELA_TEST_DATABASE_URL;
const migrations = new URL("../migrations/", import.meta.url);

describe.skipIf(url === undefined)("configured egress reader grants (issue #378)", () => {
  let database: string;
  let owner: string;
  let reader: string;
  let quotedReader: string;
  let admin: pg.Client;
  let pool: pg.Pool;
  let target: URL;
  let tmp: string;

  beforeEach(async () => {
    const id = randomUUID().replaceAll("-", "");
    database = `cela_egress_${id}`;
    owner = `cela_owner_${id}`;
    reader = `cela-reader-${id}"`;
    quotedReader = `"${reader.replaceAll('"', '""')}"`;
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create role ${owner} nosuperuser nocreaterole`);
    await admin.query(`create role ${quotedReader} nosuperuser nocreaterole`);
    await admin.query(`create database ${database} owner ${owner}`);
    target = new URL(url ?? "");
    target.pathname = `/${database}`;
    // Authenticate as the test admin, but run migrations with only the app owner's privileges.
    pool = new pg.Pool({
      connectionString: target.toString(),
      options: `-c role=${owner}`,
      max: 4,
    });
    tmp = await mkdtemp(join(tmpdir(), "egress-reader-"));
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`drop role if exists ${quotedReader}, ${owner}`);
    await admin.end();
    await rm(tmp, { recursive: true, force: true });
  }, 60_000);

  const canReadBindings = async (): Promise<boolean> =>
    (
      await pool.query<{ allowed: boolean }>(
        "select has_table_privilege($1::name, 'egress.bindings', 'SELECT') as allowed",
        [reader],
      )
    ).rows[0]?.allowed === true;

  const assertLeastPrivilege = async (): Promise<void> => {
    const proxy = new pg.Client({ connectionString: target.toString() });
    await proxy.connect();
    try {
      await proxy.query(`set role ${quotedReader}`);
      await proxy.query("select * from egress.bindings");
      await proxy.query(
        "select session_id, token_hash, profile_name, profile_version, rule_sets, pod_ip, created_at, revoked_at from egress.principals",
      );
      await proxy.query("delete from egress.proxy_status where false");
      await expect(proxy.query("select token_salt from egress.principals")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(proxy.query("delete from egress.rules where false")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(proxy.query("select * from inbox.sessions")).rejects.toMatchObject({
        code: "42501",
      });
      await expect(
        proxy.query("select egress.grant_proxy_reader($1::name)", [reader]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await proxy.end();
    }
  };

  it("grants a custom role on a fresh install without a Postgres restart", async () => {
    await applyMigrations(pool, migrations, reader);
    expect(await canReadBindings()).toBe(true);
    await assertLeastPrivilege();
  }, 60_000);

  it("repairs an already-current schema with concurrent starters", async () => {
    await applyMigrations(pool);
    await pool.query("select egress.grant_proxy_reader($1::name)", [reader]);
    await pool.query(`revoke select on egress.bindings from ${quotedReader}`);
    expect(await canReadBindings()).toBe(false);
    await Promise.all([
      applyMigrations(pool, migrations, reader),
      applyMigrations(pool, migrations, reader),
    ]);
    expect(await canReadBindings()).toBe(true);
    await assertLeastPrivilege();
  }, 60_000);

  it("fails for an unprovisioned role and succeeds after the operator creates it", async () => {
    await applyMigrations(pool);
    await admin.query(`drop role ${quotedReader}`);
    await expect(applyMigrations(pool, migrations, reader)).rejects.toMatchObject({
      code: "42704",
    });
    await admin.query(`create role ${quotedReader} nosuperuser nocreaterole`);
    await applyMigrations(pool, migrations, reader);
    expect(await canReadBindings()).toBe(true);
  }, 60_000);

  it("updates a custom reader's grants when upgrading from 025 through 027", async () => {
    await cp(fileURLToPath(migrations), join(tmp, "025"), {
      recursive: true,
      filter: (path) => !path.endsWith(".sql") || (path.split("/").at(-1) ?? "") < "026",
    });
    await applyMigrations(pool, pathToFileURL(join(tmp, "025") + "/"));
    await pool.query("select egress.grant_proxy_reader($1::name)", [reader]);
    await applyMigrations(pool, migrations, reader);
    expect(await canReadBindings()).toBe(true);
    await assertLeastPrivilege();
  }, 60_000);
});
