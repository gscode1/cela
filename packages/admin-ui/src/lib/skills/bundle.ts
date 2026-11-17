import { diffLines } from "diff";
import type { PublishFile, SkillFileEntry } from "@/lib/api/skills";
import { readSkillMeta } from "@/lib/skills/frontmatter";
import type { SkillMeta } from "@/lib/skills/frontmatter";
import { SEGMENT, SKILL_ENTRY, SKILL_LIMITS, SKILL_NAME } from "@/lib/skills/limits";

/** A file as read from a folder or a zip, before any check. */
export interface RawEntry {
  path: string;
  bytes: Uint8Array;
  /** `undefined`: the source cannot tell (a folder picker, a zip from a non-Unix host). */
  executable: boolean | undefined;
  /** Set when the source says it is not a regular file (a symlink in a zip). */
  irregular?: string;
}

export interface PreparedFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  bytes: Uint8Array;
  /** The content when it is valid UTF-8 without NUL (sent as `content`); `null` for a binary (sent as base64). */
  text: string | null;
}

export interface PreparedBundle {
  files: PreparedFile[];
  /** Why the API would refuse this bundle; publishing is blocked while there is any. */
  problems: string[];
  /** Files left out on purpose (`__MACOSX/`, `.DS_Store`). */
  ignored: string[];
  /** Read from SKILL.md; `undefined` when it is missing or unreadable (see `problems`). */
  meta: SkillMeta | undefined;
  totalBytes: number;
  /** The digest the API will compute, from the name, description and files; undefined while `meta` is not ok. */
  digest: string | undefined;
}

const toHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** The UTF-8 text of `bytes`, or `null` when it is not valid UTF-8 or holds a NUL (the API refuses NUL in text). */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

const IGNORED = (path: string): boolean =>
  path.startsWith("__MACOSX/") || path === ".DS_Store" || path.endsWith("/.DS_Store");

/**
 * Drops a single wrapping folder: a folder picker names it in every path, and a zip made with `zip -r skill.zip skill/`
 * has it too. Only when SKILL.md is not already at the top and every file sits below the same first segment.
 */
export function stripWrapper(entries: readonly RawEntry[]): RawEntry[] {
  if (entries.some((entry) => entry.path === SKILL_ENTRY)) return [...entries];
  const first = entries[0]?.path.split("/")[0];
  if (first === undefined || !entries.every((entry) => entry.path.startsWith(`${first}/`)))
    return [...entries];
  return entries.map((entry) => ({ ...entry, path: entry.path.slice(first.length + 1) }));
}

function pathProblem(path: string): string | undefined {
  if (path === "" || path.length > SKILL_LIMITS.path)
    return `path must be 1 to ${String(SKILL_LIMITS.path)} characters`;
  for (const segment of path.split("/")) {
    if (!SEGMENT.test(segment))
      return `"${path.slice(0, 80)}" is not a plain relative path (segments match ${SEGMENT.source}: no hidden files, no spaces, no "..")`;
  }
  return undefined;
}

/** The digest the API computes (packages/session-core/src/skills.ts, `skillDigest`). */
export async function skillDigestOf(
  name: string,
  description: string,
  files: readonly Pick<SkillFileEntry, "path" | "sha256" | "executable">[],
): Promise<string> {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ path: file.path, sha256: file.sha256, executable: file.executable }));
  const canonical = JSON.stringify({ v: 1, name, description, files: sorted });
  return sha256Hex(new TextEncoder().encode(canonical));
}

/**
 * Hashes the files and runs the API's checks that can be run in the browser: the limits (128 files, 5 MiB, SKILL.md at
 * most 32 KiB), plain relative paths, no case-only duplicates, regular files only, and the SKILL.md frontmatter. Every
 * problem is listed; the API still checks again and decides.
 */
export async function prepareBundle(
  raw: readonly RawEntry[],
  skillName: string,
  executableOverrides: ReadonlyMap<string, boolean> = new Map(),
): Promise<PreparedBundle> {
  const problems: string[] = [];
  const ignored: string[] = [];
  const present: RawEntry[] = [];
  for (const entry of raw) {
    // `__MACOSX/` and `.DS_Store` come from Finder's zip, not from the skill; they must not hide a wrapping folder.
    if (IGNORED(entry.path)) ignored.push(entry.path);
    else present.push(entry);
  }
  const kept = stripWrapper(present);
  if (kept.length === 0) problems.push("there are no files");
  if (kept.length > SKILL_LIMITS.files)
    problems.push(
      `a skill may hold at most ${String(SKILL_LIMITS.files)} files (this has ${String(kept.length)})`,
    );

  const files: PreparedFile[] = [];
  const seen = new Set<string>();
  for (const entry of kept) {
    const problem = pathProblem(entry.path);
    if (problem !== undefined) problems.push(problem);
    if (entry.irregular !== undefined)
      problems.push(`"${entry.path}" ${entry.irregular}: only regular files can be published`);
    const lower = entry.path.toLowerCase();
    if (seen.has(lower))
      problems.push(`duplicate file "${entry.path}" (paths are compared without case)`);
    seen.add(lower);
    files.push({
      path: entry.path,
      size: entry.bytes.length,
      sha256: await sha256Hex(entry.bytes),
      executable: executableOverrides.get(entry.path) ?? entry.executable ?? false,
      bytes: entry.bytes,
      text: decodeText(entry.bytes),
    });
  }
  for (const path of seen)
    for (const other of seen)
      if (other.startsWith(`${path}/`)) problems.push(`"${path}" is both a file and a directory`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > SKILL_LIMITS.bytes)
    problems.push(
      `a skill may hold at most ${String(SKILL_LIMITS.bytes)} bytes in all (this has ${String(totalBytes)})`,
    );

  let meta: SkillMeta | undefined;
  const entry = files.find((file) => file.path === SKILL_ENTRY);
  if (entry === undefined) {
    problems.push(`files must include ${SKILL_ENTRY} at the top`);
  } else if (entry.size > SKILL_LIMITS.skillMd) {
    problems.push(`${SKILL_ENTRY} may hold at most ${String(SKILL_LIMITS.skillMd)} bytes`);
  } else if (entry.text === null) {
    problems.push(`${SKILL_ENTRY} must be valid UTF-8 without NUL`);
  } else {
    meta = readSkillMeta(entry.text);
    if (!meta.ok) problems.push(meta.message);
    else if (meta.name !== undefined && meta.name !== skillName)
      problems.push(
        `${SKILL_ENTRY} frontmatter name "${meta.name.slice(0, 80)}" differs from the skill name "${skillName}"`,
      );
  }
  const digest =
    meta?.ok === true ? await skillDigestOf(skillName, meta.description, files) : undefined;
  return { files, problems, ignored, meta, totalBytes, digest };
}

export function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
};

/** The `files` of `POST /admin/skills/{name}/versions`: text as `content`, everything else as `contentBase64`. */
export function toPublishFiles(files: readonly PreparedFile[]): PublishFile[] {
  return files.map((file) => {
    const base = file.executable ? { executable: true } : {};
    return file.text !== null
      ? { path: file.path, content: file.text, ...base }
      : { path: file.path, contentBase64: toBase64(file.bytes), ...base };
  });
}

export type ChangeKind = "added" | "removed" | "changed" | "unchanged";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  /** `changed` only: the executable bit differs, whether or not the bytes do. */
  modeChanged: boolean;
  contentChanged: boolean;
}

/** The new bundle against a version's manifest: what is added, removed or changed (content or executable bit). */
export function diffManifest(
  current: readonly SkillFileEntry[],
  next: readonly Pick<PreparedFile, "path" | "sha256" | "executable">[],
): FileChange[] {
  const before = new Map(current.map((file) => [file.path, file]));
  const after = new Map(next.map((file) => [file.path, file]));
  const changes: FileChange[] = [];
  for (const [path, file] of after) {
    const old = before.get(path);
    if (old === undefined) {
      changes.push({ path, kind: "added", modeChanged: false, contentChanged: true });
      continue;
    }
    const contentChanged = old.sha256 !== file.sha256;
    const modeChanged = old.executable !== file.executable;
    changes.push({
      path,
      kind: contentChanged || modeChanged ? "changed" : "unchanged",
      modeChanged,
      contentChanged,
    });
  }
  for (const path of before.keys())
    if (!after.has(path))
      changes.push({ path, kind: "removed", modeChanged: false, contentChanged: true });
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface DiffLine {
  kind: "added" | "removed" | "same";
  text: string;
}

/** A line diff of two texts for the review of a changed file. */
export function textDiff(before: string, after: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const part of diffLines(before, after)) {
    const kind = part.added ? "added" : part.removed ? "removed" : "same";
    for (const text of part.value.replace(/\n$/, "").split("\n")) lines.push({ kind, text });
  }
  return lines;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${String(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

/** The changes worth a word in a summary: only kinds that occur, so "0 removed" never shows. */
export function changeSummary(
  changes: readonly FileChange[],
): { kind: "added" | "removed" | "changed"; count: number }[] {
  return (["added", "changed", "removed"] as const)
    .map((kind) => ({ kind, count: changes.filter((change) => change.kind === kind).length }))
    .filter(({ count }) => count > 0);
}

export type SkillName = { ok: true; name: string } | { ok: false; message: string };

/**
 * The skill's name for a chosen folder or zip. The API takes it from the URL and requires SKILL.md's frontmatter `name`,
 * when there is one, to equal it, so the order is: the frontmatter `name`; else, on a skill's own page, that skill;
 * else the folder (or the zip's file name without `.zip`). `expected` is the skill whose page is open, if any.
 */
export function deriveSkillName(
  raw: readonly RawEntry[],
  options: { expected: string | undefined; fallback: string | undefined },
): SkillName {
  const present = raw.filter((entry) => !IGNORED(entry.path));
  const kept = stripWrapper(present);
  const wrapper =
    present.length > 0 && kept[0]?.path !== present[0]?.path
      ? present[0]?.path.split("/")[0]
      : undefined;
  const entry = kept.find((file) => file.path === SKILL_ENTRY);
  const text = entry === undefined ? null : decodeText(entry.bytes);
  const meta = text === null ? undefined : readSkillMeta(text);
  const declared = meta?.ok === true ? meta.name : undefined;
  if (declared !== undefined && options.expected !== undefined && declared !== options.expected)
    return {
      ok: false,
      message: `SKILL.md names the skill "${declared.slice(0, 80)}", but this page publishes "${options.expected}".`,
    };
  const name = declared ?? options.expected ?? wrapper ?? options.fallback;
  if (name === undefined)
    return {
      ok: false,
      message: "Could not tell the skill's name: put a name in the SKILL.md frontmatter.",
    };
  if (!SKILL_NAME.test(name))
    return {
      ok: false,
      message: `"${name.slice(0, 80)}" is not a valid skill name (lowercase letters, digits and hyphens, starting with a letter). Put a valid name in the SKILL.md frontmatter.`,
    };
  return { ok: true, name };
}
