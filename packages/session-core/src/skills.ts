import { createHash } from "node:crypto";
import type pg from "pg";

/**
 * Skills (docs/decisions/0011-skills-in-postgres.md): immutable, numbered versions of a description, a SKILL.md and
 * optional files, identified by a content digest. This module is the one place that validates a skill (admin input and
 * stored rows alike), the only reader and writer of `inbox.skills`, `inbox.skill_versions` and
 * `inbox.skill_version_files`, and the one that builds the catalog the model sees.
 */

export const SKILL_NAME = /^[a-z][a-z0-9-]{0,63}$/;
export const SKILL_ENTRY = "SKILL.md";
/** Where a session's sandbox gets its skills: `<root>/<name>/<digest>/`. The workspace PVC is a cache of Postgres. */
export const SKILLS_ROOT = "/workspace/.skills";

export const SKILL_LIMITS = {
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
  description: string;
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
 * The one validator for admin input: `{ description, files: [{ path, content | contentBase64, executable? }] }`. Only
 * regular files can be said, so symlinks, devices and modes other than the executable bit cannot be expressed; any
 * other field is refused. Traversal, absolute paths, duplicates (also differing only in case, or a file that is also a
 * directory) and every limit of `SKILL_LIMITS` are refused. Returns the content or the message for a 400.
 */
export function validateSkillContent(input: unknown): SkillContent | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "body must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key !== "description" && key !== "files") return `unknown field "${key.slice(0, 50)}"`;
  }
  const { description } = body;
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    description.length > SKILL_LIMITS.description ||
    unstorable(description) ||
    CONTROL.test(description)
  ) {
    return `description must be a one-line string of 1 to ${String(SKILL_LIMITS.description)} characters, without control characters, NUL or unpaired surrogates`;
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
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(entryFile.content);
    if (text.includes("\u0000")) return `${SKILL_ENTRY} must not contain NUL`;
  } catch {
    return `${SKILL_ENTRY} must be valid UTF-8`;
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { description, files: out };
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

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The catalog appended to a session's instructions: name, description and the path of the SKILL.md of each selected
 * skill, escaped (a description is model input from an operator, reviewed like code; the escaping only keeps one
 * from closing the list). The bodies are never in the prompt: the model reads them from the sandbox. A new session
 * stores this text with its conversation, so a later version changes no session.
 */
export function buildSkillCatalog(
  skills: readonly { name: string; description: string; digest: string }[],
  root: string = SKILLS_ROOT,
): string {
  if (skills.length === 0) return "";
  const entries = skills.map(
    (skill) =>
      `<skill>\n<name>${escapeXml(skill.name)}</name>\n<description>${escapeXml(skill.description)}</description>\n<location>${escapeXml(
        `${skillDir(skill.name, skill.digest, root)}/${SKILL_ENTRY}`,
      )}</location>\n</skill>`,
  );
  return [
    "## Skills",
    "",
    `A skill is a folder with a ${SKILL_ENTRY} (instructions) and optional scripts and resources. When a task matches a skill's description, read its ${SKILL_ENTRY} with the read tool before you act, and follow it. Paths inside a skill are relative to its folder. Only the list below is available.`,
    "",
    "<available_skills>",
    ...entries,
    "</available_skills>",
  ].join("\n");
}

export interface SkillVersionMeta {
  name: string;
  version: number;
  description: string;
  digest: string;
  size: number;
  files: SkillFileEntry[];
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
  digest: string;
  size_bytes: number;
  manifest: unknown;
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
    digest: row.digest,
    size: row.size_bytes,
    files: manifestFromRow(row),
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

const VERSION_COLUMNS =
  "name, version, description, digest, size_bytes, manifest, created_at, created_by";

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
    digest: row.digest,
    createdAt: row.s_created_at,
    createdBy: row.s_created_by,
    updatedAt: row.s_updated_at,
    updatedBy: row.s_updated_by,
  };
}

const SKILL_SELECT = `select s.name, s.current_version, s.created_at as s_created_at, s.created_by as s_created_by,
       s.updated_at as s_updated_at, s.updated_by as s_updated_by,
       v.version, v.description, v.digest, v.size_bytes, v.manifest, v.created_at, v.created_by
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
 * `created` is false. Otherwise the next number is stored with its files; rows are never changed afterwards. One
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
  const content = validateSkillContent(input);
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
      `insert into inbox.skill_versions (name, version, description, digest, size_bytes, manifest, created_by)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [name, version, content.description, digest, size, JSON.stringify(files), by],
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
 * in (what the profile stores and a session snapshots) and the descriptions, or the message for a 400.
 */
export async function pinSkillRefs(
  db: Db,
  refs: readonly SkillRef[],
): Promise<{ refs: (SkillRef & { digest: string })[]; descriptions: string[] } | string> {
  const pinned: (SkillRef & { digest: string })[] = [];
  const catalog: { name: string; description: string; digest: string }[] = [];
  for (const ref of refs) {
    const meta = await readSkillVersion(db, ref.name, ref.version);
    if (meta === undefined)
      return `skills: "${ref.name}" version ${String(ref.version)} does not exist`;
    if (ref.digest !== undefined && ref.digest !== meta.digest) {
      return `skills: "${ref.name}" version ${String(ref.version)} has digest ${meta.digest}, not ${ref.digest}`;
    }
    pinned.push({ name: ref.name, version: ref.version, digest: meta.digest });
    catalog.push({ name: ref.name, description: meta.description, digest: meta.digest });
  }
  if (Buffer.byteLength(buildSkillCatalog(catalog)) > SKILL_LIMITS.catalog) {
    return `skills: the catalog of these skills is larger than ${String(SKILL_LIMITS.catalog)} bytes`;
  }
  return { refs: pinned, descriptions: catalog.map((entry) => entry.description) };
}
