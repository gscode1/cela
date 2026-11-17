// The browser's own Uint8Array and fflate disagree inside jsdom; these tests need no DOM.
// @vitest-environment node
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import type { SkillFileEntry } from "@/lib/api/skills";
import {
  decodeText,
  diffManifest,
  prepareBundle,
  sha256Hex,
  stripWrapper,
  textDiff,
  toPublishFiles,
} from "@/lib/skills/bundle";
import type { RawEntry } from "@/lib/skills/bundle";
import { readSkillMeta } from "@/lib/skills/frontmatter";
import { unpackZip } from "@/lib/skills/zip";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const SKILL = "---\nname: demo\ndescription: Says hello\n---\n# Demo\n";
const raw = (path: string, text: string, executable?: boolean): RawEntry => ({
  path,
  bytes: enc(text),
  executable,
});

/** A zip whose entries carry Unix modes, as `zip` on Linux or macOS writes them. */
function makeZip(files: Record<string, { data: Uint8Array; mode: number }>): Uint8Array {
  const input: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const [path, { data, mode }] of Object.entries(files))
    input[path] = [data, { os: 3, attrs: (mode << 16) >>> 0 }];
  return zipSync(input);
}

describe("unpackZip", () => {
  it("reads the executable bit from the Unix mode and keeps binary bytes", () => {
    const binary = new Uint8Array([0, 255, 1, 2, 128]);
    const zip = makeZip({
      "SKILL.md": { data: enc(SKILL), mode: 0o100644 },
      "run.sh": { data: enc("#!/bin/sh\necho hi\n"), mode: 0o100755 },
      "bin/tool": { data: binary, mode: 0o100755 },
      "notes.txt": { data: enc("n"), mode: 0o100644 },
    });
    const entries = unpackZip(zip, 1024 * 1024);
    const by = Object.fromEntries(entries.map((entry) => [entry.path, entry]));
    expect(by["run.sh"]?.executable).toBe(true);
    expect(by["bin/tool"]?.executable).toBe(true);
    expect(by["notes.txt"]?.executable).toBe(false);
    expect(Array.from(by["bin/tool"]?.bytes ?? [])).toEqual(Array.from(binary));
  });

  it("cannot tell the bit for a zip from a host without Unix modes", () => {
    const zip = zipSync({ "SKILL.md": enc(SKILL) });
    expect(unpackZip(zip, 1024)[0]?.executable).toBeUndefined();
  });

  it("flags a symlink and refuses an archive that is too large or not a zip", () => {
    const link = makeZip({ link: { data: enc("target"), mode: 0o120777 } });
    expect(unpackZip(link, 1024)[0]?.irregular).toMatch(/symbolic link/);
    expect(() =>
      unpackZip(makeZip({ big: { data: new Uint8Array(2000), mode: 0o100644 } }), 1000),
    ).toThrow(/unpacks to 2000 bytes/);
    expect(() => unpackZip(enc("nope"), 1000)).toThrow(/not a zip/);
  });

  it("skips directory entries", () => {
    const zip = zipSync({ "dir/": new Uint8Array(0), "dir/a.txt": enc("a") });
    expect(unpackZip(zip, 1000).map((entry) => entry.path)).toEqual(["dir/a.txt"]);
  });
});

describe("prepareBundle", () => {
  it("hashes each file and sends text as content and others as base64", async () => {
    const binary = new Uint8Array([0, 1, 2, 255]);
    const bundle = await prepareBundle(
      [
        raw("SKILL.md", SKILL),
        raw("run.sh", "#!/bin/sh\n", true),
        { path: "data.bin", bytes: binary, executable: false },
        { path: "latin1.txt", bytes: new Uint8Array([0xe9]), executable: false },
      ],
      "demo",
    );
    expect(bundle.problems).toEqual([]);
    expect(bundle.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "data.bin",
      "latin1.txt",
      "run.sh",
    ]);
    expect(bundle.files.find((file) => file.path === "run.sh")?.sha256).toBe(
      await sha256Hex(enc("#!/bin/sh\n")),
    );
    // A known vector, so the Web Crypto use is checked against the standard and not against itself.
    expect(await sha256Hex(enc("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const body = toPublishFiles(bundle.files);
    expect(body.find((file) => file.path === "SKILL.md")).toEqual({
      path: "SKILL.md",
      content: SKILL,
    });
    expect(body.find((file) => file.path === "run.sh")).toEqual({
      path: "run.sh",
      content: "#!/bin/sh\n",
      executable: true,
    });
    expect(body.find((file) => file.path === "data.bin")).toEqual({
      path: "data.bin",
      contentBase64: "AAEC/w==",
    });
    expect(body.find((file) => file.path === "latin1.txt")).toEqual({
      path: "latin1.txt",
      contentBase64: "6Q==",
    });
  });

  it("treats NUL and invalid UTF-8 as binary", () => {
    expect(decodeText(new Uint8Array([104, 0, 105]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff]))).toBeNull();
    expect(decodeText(enc("é"))).toBe("é");
  });

  it("drops a wrapping folder and the files macOS adds", async () => {
    const wrapped = [
      raw("demo/SKILL.md", SKILL),
      raw("demo/a/b.txt", "b"),
      raw("demo/.DS_Store", "x"),
    ];
    expect(stripWrapper(wrapped).map((entry) => entry.path)).toEqual([
      "SKILL.md",
      "a/b.txt",
      ".DS_Store",
    ]);
    const bundle = await prepareBundle([...wrapped, raw("__MACOSX/demo/._SKILL.md", "x")], "demo");
    expect(bundle.problems).toEqual([]);
    expect(bundle.ignored.sort()).toEqual(["__MACOSX/demo/._SKILL.md", "demo/.DS_Store"]);
    expect(bundle.files.map((file) => file.path)).toEqual(["SKILL.md", "a/b.txt"]);
  });

  it("applies the executable overrides of the review step over what the source said", async () => {
    const bundle = await prepareBundle(
      [raw("SKILL.md", SKILL), raw("run.sh", "x", false)],
      "demo",
      new Map([["run.sh", true]]),
    );
    expect(bundle.files.find((file) => file.path === "run.sh")?.executable).toBe(true);
  });

  it("pre-checks the limits and the path rules", async () => {
    const many = Array.from({ length: 129 }, (_, i) => raw(`f${String(i)}.txt`, "x"));
    expect(
      (await prepareBundle([raw("SKILL.md", SKILL), ...many], "demo")).problems.join("\n"),
    ).toMatch(/at most 128 files/);
    const big: RawEntry = {
      path: "big.bin",
      bytes: new Uint8Array(5 * 1024 * 1024 + 1),
      executable: false,
    };
    expect(
      (await prepareBundle([raw("SKILL.md", SKILL), big], "demo")).problems.join("\n"),
    ).toMatch(/at most 5242880 bytes/);
    const bigSkill = raw("SKILL.md", `---\ndescription: d\n---\n${"x".repeat(32 * 1024)}`);
    expect((await prepareBundle([bigSkill], "demo")).problems.join("\n")).toMatch(
      /SKILL.md may hold at most 32768/,
    );
    const bad = await prepareBundle(
      [
        raw("SKILL.md", SKILL),
        raw(".hidden", "x"),
        raw("a b.txt", "x"),
        raw("A.txt", "x"),
        raw("a.txt", "x"),
        raw("l", "x", false),
      ],
      "demo",
    );
    expect(bad.problems.join("\n")).toMatch(/\.hidden/);
    expect(bad.problems.join("\n")).toMatch(/a b\.txt/);
    expect(bad.problems.join("\n")).toMatch(/duplicate file "a\.txt"/);
    const link: RawEntry = { ...raw("lnk", "x"), irregular: "is a symbolic link" };
    expect(
      (await prepareBundle([raw("SKILL.md", SKILL), link], "demo")).problems.join("\n"),
    ).toMatch(/only regular files/);
    expect((await prepareBundle([raw("readme.md", "x")], "demo")).problems).toContain(
      "files must include SKILL.md at the top",
    );
  });

  it("reports frontmatter the API would refuse, and a name that differs from the skill", async () => {
    expect(
      (await prepareBundle([raw("SKILL.md", "# no frontmatter")], "demo")).problems[0],
    ).toMatch(/must start with a YAML frontmatter/);
    expect(
      (await prepareBundle([raw("SKILL.md", "---\nname: demo\n---\n")], "demo")).problems[0],
    ).toMatch(/non-empty description/);
    expect(
      (await prepareBundle([raw("SKILL.md", "---\nname: other\ndescription: d\n---\n")], "demo"))
        .problems[0],
    ).toMatch(/name "other" differs/);
  });

  it("predicts the digest the API computes", async () => {
    const a = await prepareBundle([raw("SKILL.md", SKILL), raw("x.txt", "x")], "demo");
    const b = await prepareBundle([raw("x.txt", "x"), raw("SKILL.md", SKILL)], "demo");
    const c = await prepareBundle([raw("SKILL.md", SKILL), raw("x.txt", "x", true)], "demo");
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
    expect(c.digest).not.toBe(a.digest);
  });
});

describe("readSkillMeta", () => {
  it("reads quoted values, comments and the invocation flag", () => {
    const meta = readSkillMeta(
      '---\nname: \'demo\'\ndescription: "Say \\"hi\\"" # c\ndisable-model-invocation: true\nother: ignored\n---\nbody',
    );
    expect(meta).toEqual({
      ok: true,
      name: "demo",
      description: 'Say "hi"',
      disableModelInvocation: true,
    });
  });

  it("refuses what the strict reader refuses", () => {
    for (const text of [
      "---\ndescription: a\ndescription: b\n---\n",
      "---\ndescription: |\n  block\n---\n",
      "---\ndescription: a\n  nested: b\n---\n",
      "---\ndescription: [a, b]\n---\n",
      "---\ndescription: a\n",
      "---\ndescription: a\ndisable-model-invocation: maybe\n---\n",
    ])
      expect(readSkillMeta(text).ok, text).toBe(false);
  });
});

describe("diffManifest and textDiff", () => {
  const entry = (path: string, sha256: string, executable = false): SkillFileEntry => ({
    path,
    size: 1,
    sha256,
    executable,
  });

  it("names added, removed, changed (content or mode) and unchanged files", () => {
    const changes = diffManifest(
      [entry("a", "1"), entry("b", "2"), entry("c", "3"), entry("d", "4")],
      [entry("a", "1"), entry("c", "33"), entry("d", "4", true), entry("e", "5")],
    );
    expect(changes).toEqual([
      { path: "a", kind: "unchanged", modeChanged: false, contentChanged: false },
      { path: "b", kind: "removed", modeChanged: false, contentChanged: true },
      { path: "c", kind: "changed", modeChanged: false, contentChanged: true },
      { path: "d", kind: "changed", modeChanged: true, contentChanged: false },
      { path: "e", kind: "added", modeChanged: false, contentChanged: true },
    ]);
  });

  it("gives a line diff", () => {
    expect(textDiff("a\nb\nc\n", "a\nB\nc\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });
});
