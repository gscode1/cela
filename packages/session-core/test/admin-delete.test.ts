import { describe, expect, it } from "vitest";
import {
  AdminBlockedError,
  AdminConflictError,
  createSession,
  deleteMcpServer,
  deleteProfile,
  deleteSkill,
  putMcpServer,
  putProfile,
  putSkillVersion,
  readProfile,
  StaleProfileError,
} from "../src/index.ts";
import type { BlockedBy } from "../src/index.ts";
import { FakeSettingsDb } from "./fake-settings-db.ts";

// Deleting profiles, skills and MCP servers (docs/decisions/0027-admin-delete.md): refused while anything live refers
// to it, the rows go, and the name is never used again.

const KNOWN = { tools: ["read", "write", "edit", "bash"], mcpServers: ["docs"] };
const skill = {
  files: [
    { path: "SKILL.md", content: '---\ndescription: "Summarise a PDF"\n---\n# PDF\nRead it.\n' },
  ],
};
const server = { url: "https://mcp.example.com/mcp", readOnly: true };
const owner = { owner: "alice", subject: "static:alice" };
const model = { provider: "scripted", model: "scripted-1" };

function setup() {
  const db = new FakeSettingsDb();
  db.setRow();
  return { db, pool: db.asPool() };
}

async function blockedBy(promise: Promise<unknown>): Promise<BlockedBy> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AdminBlockedError);
  return (error as AdminBlockedError).blockedBy;
}

async function snapshotOf(pool: ReturnType<FakeSettingsDb["asPool"]>, name: string) {
  const stored = await readProfile(pool, name);
  if (stored === undefined) throw new Error(`no profile ${name}`);
  return { name, version: stored.currentVersion, definition: stored.definition };
}

describe("deleting a profile", () => {
  it("is refused while the profile is open to new sessions or is the default", async () => {
    const { pool } = setup();
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    expect(await blockedBy(deleteProfile(pool, "review", 1, "alice"))).toEqual({
      enabledForNew: true,
    });
    // `coding` is the default while settings name none.
    expect(await blockedBy(deleteProfile(pool, "coding", 1, "alice"))).toMatchObject({
      defaultProfile: true,
    });
  });

  it("removes every version once disabled, records the name, and never creates it again", async () => {
    const { db, pool } = setup();
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    await putProfile(pool, "review", { definition: { tools: ["read", "bash"] } }, "alice", KNOWN);
    await putProfile(pool, "review", { enabledForNew: false }, "alice", KNOWN);
    // A stale revision changes nothing.
    await expect(deleteProfile(pool, "review", 1, "bob")).rejects.toBeInstanceOf(
      AdminConflictError,
    );
    expect(await deleteProfile(pool, "review", 3, "bob")).toEqual({ lastVersion: 2 });
    expect(await readProfile(pool, "review")).toBeUndefined();
    expect(db.versions.filter((v) => v.name === "review")).toEqual([]);
    expect(db.deletedNames).toEqual([
      { kind: "profile", name: "review", last_version: 2, deleted_by: "bob" },
    ]);
    await expect(
      putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN),
    ).rejects.toThrow(/was deleted and cannot be used again/);
    expect(await deleteProfile(pool, "review", 3, "bob")).toBeUndefined();
  });

  it("leaves sessions alone: they run on their snapshot", async () => {
    const { db, pool } = setup();
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    const id = await createSession(pool, owner, model, undefined, await snapshotOf(pool, "review"));
    await putProfile(pool, "review", { enabledForNew: false }, "alice", KNOWN);
    await deleteProfile(pool, "review", 2, "alice");
    expect(db.sessions.get(id)?.profile_snapshot).toEqual({ tools: ["read"] });
  });
});

describe("deleting a skill", () => {
  it("is refused while a profile's current version pins it, enabled or not", async () => {
    const { pool } = setup();
    await putSkillVersion(pool, "pdf", skill, "alice");
    await putProfile(
      pool,
      "review",
      {
        definition: { tools: ["read"], skills: [{ name: "pdf", version: 1 }] },
        enabledForNew: false,
      },
      "alice",
      KNOWN,
    );
    expect(await blockedBy(deleteSkill(pool, "pdf", 1, "alice"))).toEqual({
      profiles: [{ name: "review", version: 1 }],
    });
    // A new version without the pin frees it.
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    expect(await deleteSkill(pool, "pdf", 1, "alice")).toEqual({ lastVersion: 1 });
  });

  it("is refused while a session that is not deleted pins it, failed ones included", async () => {
    const { db, pool } = setup();
    await putSkillVersion(pool, "pdf", skill, "alice");
    await putProfile(
      pool,
      "review",
      { definition: { tools: ["read"], skills: [{ name: "pdf", version: 1 }] } },
      "alice",
      KNOWN,
    );
    const id = await createSession(pool, owner, model, undefined, await snapshotOf(pool, "review"));
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    const session = db.sessions.get(id);
    if (session === undefined) throw new Error("no session");
    session.status = "failed";
    expect(await blockedBy(deleteSkill(pool, "pdf", 1, "alice"))).toEqual({
      sessions: { count: 1, sample: [id] },
    });
    session.status = "deleted";
    expect(await deleteSkill(pool, "pdf", 1, "alice")).toEqual({ lastVersion: 1 });
    expect(db.skills.size).toBe(0);
    expect(db.skillVersions).toEqual([]);
    expect(db.skillFiles).toEqual([]);
  });

  it("checks the current version as the revision, and never publishes the name again", async () => {
    const { pool } = setup();
    await putSkillVersion(pool, "pdf", skill, "alice");
    await expect(deleteSkill(pool, "pdf", 2, "alice")).rejects.toBeInstanceOf(AdminConflictError);
    await deleteSkill(pool, "pdf", 1, "alice");
    await expect(putSkillVersion(pool, "pdf", skill, "alice")).rejects.toThrow(
      /was deleted and cannot be used again/,
    );
    expect(await deleteSkill(pool, "pdf", 1, "alice")).toBeUndefined();
  });
});

describe("deleting an MCP server", () => {
  it("is refused while a profile's current version names it; sessions do not block it", async () => {
    const { db, pool } = setup();
    await putMcpServer(pool, "docs", server, "alice");
    await putProfile(
      pool,
      "review",
      { definition: { tools: ["read"], mcpServers: ["docs"] } },
      "alice",
      KNOWN,
    );
    await createSession(pool, owner, model, undefined, await snapshotOf(pool, "review"));
    expect(await blockedBy(deleteMcpServer(pool, "docs", "alice", 1))).toEqual({
      profiles: [{ name: "review", version: 1 }],
    });
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    expect(await deleteMcpServer(pool, "docs", "alice", 1)).toBe(true);
    expect(db.deletedNames.map((d) => d.kind)).toEqual(["mcp-server"]);
  });

  it("never creates the name again, and a profile cannot name it even from a stale catalog read", async () => {
    const { pool } = setup();
    await putMcpServer(pool, "docs", server, "alice");
    await deleteMcpServer(pool, "docs", "alice", 1);
    await expect(putMcpServer(pool, "docs", server, "alice")).rejects.toThrow(
      /was deleted and cannot be used again/,
    );
    // KNOWN still lists "docs", as a catalog read from before the delete would.
    expect(
      await putProfile(
        pool,
        "review",
        { definition: { tools: ["read"], mcpServers: ["docs"] } },
        "alice",
        KNOWN,
      ),
    ).toEqual({ ok: false, message: "MCP server docs was deleted" });
  });
});

describe("session creation against a changing profile", () => {
  it("refuses a snapshot whose version is no longer current, closed or deleted", async () => {
    const { pool } = setup();
    await putProfile(pool, "review", { definition: { tools: ["read"] } }, "alice", KNOWN);
    const old = await snapshotOf(pool, "review");
    await putProfile(pool, "review", { definition: { tools: ["read", "bash"] } }, "alice", KNOWN);
    await expect(createSession(pool, owner, model, undefined, old)).rejects.toBeInstanceOf(
      StaleProfileError,
    );
    const current = await snapshotOf(pool, "review");
    await putProfile(pool, "review", { enabledForNew: false }, "alice", KNOWN);
    await expect(createSession(pool, owner, model, undefined, current)).rejects.toBeInstanceOf(
      StaleProfileError,
    );
  });

  it("a delete waits for a session creation that holds the catalog lock, then sees its session", async () => {
    const { db, pool } = setup();
    await putSkillVersion(pool, "pdf", skill, "alice");
    // A creation in flight: the catalog lock is held shared.
    const creating = await db.connect();
    await creating.query("begin");
    await creating.query("select pg_advisory_xact_lock_shared(hashtext($1))", ["catalog"]);
    let settled = false;
    const deleting = deleteSkill(pool, "pdf", 1, "alice").finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // The session commits with a pin on the skill before the delete may look.
    db.sessions.set("s1", {
      id: "s1",
      status: "active",
      created_at: new Date(),
      profile_snapshot: { skills: [{ name: "pdf", version: 1 }] },
    });
    await creating.query("commit");
    creating.release();
    expect(await blockedBy(deleting)).toEqual({ sessions: { count: 1, sample: ["s1"] } });
  });
});

describe("version rows", () => {
  it("cannot be deleted outside the delete path", async () => {
    const { pool } = setup();
    await expect(
      pool.query("delete from inbox.profile_versions where name = $1", ["coding"]),
    ).rejects.toThrow(/immutable/);
  });
});
