import { createHash } from "node:crypto";
import type pg from "pg";
import { parseFrontmatter } from "./frontmatter.js";
import { sourceFromColumn, validateSource } from "./source.js";
import type { CatalogSource } from "./source.js";

/**
 * Skills (docs/decisions/0011-skills-in-postgres.md): immutable, numbered versions of a SKILL.md (whose frontmatter
 * gives the description) and optional files, identified by a content digest. This module is the one place that validates a skill (admin input and
 * stored rows alike), the only reader and writer of `inbox.skills`, `inbox.skill_versions` and
 * `inbox.skill_version_files`, and the one that builds the catalog the model sees.
 */

export const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const SKILL_ENTRY = "SKILL.md";
/** Where a session's sandbox gets its skills: `<root>/<name>/<digest>/`. The workspace PVC is a cache of Postgres. */
export const SKILLS_ROOT = "/workspace/.skills";

export const SKILL_LIMITS = {
  /** Characters (code points) of the frontmatter `description`, as in the Agent Skills format. */
  description: 1024,
  skillMd: 32 * 1024,
  files: 128,
  bytes: 5 * 1024 * 1024,
  path: 200,
  /** Skills one profile may name, and the bytes of the catalog they add to the instructions. */
  perProfile: 20,
  catalog: 32 * 1024,
} as const;

/** The admin API's body limit for a version: the file bytes as base64 plus the JSON around them. */
export const SKILL_BODY_LIMIT = Math.ceil((SKILL_LIMITS.bytes * 4) / 3) + 256 * 1024;

/** A path segment: no leading dot (so `.tmp` and the like stay ours), no spaces, nothing a shell would read. */
const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const DIGEST = /^[0-9a-f]{64}$/;
/** Postgres text and jsonb reject NUL, and jsonb the `\udXXX` escape JSON.stringify emits for a lone surrogate. */
const unstorable = (text: string): boolean => text.includes("\u0000") || !text.isWellFormed();
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

export function skillNameError(name: unknown): string | undefined {
  return typeof name === "string" && SKILL_NAME.test(name)
    ? undefined
    : `skill name must match ${SKILL_NAME.source}`;
}

export function isSkillDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}

/** A file of a skill as the manifest lists it. */
export interface SkillFileEntry {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

/** A validated skill, ready to store. */
export interface SkillContent {
  /** From the SKILL.md frontmatter (`name` there, when present, equals the one in the URL). */
  name: string;
  description: string;
  /** `disable-model-invocation: true`: published and pinnable, but not in the catalog the model sees. */
  disableModelInvocation: boolean;
  /** Reserved for a catalog repository sync. Not in the digest: the same files with another source are the same skill. */
  source: CatalogSource | null;
  files: { path: string; content: Buffer; executable: boolean }[];
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/**
 * The digest of a skill: SHA-256 of a canonical JSON of its name, description and files (path, hash, executable bit),
 * sorted by path. The name and description are in it because the model sees them, so two skills that differ only there
 * are different skills.
 */
export function skillDigest(
  name: string,
  description: string,
  files: readonly Pick<SkillFileEntry, "path" | "sha256" | "executable">[],
): string {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => ({ path: file.path, sha256: file.sha256, executable: file.executable }));
  return createHash("sha256")
    .update(JSON.stringify({ v: 1, name, description, files: sorted }))
    .digest("hex");
}

/** A path inside a skill: relative, `/`-separated, plain segments only. A message for a 400, or undefined. */
function pathError(path: unknown): string | undefined {
  if (typeof path !== "string" || path === "" || path.length > SKILL_LIMITS.path) {
    return `file path must be a string of 1 to ${String(SKILL_LIMITS.path)} characters`;
  }
  for (const segment of path.split("/")) {
    if (!SEGMENT.test(segment)) {
      return `file path "${path.slice(0, 80)}" is not a plain relative path (segments match ${SEGMENT.source}; no "..", no absolute paths, no backslashes)`;
    }
  }
  return undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeFileBytes(entry: Record<string, unknown>, path: string): Buffer | string {
  const { content, contentBase64 } = entry;
  if ((content === undefined) === (contentBase64 === undefined)) {
    return `file "${path}": give exactly one of content (text) and contentBase64`;
  }
  if (content !== undefined) {
    if (typeof content !== "string" || unstorable(content)) {
      return `file "${path}": content must be a string without NUL or unpaired surrogates`;
    }
    return Buffer.from(content, "utf8");
  }
  if (
    typeof contentBase64 !== "string" ||
    contentBase64.length % 4 !== 0 ||
    !BASE64.test(contentBase64)
  ) {
    return `file "${path}": contentBase64 must be canonical base64`;
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    return `file "${path}": contentBase64 must be canonical base64`;
  }
  return bytes;
}

/**
 * The one validator for admin input: `{ files: [{ path, content | contentBase64, executable? }], source? }`. The description
 * (required) and optionally the name come from the YAML frontmatter of SKILL.md, so a skill folder is the same in a repo
 * and here; `name` must equal `name` (the URL's) when present. Only regular files can be said, so symlinks, devices and
 * modes other than the executable bit cannot be expressed; any other field, `description` included, is refused.
 * Traversal, absolute paths, duplicates (also differing only in case, or a file that is also a directory) and every
 * limit of `SKILL_LIMITS` are refused. Sizes are bytes (`skillMd`, `bytes`) except the description, which is characters
 * like the format says. Returns the content or the message for a 400.
 */
export function validateSkillContent(input: unknown, name: string): SkillContent | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "body must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key === "description") {
      return `unknown field "description": it is read from the ${SKILL_ENTRY} frontmatter`;
    }
    if (key !== "files" && key !== "source") return `unknown field "${key.slice(0, 50)}"`;
  }
  let source: CatalogSource | null = null;
  if (body.source !== undefined && body.source !== null) {
    const checked = validateSource(body.source);
    if (typeof checked === "string") return checked;
    source = checked;
  }
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0 || files.length > SKILL_LIMITS.files) {
    return `files must be an array of 1 to ${String(SKILL_LIMITS.files)} files`;
  }
  const out: SkillContent["files"] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const raw of files as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "every file must be an object";
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!["path", "content", "contentBase64", "executable"].includes(key)) {
        return `unknown file field "${key.slice(0, 50)}"`;
      }
    }
    const badPath = pathError(entry.path);
    if (badPath !== undefined) return badPath;
    const path = entry.path as string;
    if (seen.has(path.toLowerCase()))
      return `duplicate file "${path}" (paths are compared without case)`;
    seen.add(path.toLowerCase());
    if (entry.executable !== undefined && typeof entry.executable !== "boolean") {
      return `file "${path}": executable must be a boolean`;
    }
    const bytes = decodeFileBytes(entry, path);
    if (typeof bytes === "string") return bytes;
    total += bytes.length;
    if (total > SKILL_LIMITS.bytes) {
      return `a skill may hold at most ${String(SKILL_LIMITS.bytes)} bytes in all`;
    }
    out.push({ path, content: bytes, executable: entry.executable === true });
  }
  // A path that is also a directory of another ("a" and "a/b") cannot be written.
  for (const path of seen) {
    for (const other of seen) {
      if (other.startsWith(`${path}/`)) return `"${path}" is both a file and a directory`;
    }
  }
  const entryFile = out.find((file) => file.path === SKILL_ENTRY);
  if (entryFile === undefined) return `files must include ${SKILL_ENTRY} at the top`;
  if (entryFile.content.length > SKILL_LIMITS.skillMd) {
    return `${SKILL_ENTRY} may hold at most ${String(SKILL_LIMITS.skillMd)} bytes`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(entryFile.content);
  } catch {
    return `${SKILL_ENTRY} must be valid UTF-8`;
  }
  if (text.includes("\u0000")) return `${SKILL_ENTRY} must not contain NUL`;
  const meta = skillMetaFromFrontmatter(text, name);
  if (typeof meta === "string") return meta;
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { name, ...meta, source, files: out };
}

/** The name, description and model-invocation flag of a SKILL.md, or the message for a 400. */
function skillMetaFromFrontmatter(
  text: string,
  name: string,
): Pick<SkillContent, "description" | "disableModelInvocation"> | string {
  const parsed = parseFrontmatter(text);
  if (parsed.kind === "none") {
    return `${SKILL_ENTRY} must start with a YAML frontmatter block (--- lines) that has a description`;
  }
  if (parsed.kind === "error") return `${SKILL_ENTRY}: ${parsed.message}`;
  const declared = parsed.fields.get("name");
  if (declared !== undefined && declared !== name) {
    return `${SKILL_ENTRY} frontmatter name "${declared.slice(0, 80)}" differs from the skill name "${name}" in the path`;
  }
  const description = parsed.fields.get("description");
  if (
    description === undefined ||
    description.trim() === "" ||
    Array.from(description).length > SKILL_LIMITS.description ||
    unstorable(description) ||
    CONTROL.test(description)
  ) {
    return `${SKILL_ENTRY} frontmatter must have a non-empty description of at most ${String(SKILL_LIMITS.description)} characters, on one line, without control characters, NUL or unpaired surrogates`;
  }
  const flag = parsed.fields.get("disable-model-invocation");
  if (flag !== undefined && flag !== "true" && flag !== "false") {
    return `${SKILL_ENTRY} frontmatter disable-model-invocation must be true or false`;
  }
  return { description, disableModelInvocation: flag === "true" };
}

export function manifestOf(content: SkillContent): SkillFileEntry[] {
  return content.files.map((file) => ({
    path: file.path,
    size: file.content.length,
    sha256: sha256(file.content),
    executable: file.executable,
  }));
}

/** What a profile names: an exact version, and the digest it had when the profile was written. */
export interface SkillRef {
  name: string;
  version: number;
  digest?: string;
}

/** The sandbox path of a skill's directory. */
export function skillDir(name: string, digest: string, root: string = SKILLS_ROOT): string {
  return `${root}/${name}/${digest}`;
}

/** The sandbox path of a skill's SKILL.md: what the catalog gives the model to read. */
export function skillLocation(name: string, digest: string, root: string = SKILLS_ROOT): string {
  return `${skillDir(name, digest, root)}/${SKILL_ENTRY}`;
}

/** As Pi's `escapeXml` (earendil-works/pi, packages/coding-agent/src/core/skills.ts). */
const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

/**
 * The catalog appended to a session's instructions, in the wording and `<available_skills>` shape of Pi's
 * `formatSkillsForPrompt` (Pi 1.5.2): name, description and the absolute path of the SKILL.md of each entry, escaped
 * (a description is model input from an operator, reviewed like code; the escaping only keeps one from closing the
 * list). The caller leaves out skills that disable model invocation. The bodies are never in the prompt: the model
 * reads them with the read tool. A new session stores this text with its conversation, so a later version changes no
 * session. `location` is any absolute path, so a repo skill (#71) fits.
 */
export function buildSkillCatalog(
  skills: readonly { name: string; description: string; location: string }[],
): string {
  if (skills.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.location)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

export interface SkillVersionMeta {
  name: string;
  version: number;
  description: string;
  disableModelInvocation: boolean;
  digest: string;
  size: number;
  files: SkillFileEntry[];
  /** Set when the version was published and never changed; null when none was given. */
  source: CatalogSource | null;
  createdAt: Date;
  createdBy: string;
}

export interface SkillBundle extends SkillVersionMeta {
  /** Bytes by path. */
  contents: Map<string, Buffer>;
}

export interface StoredSkill {
  name: string;
  currentVersion: number;
  description: string;
  disableModelInvocation: boolean;
  digest: string;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

type Db = pg.Pool | pg.PoolClient;

interface VersionRow {
  name: string;
  version: number;
  description: string;
  disable_model_invocation: boolean;
  digest: string;
  size_bytes: number;
  manifest: unknown;
  source?: unknown;
  created_at: Date;
  created_by: string;
}

function manifestFromRow(row: VersionRow): SkillFileEntry[] {
  const manifest = row.manifest;
  const bad = (): never => {
    throw new Error(`stored skill ${row.name} v${String(row.version)} has an invalid manifest`);
  };
  if (!Array.isArray(manifest)) return bad();
  return (manifest as unknown[]).map((entry) => {
    const file = entry as Partial<SkillFileEntry> | null;
    if (
      typeof file !== "object" ||
      file === null ||
      typeof file.path !== "string" ||
      pathError(file.path) !== undefined ||
      typeof file.size !== "number" ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      !isSkillDigest(file.sha256) ||
      typeof file.executable !== "boolean"
    ) {
      return bad();
    }
    return { path: file.path, size: file.size, sha256: file.sha256, executable: file.executable };
  });
}

function metaFromRow(row: VersionRow): SkillVersionMeta {
  return {
    name: row.name,
    version: row.version,
    description: row.description,
    disableModelInvocation: row.disable_model_invocation,
    digest: row.digest,
    size: row.size_bytes,
    files: manifestFromRow(row),
    source: sourceFromColumn(row.source),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const VERSION_COLUMNS =
  "name, version, description, disable_model_invocation, digest, size_bytes, manifest, source, created_at, created_by";

/** One version's metadata (no bytes); undefined if there is none. A manifest that does not parse is thrown. */
export async function readSkillVersion(
  db: Db,
  name: string,
  version: number,
): Promise<SkillVersionMeta | undefined> {
  const { rows } = await db.query<VersionRow>(
    `select ${VERSION_COLUMNS} from inbox.skill_versions where name = $1 and version = $2`,
    [name, version],
  );
  return rows[0] === undefined ? undefined : metaFromRow(rows[0]);
}

/** Every version, newest first. */
export async function listSkillVersions(db: Db, name: string): Promise<SkillVersionMeta[]> {
  const { rows } = await db.query<VersionRow>(
    `select ${VERSION_COLUMNS} from inbox.skill_versions where name = $1 order by version desc`,
    [name],
  );
  return rows.map(metaFromRow);
}

/** A version with its bytes. Verify it (`verifySkillBundle`) before use: it is read from a table anyone with SQL can edit. */
export async function readSkillBundle(
  db: Db,
  name: string,
  version: number,
): Promise<SkillBundle | undefined> {
  const meta = await readSkillVersion(db, name, version);
  if (meta === undefined) return undefined;
  const { rows } = await db.query<{ path: string; content: Buffer }>(
    "select path, content from inbox.skill_version_files where name = $1 and version = $2",
    [name, version],
  );
  return { ...meta, contents: new Map(rows.map((row) => [row.path, Buffer.from(row.content)])) };
}

/**
 * Whether a bundle read from Postgres is exactly what was published: the same files as its manifest, each with the
 * recorded size and hash, within the limits, and a digest that recomputes. A message, or undefined when it is intact.
 * The orchestrator refuses anything else, so a corrupt bundle never reaches a sandbox.
 */
export function verifySkillBundle(
  bundle: SkillBundle,
  expectedDigest?: string,
): string | undefined {
  const label = `skill ${bundle.name} v${String(bundle.version)}`;
  if (expectedDigest !== undefined && bundle.digest !== expectedDigest) {
    return `${label} has digest ${bundle.digest}, the profile pinned ${expectedDigest}`;
  }
  if (bundle.files.length === 0 || bundle.files.length > SKILL_LIMITS.files) {
    return `${label} has ${String(bundle.files.length)} files`;
  }
  if (bundle.contents.size !== bundle.files.length)
    return `${label}: files do not match the manifest`;
  let total = 0;
  const paths = new Set<string>();
  for (const file of bundle.files) {
    if (paths.has(file.path)) return `${label}: duplicate path ${file.path}`;
    paths.add(file.path);
    const bytes = bundle.contents.get(file.path);
    if (bytes === undefined) return `${label}: ${file.path} is missing`;
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) {
      return `${label}: ${file.path} does not match its recorded hash`;
    }
    total += bytes.length;
  }
  if (total > SKILL_LIMITS.bytes)
    return `${label} is larger than ${String(SKILL_LIMITS.bytes)} bytes`;
  if (!paths.has(SKILL_ENTRY)) return `${label} has no ${SKILL_ENTRY}`;
  if (skillDigest(bundle.name, bundle.description, bundle.files) !== bundle.digest) {
    return `${label} does not match its digest`;
  }
  return undefined;
}

interface SkillRow extends VersionRow {
  current_version: number;
  s_created_at: Date;
  s_created_by: string;
  s_updated_at: Date;
  s_updated_by: string;
}

function storedFromRow(row: SkillRow): StoredSkill {
  return {
    name: row.name,
    currentVersion: row.current_version,
    description: row.description,
    disableModelInvocation: row.disable_model_invocation,
    digest: row.digest,
    createdAt: row.s_created_at,
    createdBy: row.s_created_by,
    updatedAt: row.s_updated_at,
    updatedBy: row.s_updated_by,
  };
}

const SKILL_SELECT = `select s.name, s.current_version, s.created_at as s_created_at, s.created_by as s_created_by,
       s.updated_at as s_updated_at, s.updated_by as s_updated_by,
       v.version, v.description, v.disable_model_invocation, v.digest, v.size_bytes, v.manifest, v.source, v.created_at, v.created_by
  from inbox.skills s join inbox.skill_versions v on v.name = s.name and v.version = s.current_version`;

/** Every skill at its current version. */
export async function readSkills(db: Db): Promise<StoredSkill[]> {
  const { rows } = await db.query<SkillRow>(`${SKILL_SELECT} order by s.name`);
  return rows.map(storedFromRow);
}

/** One skill at its current version; undefined if there is none. */
export async function readSkill(db: Db, name: string): Promise<StoredSkill | undefined> {
  const { rows } = await db.query<SkillRow>(`${SKILL_SELECT} where s.name = $1`, [name]);
  return rows[0] === undefined ? undefined : storedFromRow(rows[0]);
}

async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type PutSkillResult =
  | { ok: true; version: SkillVersionMeta; created: boolean; skillCreated: boolean }
  | { ok: false; message: string };

/**
 * Publishes a version of a skill from `by`. Identical to the current version (same digest): nothing is written and
 * `created` is false, whatever `source` says (it is not part of the digest, and a stored version never changes). Otherwise the next number is stored with its files; rows are never changed afterwards. One
 * transaction under a lock per name, so two publishers get two different numbers.
 */
export async function putSkillVersion(
  pool: pg.Pool,
  name: string,
  input: unknown,
  by: string,
): Promise<PutSkillResult> {
  const nameError = skillNameError(name);
  if (nameError !== undefined) return { ok: false, message: nameError };
  const content = validateSkillContent(input, name);
  if (typeof content === "string") return { ok: false, message: content };
  const files = manifestOf(content);
  const digest = skillDigest(name, content.description, files);
  const size = files.reduce((sum, file) => sum + file.size, 0);
  return inTransaction(pool, async (client): Promise<PutSkillResult> => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`skill:${name}`]);
    const current = await readSkill(client, name);
    if (current?.digest === digest) {
      const same = await readSkillVersion(client, name, current.currentVersion);
      if (same !== undefined)
        return { ok: true, version: same, created: false, skillCreated: false };
    }
    const version = (current?.currentVersion ?? 0) + 1;
    if (current === undefined) {
      await client.query(
        "insert into inbox.skills (name, current_version, created_by, updated_by) values ($1, 1, $2, $2)",
        [name, by],
      );
    }
    await client.query(
      `insert into inbox.skill_versions (name, version, description, disable_model_invocation, digest, size_bytes, manifest, created_by, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        name,
        version,
        content.description,
        content.disableModelInvocation,
        digest,
        size,
        JSON.stringify(files),
        by,
        content.source === null ? null : JSON.stringify(content.source),
      ],
    );
    for (const file of content.files) {
      await client.query(
        "insert into inbox.skill_version_files (name, version, path, content) values ($1, $2, $3, $4)",
        [name, version, file.path, file.content],
      );
    }
    if (current !== undefined) {
      await client.query(
        `update inbox.skills set current_version = $2, updated_at = clock_timestamp(), updated_by = $3
          where name = $1`,
        [name, version, by],
      );
    }
    const stored = await readSkillVersion(client, name, version);
    if (stored === undefined)
      throw new Error(`skill ${name} v${String(version)} vanished inside its transaction`);
    return { ok: true, version: stored, created: true, skillCreated: current === undefined };
  });
}

/**
 * Resolves the skills a profile names against what is published: each exact version must exist, a digest that was
 * given must match, and the catalog the set adds to the instructions must fit. Returns the refs with the digests filled
 * in (what the profile stores and a session snapshots), or the message for a 400. Skills that disable model invocation
 * are not in the catalog, so they do not count against its size.
 */
export async function pinSkillRefs(
  db: Db,
  refs: readonly SkillRef[],
): Promise<{ refs: (SkillRef & { digest: string })[] } | string> {
  const pinned: (SkillRef & { digest: string })[] = [];
  const catalog: { name: string; description: string; location: string }[] = [];
  for (const ref of refs) {
    const meta = await readSkillVersion(db, ref.name, ref.version);
    if (meta === undefined)
      return `skills: "${ref.name}" version ${String(ref.version)} does not exist`;
    if (ref.digest !== undefined && ref.digest !== meta.digest) {
      return `skills: "${ref.name}" version ${String(ref.version)} has digest ${meta.digest}, not ${ref.digest}`;
    }
    pinned.push({ name: ref.name, version: ref.version, digest: meta.digest });
    if (!meta.disableModelInvocation) {
      catalog.push({
        name: ref.name,
        description: meta.description,
        location: skillLocation(ref.name, meta.digest),
      });
    }
  }
  if (Buffer.byteLength(buildSkillCatalog(catalog)) > SKILL_LIMITS.catalog) {
    return `skills: the catalog of these skills is larger than ${String(SKILL_LIMITS.catalog)} bytes`;
  }
  return { refs: pinned };
}
