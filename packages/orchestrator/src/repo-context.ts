import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  buildSkillCatalog,
  parseFrontmatter,
  SKILL_ENTRY,
  SKILL_LIMITS,
} from "@pi-durable-k8s/session-core";
import type { FileInfo } from "@earendil-works/pi-durable/env";
import { log } from "./log.js";
import { REPO_DIR } from "./workspace.js";
import type { WorkspaceEnv } from "./workspace.js";

/**
 * What the orchestrator reads out of a cloned repo to add to a session's instructions (docs/decisions/0014-repo-skills.md).
 * Everything goes through the session's sandbox env, never the orchestrator's own filesystem.
 */

/** Skill directories of the checkout, in order (Pi 1.5.2's project locations, anchored at the checkout root). */
export const REPO_SKILL_DIRS = [".pi/skills", ".agents/skills"] as const;
/** Directory levels below a skills directory that are searched for a SKILL.md. */
const MAX_DEPTH = 4;
/** Directories listed and SKILL.md files read per scan: a hostile repo cannot make a scan unbounded. */
const MAX_LISTINGS = 200;
const MAX_FILES = 100;
const MAX_NAME = 64;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/** A skill that was found in the repo and is valid; `disableModelInvocation` ones are kept out of the catalog later. */
export interface RepoSkill {
  name: string;
  description: string;
  location: string;
  disableModelInvocation: boolean;
}

export interface CatalogEntry {
  name: string;
  description: string;
  location: string;
}

/** Non-empty parts joined by a blank line; undefined when there are none. */
export function joinInstructions(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((part): part is string => part !== undefined && part !== "");
  return kept.length === 0 ? undefined : kept.join("\n\n");
}

/**
 * Finds `<repo>/.pi/skills/**\/SKILL.md` and `<repo>/.agents/skills/**\/SKILL.md` as Pi does: a directory that holds a
 * SKILL.md is a skill and is not searched further; hidden directories and `node_modules` are skipped; a symlink is not
 * followed (it is neither a file nor a directory here). A file that is not valid is skipped with a log line. Throws when
 * the sandbox cannot be read at all; a missing skills directory is just no skills.
 */
export async function scanRepoSkills(
  env: WorkspaceEnv,
  repoDir: string = REPO_DIR,
): Promise<RepoSkill[]> {
  const budget = { listings: MAX_LISTINGS, files: MAX_FILES };
  const found: FileInfo[] = [];
  for (const dir of REPO_SKILL_DIRS) {
    const root = await realDirectory(env, repoDir, dir);
    if (root !== undefined) await walk(env, root, 0, budget, found);
  }
  const skills: RepoSkill[] = [];
  const names = new Set<string>();
  for (const file of found) {
    const path = file.path;
    const skill = await readSkill(env, file);
    if (typeof skill === "string") {
      log("repo-skill-skipped", { path, why: skill });
      continue;
    }
    if (names.has(skill.name)) continue;
    names.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

/**
 * `<base>/<relative>` when every component of `relative` is a real directory: each is looked up in the listing of its
 * parent, which reports a symlink as a symlink, so a `.pi` or `skills` that points outside the checkout is not entered.
 */
async function realDirectory(
  env: WorkspaceEnv,
  base: string,
  relative: string,
): Promise<string | undefined> {
  let dir = base;
  for (const part of relative.split("/")) {
    const listed = await env.listDir(dir, context);
    if (!listed.ok) {
      if (listed.error.code === "not_found" || listed.error.code === "not_directory")
        return undefined;
      throw listed.error;
    }
    const entry = listed.value.find((item) => item.name === part);
    if (entry === undefined) return undefined;
    if (entry.kind !== "directory") {
      log("repo-skill-skipped", { path: `${dir}/${part}`, why: "not a real directory" });
      return undefined;
    }
    dir = `${dir}/${part}`;
  }
  return dir;
}

/**
 * Reads at most `limit` bytes of a regular file (never following a symlink) and says whether there was more: it asks
 * for `limit + 1` bytes, so a file of any size costs at most that much memory.
 */
async function readBounded(
  env: WorkspaceEnv,
  path: string,
  limit: number,
): Promise<{ text: string; more: boolean } | string> {
  const opened = await env.openBinaryReader(path, { noFollow: true }, context);
  if (!opened.ok) return `unreadable: ${opened.error.message}`;
  try {
    const bytes = await opened.value.read(0, limit + 1, context);
    if (!bytes.ok) return `unreadable: ${bytes.error.message}`;
    const more = bytes.value.length > limit;
    const text = new TextDecoder().decode(more ? bytes.value.subarray(0, limit) : bytes.value);
    // A cut inside a character decodes to U+FFFD at the end: drop it.
    return { text: more ? text.replace(/\uFFFD+$/u, "") : text, more };
  } finally {
    await opened.value.close(context);
  }
}

async function walk(
  env: WorkspaceEnv,
  dir: string,
  depth: number,
  budget: { listings: number; files: number },
  found: FileInfo[],
): Promise<void> {
  if (budget.listings-- <= 0) return;
  const listed = await env.listDir(dir, context);
  if (!listed.ok) {
    // No such directory is the usual case; anything else means the scan cannot be trusted to be complete.
    if (listed.error.code === "not_found" || listed.error.code === "not_directory") return;
    throw listed.error;
  }
  const entries: FileInfo[] = [...listed.value].sort((a, b) => (a.name < b.name ? -1 : 1));
  const own = entries.find((entry) => entry.name === SKILL_ENTRY && entry.kind === "file");
  if (own !== undefined) {
    if (budget.files-- > 0) found.push({ ...own, path: `${dir}/${SKILL_ENTRY}` });
    return;
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (entry.kind !== "directory" || entry.name.startsWith(".") || entry.name === "node_modules")
      continue;
    await walk(env, `${dir}/${entry.name}`, depth + 1, budget, found);
  }
}

async function readSkill(env: WorkspaceEnv, file: FileInfo): Promise<RepoSkill | string> {
  const path = file.path;
  const tooBig = `larger than ${String(SKILL_LIMITS.skillMd)} bytes`;
  // By the listing's size first, so a huge file is never opened; the bounded read covers one that grew since.
  if (file.size > SKILL_LIMITS.skillMd) return tooBig;
  const read = await readBounded(env, path, SKILL_LIMITS.skillMd);
  if (typeof read === "string") return read;
  if (read.more) return tooBig;
  const parsed = parseFrontmatter(read.text);
  if (parsed.kind === "none") return "no frontmatter";
  if (parsed.kind === "error") return parsed.message;
  const description = parsed.fields.get("description")?.trim() ?? "";
  if (description === "") return "no description";
  if (Array.from(description).length > SKILL_LIMITS.description) {
    return `description is longer than ${String(SKILL_LIMITS.description)} characters`;
  }
  if (CONTROL.test(description)) return "description has control characters";
  const directory = path.split("/").slice(-2, -1)[0] ?? "";
  const name = (parsed.fields.get("name") ?? directory).trim();
  if (name === "" || name.length > MAX_NAME || CONTROL.test(name)) return "invalid name";
  const flag = parsed.fields.get("disable-model-invocation");
  if (flag !== undefined && flag !== "true" && flag !== "false") {
    return "disable-model-invocation must be true or false";
  }
  return { name, description, location: path, disableModelInvocation: flag === "true" };
}

/**
 * Admin skills first, then the repo's in scan order; a repo skill whose name is taken is dropped, and the whole list
 * stays within the profile cap (20 skills, 32 KiB of catalog): what does not fit is dropped with a log line.
 */
export function mergeCatalog(
  admin: readonly CatalogEntry[],
  repo: readonly RepoSkill[],
): CatalogEntry[] {
  const merged: CatalogEntry[] = [...admin];
  for (const skill of repo) {
    if (skill.disableModelInvocation) continue;
    if (merged.some((entry) => entry.name === skill.name)) {
      log("repo-skill-skipped", { path: skill.location, why: "name is taken by an earlier skill" });
      continue;
    }
    const entry = { name: skill.name, description: skill.description, location: skill.location };
    if (
      merged.length >= SKILL_LIMITS.perProfile ||
      Buffer.byteLength(buildSkillCatalog([...merged, entry])) > SKILL_LIMITS.catalog
    ) {
      log("repo-skill-skipped", { path: skill.location, why: "the skill catalog is full" });
      continue;
    }
    merged.push(entry);
  }
  return merged;
}
