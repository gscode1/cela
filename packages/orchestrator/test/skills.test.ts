import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSession,
  putProfile,
  putSkillVersion,
  readProfile,
  readSkillBundle,
} from "@pi-durable-k8s/session-core";
import type { SkillBundle } from "@pi-durable-k8s/session-core";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";
import { materializeSkills, SkillIntegrityError, SkillLibrary } from "../src/skills.ts";

const KNOWN = { tools: ["read", "write", "edit", "bash"], mcpServers: [] };
const skillMd = (description: string, extra = "", name = "pdf") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# PDF\nRun scripts/run.sh\n`;
const PDF = {
  files: [
    { path: "SKILL.md", content: skillMd("Summarise a PDF") },
    { path: "scripts/run.sh", content: "#!/bin/sh\necho skill-ran\n", executable: true },
    { path: "data/blob.bin", contentBase64: Buffer.from([0, 1, 254, 255]).toString("base64") },
  ],
};

async function published(db: FakeSettingsDb, input: unknown = PDF, name = "pdf") {
  const put = await putSkillVersion(db.asPool(), name, input, "alice");
  if (!put.ok) throw new Error(put.message);
  const bundle = await readSkillBundle(db.asPool(), name, put.version.version);
  if (bundle === undefined) throw new Error("no bundle");
  return bundle;
}

describe("materializeSkills", () => {
  let root: string;
  let env: NodeExecutionEnv;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-"));
    env = new NodeExecutionEnv({ cwd: root });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const skillsDir = () => join(root, ".skills");

  it("writes the files to <name>/<digest>/ with exact bytes and the executable bit, and leaves no staging", async () => {
    const bundle = await published(new FakeSettingsDb());
    const written = await materializeSkills(env, [bundle], skillsDir());
    expect(written).toEqual([`pdf/${bundle.digest}`]);
    const dir = join(skillsDir(), "pdf", bundle.digest);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(PDF.files[0]?.content);
    expect([...(await readFile(join(dir, "data/blob.bin")))]).toEqual([0, 1, 254, 255]);
    expect((await stat(join(dir, "scripts/run.sh"))).mode & 0o111).not.toBe(0);
    expect((await stat(join(dir, "SKILL.md"))).mode & 0o111).toBe(0);
    expect(await readdir(skillsDir())).toEqual(["pdf"]);
  });

  it("is idempotent: a second call writes nothing and leaves the files untouched", async () => {
    const bundle = await published(new FakeSettingsDb());
    await materializeSkills(env, [bundle], skillsDir());
    const file = join(skillsDir(), "pdf", bundle.digest, "SKILL.md");
    const before = (await stat(file)).mtimeMs;
    expect(await materializeSkills(env, [bundle], skillsDir())).toEqual([]);
    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("writes a new version beside the old one and keeps both", async () => {
    const db = new FakeSettingsDb();
    const v1 = await published(db);
    const v2 = await published(db, {
      ...PDF,
      files: [{ path: "SKILL.md", content: skillMd("changed") }],
    });
    expect(v1.digest).not.toBe(v2.digest);
    await materializeSkills(env, [v1], skillsDir());
    await materializeSkills(env, [v2], skillsDir());
    expect(await readdir(join(skillsDir(), "pdf"))).toHaveLength(2);
  });

  it("clears what a crashed attach left in staging and still completes the bundle", async () => {
    const bundle = await published(new FakeSettingsDb());
    const stale = join(skillsDir(), ".staging", `pdf-${bundle.digest}`);
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "half");
    await writeFile(join(stale, "junk"), "left over");
    await materializeSkills(env, [bundle], skillsDir());
    const dir = join(skillsDir(), "pdf", bundle.digest);
    expect(await readFile(join(dir, "SKILL.md"), "utf8")).toBe(PDF.files[0]?.content);
    await expect(stat(join(dir, "junk"))).rejects.toThrow();
  });

  it("a bundle's directory only ever exists complete: a failed write leaves none", async () => {
    const bundle = await published(new FakeSettingsDb());
    const broken: SkillBundle = {
      ...bundle,
      contents: new Map([...bundle.contents].map(([path, bytes]) => [path, bytes])),
    };
    // A file that cannot be written (its directory is a file): the staging write fails midway.
    await mkdir(join(skillsDir(), ".staging"), { recursive: true });
    await writeFile(join(skillsDir(), ".staging", `pdf-${bundle.digest}`), "a file, not a dir");
    // The staging directory is cleared first, so this must still succeed; then break the env instead.
    const failing = Object.create(env, {
      writeFile: {
        value: (path: string, ...rest: unknown[]) =>
          path.endsWith("data/blob.bin")
            ? Promise.resolve({ ok: false, error: new Error("disk full") })
            : (env.writeFile as (...a: unknown[]) => unknown)(path, ...rest),
      },
    }) as NodeExecutionEnv;
    await expect(materializeSkills(failing, [broken], skillsDir())).rejects.toThrow("disk full");
    await expect(stat(join(skillsDir(), "pdf", bundle.digest))).rejects.toThrow();
    // The next attach completes it.
    await materializeSkills(env, [broken], skillsDir());
    expect((await stat(join(skillsDir(), "pdf", bundle.digest, "data/blob.bin"))).size).toBe(4);
  });

  it("refuses a corrupt bundle before writing anything", async () => {
    const bundle = await published(new FakeSettingsDb());
    const corrupt: SkillBundle = {
      ...bundle,
      contents: new Map(bundle.contents).set("SKILL.md", Buffer.from("evil")),
    };
    await expect(materializeSkills(env, [corrupt], skillsDir())).rejects.toThrow(
      SkillIntegrityError,
    );
    await expect(readdir(join(skillsDir(), "pdf"))).rejects.toThrow();
  });

  it("does nothing for a session without skills (no directory is created)", async () => {
    expect(await materializeSkills(env, [], skillsDir())).toEqual([]);
    await expect(stat(skillsDir())).rejects.toThrow();
  });

  it("a bundled script runs in the workspace", async () => {
    const bundle = await published(new FakeSettingsDb());
    await materializeSkills(env, [bundle], skillsDir());
    let output = "";
    const run = await env.exec(
      [join(skillsDir(), "pdf", bundle.digest, "scripts/run.sh")],
      {
        cwd: root,
        onOutput: (text) => {
          output += text;
        },
      },
      context,
    );
    expect(run.ok && run.value.exitCode).toBe(0);
    expect(output).toContain("skill-ran");
  });
});

describe("SkillLibrary", () => {
  async function session(
    db: FakeSettingsDb,
    conversationId: number,
    skills: { name: string; version: number }[] = [{ name: "pdf", version: 1 }],
  ) {
    await putProfile(db.asPool(), "docs", { definition: { skills } }, "alice", KNOWN);
    const stored = await readProfile(db.asPool(), "docs");
    const id = await createSession(
      db.asPool(),
      { owner: "bob", subject: "static:bob" },
      { provider: "scripted", model: "scripted-1" },
      undefined,
      { name: "docs", version: 1, definition: stored?.definition ?? {} },
    );
    const row = db.sessions.get(id);
    if (row !== undefined) row.conversation_id = conversationId;
    return id;
  }

  it("builds the catalog from the pinned versions: names, descriptions and paths, never a body", async () => {
    const db = new FakeSettingsDb();
    const v1 = await published(db);
    await session(db, 7);
    const library = new SkillLibrary(db.asPool(), 0);
    const stored = await readProfile(db.asPool(), "docs");
    const catalog = await library.catalogFor(stored?.definition ?? {});
    expect(catalog).toContain("<name>pdf</name>");
    expect(catalog).toContain("Summarise a PDF");
    expect(catalog).toContain(`/workspace/.skills/pdf/${v1.digest}/SKILL.md`);
    expect(catalog).not.toContain("Run scripts/run.sh");
    expect(await library.catalogFor({})).toBeUndefined();
  });

  it("leaves a skill that disables model invocation out of the catalog, but still writes it", async () => {
    const db = new FakeSettingsDb();
    await published(db);
    const hidden = await published(
      db,
      {
        files: [
          {
            path: "SKILL.md",
            content: skillMd("Hidden", "disable-model-invocation: true\n", "secret"),
          },
        ],
      },
      "secret",
    );
    const pool = db.asPool();
    await session(db, 9, [
      { name: "pdf", version: 1 },
      { name: "secret", version: 1 },
    ]);
    const stored = await readProfile(pool, "docs");
    const library = new SkillLibrary(pool, 0);
    const catalog = await library.catalogFor(stored?.definition ?? {});
    expect(catalog).toContain("<name>pdf</name>");
    expect(catalog).not.toContain("secret");
    expect((await library.bundlesFor(9)).map((b) => b.name).sort()).toEqual(["pdf", "secret"]);
    expect(hidden.disableModelInvocation).toBe(true);
  });

  it("returns the verified bundles of a conversation's session, and none for another or a plain one", async () => {
    const db = new FakeSettingsDb();
    const v1 = await published(db);
    await session(db, 7);
    const library = new SkillLibrary(db.asPool(), 0);
    const bundles = await library.bundlesFor(7);
    expect(bundles.map((b) => [b.name, b.digest])).toEqual([["pdf", v1.digest]]);
    expect(await library.bundlesFor(8)).toEqual([]);
  });

  it("a later version changes neither the catalog nor the bundles of an existing session", async () => {
    const db = new FakeSettingsDb();
    const v1 = await published(db);
    await session(db, 7);
    await published(db, { ...PDF, files: [{ path: "SKILL.md", content: skillMd("changed") }] });
    const library = new SkillLibrary(db.asPool(), 0);
    expect((await library.bundlesFor(7))[0]?.digest).toBe(v1.digest);
    const stored = await readProfile(db.asPool(), "docs");
    expect(await library.catalogFor(stored?.definition ?? {})).toContain("Summarise a PDF");
  });

  it("fails closed on a missing version, a changed digest and an edited byte", async () => {
    const db = new FakeSettingsDb();
    await published(db);
    await session(db, 7);
    const library = new SkillLibrary(db.asPool(), 0);
    const stored = await readProfile(db.asPool(), "docs");
    const definition = stored?.definition ?? {};

    const first = db.skillFiles[0];
    if (first !== undefined) first.content = Buffer.from("tampered");
    await expect(library.bundlesFor(7)).rejects.toThrow(/hash|digest|manifest/);

    const row = db.skillVersions[0];
    if (row !== undefined) row.digest = "f".repeat(64);
    await expect(library.catalogFor(definition)).rejects.toThrow("pinned");
    await expect(library.bundlesFor(7)).rejects.toThrow(SkillIntegrityError);

    db.skillVersions.length = 0;
    await expect(library.catalogFor(definition)).rejects.toThrow("does not exist");
    await expect(library.bundlesFor(7)).rejects.toThrow("does not exist");
  });

  it("refuses a snapshot without a pinned digest", async () => {
    const library = new SkillLibrary(new FakeSettingsDb().asPool(), 0);
    await expect(library.catalogFor({ skills: [{ name: "pdf", version: 1 }] })).rejects.toThrow(
      "does not pin a digest",
    );
  });
});
