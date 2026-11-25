import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { formatSessionCursor } from "@cela/session-core";
import type { ModelPolicy } from "@cela/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestServer } from "../src/server.ts";
import type { SettingsView } from "../src/server.ts";

const A1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A2 = "aaaaaaaa-0000-4000-8000-000000000002";
const B1 = "bbbbbbbb-0000-4000-8000-000000000001";

interface Row {
  id: string;
  owner: string;
  owner_subject: string;
  status: string;
  profile_name: string | null;
  profile_version: number | null;
  model_provider: string | null;
  model_id: string | null;
  model_reasoning: string | null;
  repo: string | null;
  repo_branch: string | null;
  created_at: Date;
  last_activity_at: Date;
  created_us: string;
}

const row = (id: string, owner: string, over: Partial<Row> = {}): Row => ({
  id,
  owner,
  owner_subject: `static:${owner}`,
  status: "active",
  profile_name: "coding",
  profile_version: 3,
  model_provider: "scripted",
  model_id: "scripted-1",
  model_reasoning: null,
  repo: null,
  repo_branch: null,
  created_at: new Date("2026-11-25T10:00:00.123Z"),
  last_activity_at: new Date("2026-11-25T11:00:00Z"),
  created_us: "2026-11-25T10:00:00.123456",
  ...over,
});

/** Answers the list statement from `rows`, scoped by the `owner_subject = $1` and `owner = $n` conditions it carries. */
class FakeListDb {
  rows: Row[] = [];
  readonly statements: { sql: string; params: unknown[] }[] = [];
  query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[] }> {
    this.statements.push({ sql, params });
    let rows = this.rows;
    const bySubject = /owner_subject = \$(\d+)/.exec(sql);
    if (bySubject?.[1] !== undefined) {
      rows = rows.filter((r) => r.owner_subject === params[Number(bySubject[1]) - 1]);
    }
    const byOwner = /[^_]owner = \$(\d+)/.exec(sql);
    if (byOwner?.[1] !== undefined) {
      rows = rows.filter((r) => r.owner === params[Number(byOwner[1]) - 1]);
    }
    return Promise.resolve({ rows: rows.slice(0, params.at(-1) as number) });
  }
}

const policy = {
  default: { provider: "scripted", model: "default-model" },
} as unknown as ModelPolicy;

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
});

async function start(db: FakeListDb): Promise<string> {
  server = createIngestServer({
    pool: db as unknown as pg.Pool,
    authenticate: (headers) => {
      const name = /^Bearer (\w+)$/.exec(headers.authorization ?? "")?.[1];
      return Promise.resolve(
        name === undefined ? undefined : { owner: name, subject: `static:${name}` },
      );
    },
    orchestratorUrl: "http://unused",
    settings: { policy: () => policy } as unknown as SettingsView,
    admins: ["root"],
    schemaReady: () => true,
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

const get = (base: string, who: string, path: string) =>
  fetch(base + path, { headers: { authorization: `Bearer ${who}` } });

describe("GET /sessions", () => {
  it("lists the caller's sessions only, as metadata", { timeout: 10_000 }, async () => {
    const db = new FakeListDb();
    db.rows = [
      row(A1, "alice", { repo: "o/r", repo_branch: "dev", model_reasoning: "high" }),
      row(B1, "bob"),
      row(A2, "alice", { profile_name: null, profile_version: null, model_provider: null }),
    ];
    const base = await start(db);
    const res = await get(base, "alice", "/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    expect(body.sessions).toEqual([
      {
        id: A1,
        status: "active",
        profile: { name: "coding", version: 3 },
        model: { provider: "scripted", model: "scripted-1", reasoning: "high" },
        repo: { repo: "o/r", branch: "dev" },
        createdAt: "2026-11-25T10:00:00.123Z",
        lastActivityAt: "2026-11-25T11:00:00.000Z",
      },
      {
        id: A2,
        status: "active",
        // Sessions from before profiles and stored models: the legacy profile and the default model.
        profile: { name: "coding", version: 1 },
        model: { provider: "scripted", model: "default-model" },
        createdAt: "2026-11-25T10:00:00.123Z",
        lastActivityAt: "2026-11-25T11:00:00.000Z",
      },
    ]);
    // The scope is a bound parameter of the statement, not a filter applied afterwards.
    expect(db.statements[0]?.sql).toContain("owner_subject = $1");
    expect(db.statements[0]?.params[0]).toBe("static:alice");
  });

  it(
    "never returns another owner's session id, whatever the query",
    { timeout: 10_000 },
    async () => {
      const db = new FakeListDb();
      db.rows = [row(A1, "alice"), row(B1, "bob")];
      const base = await start(db);
      for (const query of ["", "?status=failed", "?owner=bob", "?limit=200"]) {
        const res = await get(base, "alice", `/sessions${query}`);
        // `owner` is an admin filter: a plain caller gets a 400, never bob's rows.
        const text = await res.text();
        expect(text, query).not.toContain(B1);
        expect(text, query).not.toContain("bob");
      }
    },
  );

  it("selects no transcript, payload, token or OneCLI column", { timeout: 10_000 }, async () => {
    const db = new FakeListDb();
    db.rows = [row(A1, "alice")];
    const base = await start(db);
    await get(base, "alice", "/sessions");
    await get(base, "root", "/admin/sessions");
    for (const { sql } of db.statements) {
      expect(sql).toContain("from inbox.sessions");
      expect(sql).not.toMatch(
        /inbox\.events|durable|payload|profile_snapshot|onecli|live_view_token|failure|usage/,
      );
      expect(sql).not.toContain("*");
    }
    const body = JSON.stringify(await (await get(base, "alice", "/sessions")).json());
    expect(body).not.toMatch(/payload|snapshot|onecli|liveView|token|transcript|text/i);
  });

  it("pages with a cursor and a limit", { timeout: 10_000 }, async () => {
    const db = new FakeListDb();
    db.rows = [row(A1, "alice"), row(A2, "alice")];
    const base = await start(db);
    const page = (await (await get(base, "alice", "/sessions?limit=1")).json()) as {
      sessions: { id: string }[];
      nextCursor?: string;
    };
    expect(page.sessions.map((s) => s.id)).toEqual([A1]);
    expect(page.nextCursor).toBe(
      formatSessionCursor({ createdAt: "2026-11-25T10:00:00.123456", id: A1 }),
    );
    // The statement asks for one row more than the limit, to know whether a page follows.
    expect(db.statements[0]?.params.at(-1)).toBe(2);
    const last = (await (await get(base, "alice", "/sessions")).json()) as Record<string, unknown>;
    expect(last).not.toHaveProperty("nextCursor");
    const next = await get(base, "alice", `/sessions?cursor=${page.nextCursor ?? ""}`);
    expect(next.status).toBe(200);
    expect(db.statements.at(-1)?.sql).toContain("(created_at, id) <");
    expect(db.statements.at(-1)?.params).toContain("2026-11-25T10:00:00.123456");
  });

  it(
    "uses a default limit of 50 and excludes deleted sessions unless asked",
    { timeout: 10_000 },
    async () => {
      const db = new FakeListDb();
      const base = await start(db);
      await get(base, "alice", "/sessions");
      expect(db.statements[0]?.params.at(-1)).toBe(51);
      expect(db.statements[0]?.sql).toContain("status <> 'deleted'");
      await get(base, "alice", "/sessions?status=deleted");
      expect(db.statements[1]?.sql).toContain("status = $2");
      expect(db.statements[1]?.params[1]).toBe("deleted");
    },
  );

  it("refuses a bad status, limit, cursor or owner", { timeout: 10_000 }, async () => {
    const base = await start(new FakeListDb());
    for (const query of [
      "status=nope",
      "limit=0",
      "limit=201",
      "limit=x",
      "limit=-1",
      "limit=1.5",
      "cursor=abc",
      "cursor=not*base64",
      `cursor=${Buffer.from("2026-11-25_x").toString("base64url")}`,
      "owner=bob",
    ]) {
      expect((await get(base, "alice", `/sessions?${query}`)).status, query).toBe(400);
    }
  });

  it("needs a token", { timeout: 10_000 }, async () => {
    const base = await start(new FakeListDb());
    expect((await fetch(`${base}/sessions`)).status).toBe(401);
  });
});

describe("GET /admin/sessions", () => {
  it(
    "lists every owner's sessions with the owner, and filters by owner",
    { timeout: 10_000 },
    async () => {
      const db = new FakeListDb();
      db.rows = [row(A1, "alice"), row(B1, "bob")];
      const base = await start(db);
      const all = (await (await get(base, "root", "/admin/sessions")).json()) as {
        sessions: { id: string; owner: string }[];
      };
      expect(all.sessions.map((s) => [s.id, s.owner])).toEqual([
        [A1, "alice"],
        [B1, "bob"],
      ]);
      expect(db.statements[0]?.sql).not.toContain("owner_subject");
      const bobs = (await (await get(base, "root", "/admin/sessions?owner=bob")).json()) as {
        sessions: { id: string }[];
      };
      expect(bobs.sessions.map((s) => s.id)).toEqual([B1]);
    },
  );

  it("is for admins only", { timeout: 10_000 }, async () => {
    const db = new FakeListDb();
    db.rows = [row(A1, "alice"), row(B1, "bob")];
    const base = await start(db);
    const res = await get(base, "alice", "/admin/sessions");
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(B1);
    expect(db.statements).toEqual([]);
    expect(
      (
        await fetch(`${base}/admin/sessions`, {
          method: "POST",
          headers: { authorization: "Bearer root" },
        })
      ).status,
    ).toBe(405);
  });

  it("validates its query like the caller's list", { timeout: 10_000 }, async () => {
    const base = await start(new FakeListDb());
    for (const query of ["status=nope", "limit=0", "cursor=zz", "owner="]) {
      expect((await get(base, "root", `/admin/sessions?${query}`)).status, query).toBe(400);
    }
  });
});
