import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSkillCatalog, SKILL_LIMITS } from "@pi-durable-k8s/session-core";
import {
  CONTEXT_LIMIT,
  joinInstructions,
  mergeCatalog,
  readProjectContext,
  renderProjectContext,
  scanRepoSkills,
} from "../src/repo-context.ts";

const skillMd = (description: string, extra = ""): string =>
  `---\n${description === "" ? "" : `description: ${description}\n`}${extra}---\n# Body\n`;

let root: string;
let env: NodeExecutionEnv;
const logs: string[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "repo-context-"));
  env = new NodeExecutionEnv({ cwd: root });
  logs.length = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function put(path: string, text: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
const scan = () => scanRepoSkills(env, root);

describe("scanRepoSkills", () => {
  it("finds skills under .pi/skills and .agents/skills, with absolute locations, .pi first", async () => {
    await put(".agents/skills/csv/SKILL.md", skillMd("Edit CSV"));
    await put(".pi/skills/pdf/SKILL.md", skillMd("Summarise a PDF"));
    expect(await scan()).toEqual([
      {
        name: "pdf",
        description: "Summarise a PDF",
        location: `${root}/.pi/skills/pdf/SKILL.md`,
        disableModelInvocation: false,
      },
      {
        name: "csv",
        description: "Edit CSV",
        location: `${root}/.agents/skills/csv/SKILL.md`,
        disableModelInvocation: false,
      },
    ]);
  });

  it("is empty without skills directories, and ignores .claude/skills", async () => {
    await put(".claude/skills/x/SKILL.md", skillMd("Nope"));
    expect(await scan()).toEqual([]);
  });

  it("takes the name from the frontmatter, else the directory, and honours disable-model-invocation", async () => {
    await put(".pi/skills/dir-name/SKILL.md", skillMd("A", "name: given-name\n"));
    await put(".pi/skills/plain/SKILL.md", skillMd("B"));
    await put(".pi/skills/hidden/SKILL.md", skillMd("C", "disable-model-invocation: true\n"));
    const skills = await scan();
    expect(skills.map((s) => [s.name, s.disableModelInvocation])).toEqual([
      ["given-name", false],
      ["hidden", true],
      ["plain", false],
    ]);
  });

  it("skips invalid files with a log line and keeps the rest", async () => {
    await put(".pi/skills/nodesc/SKILL.md", skillMd(""));
    await put(".pi/skills/nofront/SKILL.md", "# just markdown\n");
    await put(".pi/skills/nested/SKILL.md", "---\ndescription: x\nmetadata:\n  a: b\n---\n");
    await put(".pi/skills/flag/SKILL.md", skillMd("F", "disable-model-invocation: maybe\n"));
    await put(
      ".pi/skills/big/SKILL.md",
      skillMd("B", `# ${"x".repeat(SKILL_LIMITS.skillMd)}\n`).replace("# Body", ""),
    );
    await put(".pi/skills/good/SKILL.md", skillMd("G"));
    expect((await scan()).map((s) => s.name)).toEqual(["good"]);
    const skipped = logs.filter((l) => l.includes("repo-skill-skipped"));
    expect(skipped).toHaveLength(5);
    expect(skipped.join()).toContain("no description");
    expect(skipped.join()).toContain("no frontmatter");
  });

  it("does not search inside a skill, past the depth bound, in hidden directories or node_modules, or through symlinks", async () => {
    await put(".pi/skills/outer/SKILL.md", skillMd("Outer"));
    await put(".pi/skills/outer/inner/SKILL.md", skillMd("Inner"));
    await put(".pi/skills/group/ok/SKILL.md", skillMd("Grouped"));
    await put(".pi/skills/a/b/c/d/e/SKILL.md", skillMd("Too deep"));
    await put(".pi/skills/.hidden/SKILL.md", skillMd("Hidden dir"));
    await put(".pi/skills/node_modules/x/SKILL.md", skillMd("Modules"));
    await put("elsewhere/linked/SKILL.md", skillMd("Linked"));
    await symlink(join(root, "elsewhere/linked"), join(root, ".pi/skills/link"));
    expect((await scan()).map((s) => s.name)).toEqual(["ok", "outer"]);
  });

  it("keeps the first of two skills with the same name", async () => {
    await put(".pi/skills/a/SKILL.md", skillMd("First", "name: same\n"));
    await put(".agents/skills/b/SKILL.md", skillMd("Second", "name: same\n"));
    expect((await scan()).map((s) => s.description)).toEqual(["First"]);
  });
});

describe("scanRepoSkills bounds and symlinks", () => {
  it("does not enter .pi, .agents, .pi/skills or .agents/skills when they are symlinks", async () => {
    await put("outside/skills/evil/SKILL.md", skillMd("Evil"));
    await put("outside2/evil2/SKILL.md", skillMd("Evil2"));
    await symlink(join(root, "outside"), join(root, ".pi"));
    await symlink(join(root, "outside"), join(root, ".agents"));
    expect(await scan()).toEqual([]);
    await rm(join(root, ".pi"));
    await rm(join(root, ".agents"));
    await mkdir(join(root, ".pi"));
    await mkdir(join(root, ".agents"));
    await symlink(join(root, "outside2"), join(root, ".pi/skills"));
    await symlink(join(root, "outside2"), join(root, ".agents/skills"));
    expect(await scan()).toEqual([]);
  });

  it("never opens a SKILL.md the listing says is over the limit, and reads at most limit + 1 bytes of one that grew", async () => {
    await put(".pi/skills/big/SKILL.md", skillMd("Big", "x".repeat(SKILL_LIMITS.skillMd)));
    await put(".pi/skills/ok/SKILL.md", skillMd("Ok"));
    const opened: string[] = [];
    const reads: number[] = [];
    const spy = async (
      path: string,
      options: Parameters<typeof env.openBinaryReader>[1],
      context: Parameters<typeof env.openBinaryReader>[2],
    ) => {
      opened.push(path);
      const reader = await env.openBinaryReader(path, options, context);
      if (reader.ok) {
        const original = reader.value.read.bind(reader.value);
        reader.value.read = (offset, length, c) => {
          reads.push(length);
          return original(offset, length, c);
        };
      }
      return reader;
    };
    const wrapped = { listDir: env.listDir.bind(env), openBinaryReader: spy };
    expect((await scanRepoSkills(wrapped as never, root)).map((s) => s.name)).toEqual(["ok"]);
    expect(opened.some((p) => p.includes("/big/"))).toBe(false);
    expect(reads).toEqual([SKILL_LIMITS.skillMd + 1]);
  });
});

describe("mergeCatalog", () => {
  const admin = (name: string) => ({
    name,
    description: `admin ${name}`,
    location: `/workspace/.skills/${name}/d/SKILL.md`,
  });
  const repo = (name: string, disable = false) => ({
    name,
    description: `repo ${name}`,
    location: `/workspace/repo/.pi/skills/${name}/SKILL.md`,
    disableModelInvocation: disable,
  });

  it("lists admin skills first and lets them win a name collision", () => {
    const merged = mergeCatalog([admin("pdf")], [repo("pdf"), repo("csv"), repo("off", true)]);
    expect(merged.map((e) => e.description)).toEqual(["admin pdf", "repo csv"]);
  });

  it("stops at the shared cap of 20 skills", () => {
    const merged = mergeCatalog(
      [admin("a1"), admin("a2")],
      Array.from({ length: 25 }, (_, i) => repo(`r${String(i)}`)),
    );
    expect(merged).toHaveLength(SKILL_LIMITS.perProfile);
    expect(merged.slice(0, 2).map((e) => e.name)).toEqual(["a1", "a2"]);
  });

  it("stops at the 32 KiB catalog cap", () => {
    const fat = (name: string) => ({
      ...repo(name),
      description: "d".repeat(1000),
      location: `/workspace/repo/${"x".repeat(800)}/${name}/SKILL.md`,
    });
    const merged = mergeCatalog(
      [],
      Array.from({ length: 20 }, (_, i) => fat(`s${String(i)}`)),
    );
    expect(merged.length).toBeLessThan(20);
    expect(Buffer.byteLength(buildSkillCatalog(merged))).toBeLessThanOrEqual(SKILL_LIMITS.catalog);
  });
});

describe("joinInstructions", () => {
  it("joins the non-empty parts with a blank line and is undefined for none", () => {
    expect(joinInstructions(["a", undefined, "", "b"])).toBe("a\n\nb");
    expect(joinInstructions([undefined, ""])).toBeUndefined();
  });
});

describe("readProjectContext", () => {
  const read = () => readProjectContext(env, root);

  it("is undefined without a context file", async () => {
    await put("README.md", "hi");
    expect(await read()).toBeUndefined();
  });

  it("takes the first of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD", async () => {
    await put("CLAUDE.md", "claude");
    expect((await read())?.content).toBe("claude");
    await put("AGENTS.md", "agents");
    expect((await read())?.content).toBe("agents");
    await put("AGENTS.override.md", "override");
    expect(await read()).toEqual({ path: `${root}/AGENTS.override.md`, content: "override" });
  });

  it("does not follow a symlink or take a directory, and falls through to the next name", async () => {
    await put("elsewhere.md", "secret");
    await symlink(join(root, "elsewhere.md"), join(root, "AGENTS.md"));
    await mkdir(join(root, "AGENTS.override.md"));
    await put("CLAUDE.md", "claude");
    expect((await read())?.content).toBe("claude");
  });

  it("drops a BOM and leaves a file within the cap as it is", async () => {
    await put("AGENTS.md", "\uFEFFRules\n");
    expect((await read())?.content).toBe("Rules\n");
  });

  it("cuts a file over 32 KiB at a character boundary and says so", async () => {
    await put("AGENTS.md", "é".repeat(CONTEXT_LIMIT)); // 2 bytes each: twice the cap
    const file = await read();
    const content = file?.content ?? "";
    const [kept = "", note = ""] = content.split("\n\n[truncated");
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(CONTEXT_LIMIT);
    expect(kept).not.toContain("\uFFFD");
    expect(kept).toMatch(/^é+$/u);
    expect(note).toContain(`AGENTS.md is ${String(CONTEXT_LIMIT * 2)} bytes`);
    expect(logs.join()).toContain("repo-context-truncated");
  });

  it("skips a file over 1 MiB with a log line", async () => {
    await put("AGENTS.md", "x".repeat(1024 * 1024 + 1));
    await put("CLAUDE.md", "small");
    const opened: string[] = [];
    const original = env.openBinaryReader.bind(env);
    env.openBinaryReader = (path, options, c) => {
      opened.push(path);
      return original(path, options, c);
    };
    expect((await read())?.content).toBe("small");
    expect(opened).toEqual([`${root}/CLAUDE.md`]);
    expect(logs.join()).toContain("repo-context-skipped");
  });

  it("renders as Pi does: the header and one project_instructions element with the path", () => {
    expect(renderProjectContext({ path: "/workspace/repo/AGENTS.md", content: "Do X." })).toBe(
      'Project-specific instructions and guidelines:\n\n<project_instructions path="/workspace/repo/AGENTS.md">\nDo X.\n</project_instructions>',
    );
  });
});
