import type pg from "pg";
import { MCP_SERVER_NAME } from "./mcp-servers.js";
import { parseModelKey, parseThinkingLevel, THINKING_LEVELS, modelKey } from "./models.js";
import type { ThinkingLevel } from "./models.js";
import { isSkillDigest, pinSkillRefs, SKILL_LIMITS, SKILL_NAME } from "./skills.js";
import type { SkillRef } from "./skills.js";
import { AdminConflictError, checkRevision } from "./revision.js";

/**
 * Session profiles (docs/decisions/0010-session-profiles.md): named, versioned definitions of what a session gets.
 * This module is the one place that validates a definition (admin writes and stored rows alike) and the only reader and
 * writer of `inbox.profiles`, `inbox.profile_versions` and `inbox.orchestrator_capabilities`.
 */

export const PROFILE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
/** The profile a session without a stored one runs as: today's behaviour (every coding tool, no MCP). */
export const LEGACY_PROFILE = { name: "coding", version: 1 } as const;
export const DEFAULT_PROFILE_NAME = "coding";
/** Transaction lock key shared by the writes that choose the default profile and the ones that disable a profile. */
export const DEFAULT_PROFILE_LOCK = "settings:default-profile";

/**
 * The coding tools the orchestrator installs. Used to validate tool names only while the orchestrator has not published
 * what it really has (`inbox.orchestrator_capabilities`); a test in the orchestrator keeps it equal to Pi Durable's.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = ["read", "write", "edit", "bash"];

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_LIST = 32;
const MAX_INSTRUCTIONS = 8_000;
const MAX_TURN_BUDGET = 1_000_000;
const MAX_MODEL = 200;
/** Postgres text and jsonb reject NUL, and jsonb the `\udXXX` escape JSON.stringify emits for a lone surrogate. */
const unstorable = (text: string): boolean => text.includes("\u0000") || !text.isWellFormed();

const KEYS = [
  "tools",
  "modelTools",
  "instructions",
  "defaultModel",
  "reasoning",
  "turnBudget",
  "mcpServers",
  "skills",
  "repoSkills",
  "repoContext",
] as const;

/**
 * What a profile decides. Every field is optional; an absent field means "as without profiles": all coding tools, all
 * of them offered, no extra instructions, the settings' model, reasoning and turn budget, no MCP. This is also the wire
 * shape of the admin API.
 */
export interface ProfileDefinition {
  /** Coding tools enabled for the session (a subset of the installed ones); absent: all. */
  tools?: string[];
  /** Of the enabled tools, the ones offered to the model (a subset of `tools`); absent: all enabled. */
  modelTools?: string[];
  /** Added to the system prompt, after the extensions' sections. */
  instructions?: string;
  /** `provider/model`; used when the request names no model. Must be on the allowlist when a session is created. */
  defaultModel?: string;
  /** Used when the request names no reasoning. Must not exceed `maxReasoning` when a session is created. */
  reasoning?: ThinkingLevel;
  /** Model turns the session may use in total; replaces the settings' budget. */
  turnBudget?: number;
  /** Names of MCP catalog servers the session gets (`mcp-<name>` extensions plus `tool_search`); absent: none. */
  mcpServers?: string[];
  /**
   * Skills the session gets (docs/decisions/0011-skills-in-postgres.md), each an exact version. An admin write fills in
   * `digest` (what the version's content hashes to), so a stored definition and a session's snapshot pin the content,
   * not just a number. A session's catalog lists them and its sandbox gets their files; absent: none.
   */
  skills?: SkillRef[];
  /**
   * Add the skills found in the session's cloned repo (`.pi/skills`, `.agents/skills`) to its catalog
   * (docs/decisions/0014-repo-skills.md). Absent: off. Ignored for a session without a repo. Needs `read`.
   */
  repoSkills?: boolean;
  /**
   * Add the repo's own context file (`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` or `CLAUDE.MD`, the
   * first found, at the checkout root) to the session's instructions as project instructions
   * (docs/decisions/0015-repo-context.md). Absent: off. Ignored for a session without a repo.
   */
  repoContext?: boolean;
}

export interface ProfileRef {
  name: string;
  version: number;
}

export function profileNameError(name: unknown): string | undefined {
  return typeof name === "string" && PROFILE_NAME.test(name)
    ? undefined
    : `profile name must match ${PROFILE_NAME.source}`;
}

function nameList(field: string, value: unknown, pattern: RegExp, what: string): string[] | string {
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    return `${field} must be an array of at most ${String(MAX_LIST)} ${what} names`;
  }
  const names: string[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "string" || !pattern.test(entry)) {
      return `${field} must contain only ${what} names (${pattern.source})`;
    }
    if (!names.includes(entry)) names.push(entry);
  }
  return names;
}

/**
 * The one validator. Shape only: the names are checked against reality separately (`checkProfileNames`), because what
 * exists changes while a stored definition stays. Returns the normalised definition (fixed key order, duplicates
 * dropped, the model as `provider/model`) or the message for a 400. Normalising is idempotent, so what an admin write
 * stores is what a read validates to the same value.
 */
export function validateProfileDefinition(input: unknown): ProfileDefinition | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "definition must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(KEYS as readonly string[]).includes(key)) return `unknown field "${key.slice(0, 50)}"`;
  }
  const definition: ProfileDefinition = {};
  if (body.tools !== undefined) {
    const tools = nameList("tools", body.tools, TOOL_NAME, "tool");
    if (typeof tools === "string") return tools;
    definition.tools = tools;
  }
  if (body.modelTools !== undefined) {
    const modelTools = nameList("modelTools", body.modelTools, TOOL_NAME, "tool");
    if (typeof modelTools === "string") return modelTools;
    if (definition.tools !== undefined) {
      const enabled = definition.tools;
      const outside = modelTools.find((name) => !enabled.includes(name));
      if (outside !== undefined) return `modelTools "${outside}" is not in tools`;
    }
    definition.modelTools = modelTools;
  }
  if (body.instructions !== undefined) {
    const text = body.instructions;
    if (
      typeof text !== "string" ||
      text.trim() === "" ||
      text.length > MAX_INSTRUCTIONS ||
      unstorable(text)
    ) {
      return `instructions must be a non-empty string of at most ${String(MAX_INSTRUCTIONS)} characters, without NUL or unpaired surrogates`;
    }
    definition.instructions = text;
  }
  if (body.defaultModel !== undefined) {
    const text = body.defaultModel;
    if (typeof text !== "string" || text.length > MAX_MODEL || unstorable(text)) {
      return "defaultModel must be a provider/model string";
    }
    try {
      definition.defaultModel = modelKey(parseModelKey(text));
    } catch {
      return `defaultModel "${text.slice(0, 80)}" is not provider/model`;
    }
  }
  if (body.reasoning !== undefined) {
    const level = parseThinkingLevel(body.reasoning);
    if (level === undefined) return `reasoning must be one of ${THINKING_LEVELS.join(", ")}`;
    definition.reasoning = level;
  }
  if (body.turnBudget !== undefined) {
    const budget = body.turnBudget;
    if (
      typeof budget !== "number" ||
      !Number.isInteger(budget) ||
      budget < 1 ||
      budget > MAX_TURN_BUDGET
    ) {
      return `turnBudget must be an integer from 1 to ${String(MAX_TURN_BUDGET)}`;
    }
    definition.turnBudget = budget;
  }
  if (body.mcpServers !== undefined) {
    const servers = nameList("mcpServers", body.mcpServers, MCP_SERVER_NAME, "MCP server");
    if (typeof servers === "string") return servers;
    definition.mcpServers = servers;
  }
  if (body.skills !== undefined) {
    const skills = skillRefs(body.skills);
    if (typeof skills === "string") return skills;
    if (skills.length > 0) {
      // The model loads a skill by reading its SKILL.md, so a profile that offers skills must offer `read`.
      for (const field of ["tools", "modelTools"] as const) {
        if (definition[field] !== undefined && !definition[field].includes("read")) {
          return `skills need the read tool, but ${field} does not include it`;
        }
      }
      definition.skills = skills;
    }
  }
  if (body.repoSkills !== undefined) {
    if (typeof body.repoSkills !== "boolean") return "repoSkills must be true or false";
    if (body.repoSkills) {
      // Like skills: the model loads a repo skill by reading its SKILL.md.
      for (const field of ["tools", "modelTools"] as const) {
        if (definition[field] !== undefined && !definition[field].includes("read")) {
          return `repoSkills needs the read tool, but ${field} does not include it`;
        }
      }
    }
    definition.repoSkills = body.repoSkills;
  }
  if (body.repoContext !== undefined) {
    if (typeof body.repoContext !== "boolean") return "repoContext must be true or false";
    definition.repoContext = body.repoContext;
  }
  return ordered(definition);
}

/** Fixed key order, so equal definitions serialise equally whatever order the body had. */
function ordered(definition: ProfileDefinition): ProfileDefinition {
  return Object.fromEntries(
    KEYS.flatMap((key) => (definition[key] === undefined ? [] : [[key, definition[key]]])),
  );
}

function skillRefs(value: unknown): SkillRef[] | string {
  if (!Array.isArray(value) || value.length > SKILL_LIMITS.perProfile) {
    return `skills must be an array of at most ${String(SKILL_LIMITS.perProfile)} { name, version } entries`;
  }
  const refs: SkillRef[] = [];
  for (const raw of value as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return "every skills entry must be an object { name, version }";
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key !== "name" && key !== "version" && key !== "digest") {
        return `unknown skills field "${key.slice(0, 50)}"`;
      }
    }
    const { name, version, digest } = entry;
    if (typeof name !== "string" || !SKILL_NAME.test(name)) {
      return `skills names must match ${SKILL_NAME.source}`;
    }
    if (
      typeof version !== "number" ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 1_000_000
    ) {
      return `skills "${name}": version must be a positive integer`;
    }
    if (digest !== undefined && !isSkillDigest(digest)) {
      return `skills "${name}": digest must be 64 lowercase hex characters`;
    }
    if (refs.some((ref) => ref.name === name))
      return `skills names "${name}" twice: one version per skill`;
    refs.push(digest === undefined ? { name, version } : { name, version, digest });
  }
  return refs;
}

export function profileDefinitionsEqual(a: ProfileDefinition, b: ProfileDefinition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Checks the names of a definition against what exists at write time: tools against the orchestrator's installed coding
 * tools, MCP servers against the catalog (enabled or not: disabling a server is an operator's temporary state). A
 * message for a 400, or undefined.
 */
export function checkProfileNames(
  definition: ProfileDefinition,
  known: { tools: readonly string[]; mcpServers: readonly string[] },
): string | undefined {
  for (const field of ["tools", "modelTools"] as const) {
    const unknown = definition[field]?.find((name) => !known.tools.includes(name));
    if (unknown !== undefined) {
      return `${field}: "${unknown}" is not an installed tool (installed: ${known.tools.join(", ")})`;
    }
  }
  const missing = definition.mcpServers?.find((name) => !known.mcpServers.includes(name));
  if (missing !== undefined) return `mcpServers: "${missing}" is not in the MCP catalog`;
  return undefined;
}

export interface StoredProfile {
  name: string;
  currentVersion: number;
  /** Counts the writes, enable and disable included (they add no version); the next write's `expectedRevision`. */
  revision: number;
  enabledForNew: boolean;
  definition: ProfileDefinition;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface ProfileVersion {
  version: number;
  definition: ProfileDefinition;
  createdAt: Date;
  createdBy: string;
}

interface ProfileRow {
  name: string;
  current_version: number;
  revision: number;
  enabled_for_new: boolean;
  definition: unknown;
  created_at: Date;
  created_by: string;
  updated_at: Date;
  updated_by: string;
}

const PROFILE_COLUMNS =
  "p.name, p.current_version, p.revision, p.enabled_for_new, v.definition, p.created_at, p.created_by, p.updated_at, p.updated_by";
const PROFILE_FROM =
  "from inbox.profiles p join inbox.profile_versions v on v.name = p.name and v.version = p.current_version";

/** A stored row, validated like input: a bad one throws and is never used. */
function fromRow(row: ProfileRow): StoredProfile {
  const definition = validateProfileDefinition(row.definition);
  if (typeof definition === "string") {
    throw new Error(`stored profile ${row.name} is invalid: ${definition}`);
  }
  return {
    name: row.name,
    currentVersion: row.current_version,
    revision: row.revision,
    enabledForNew: row.enabled_for_new,
    definition,
    createdAt: row.created_at,
    createdBy: row.created_by,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

type Db = pg.Pool | pg.PoolClient;

export interface ProfileCatalog {
  profiles: StoredProfile[];
  /** Profiles whose current version the validator rejects (edited by hand): skipped, so one never hides the others. */
  invalid: { name: string; message: string }[];
}

export async function readProfiles(db: Db): Promise<ProfileCatalog> {
  const { rows } = await db.query<ProfileRow>(
    `select ${PROFILE_COLUMNS} ${PROFILE_FROM} order by p.name`,
  );
  const catalog: ProfileCatalog = { profiles: [], invalid: [] };
  for (const row of rows) {
    try {
      catalog.profiles.push(fromRow(row));
    } catch (error) {
      catalog.invalid.push({
        name: row.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return catalog;
}

/** One profile at its current version: undefined if there is none, thrown if the stored definition is invalid. */
export async function readProfile(db: Db, name: string): Promise<StoredProfile | undefined> {
  const { rows } = await db.query<ProfileRow>(
    `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.name = $1`,
    [name],
  );
  return rows[0] === undefined ? undefined : fromRow(rows[0]);
}

/** Every version, newest first. Versions that no longer validate are returned with the message instead. */
export async function listProfileVersions(
  db: Db,
  name: string,
): Promise<(ProfileVersion & { invalid?: string })[]> {
  const { rows } = await db.query<{
    version: number;
    definition: unknown;
    created_at: Date;
    created_by: string;
  }>(
    "select version, definition, created_at, created_by from inbox.profile_versions where name = $1 order by version desc",
    [name],
  );
  return rows.map((row) => {
    const definition = validateProfileDefinition(row.definition);
    const base = {
      version: row.version,
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
    return typeof definition === "string"
      ? { ...base, definition: {}, invalid: definition }
      : { ...base, definition };
  });
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

export type PutProfileResult =
  | { ok: true; stored: StoredProfile; created: boolean; versionCreated: boolean }
  | { ok: false; message: string };

export interface PutProfileInput {
  /** Required to create; a changed one makes a new version, an identical one writes nothing. */
  definition?: unknown;
  /** Default true on create; a change is written to the profile row (versions are untouched). */
  enabledForNew?: unknown;
  /** The revision the caller saw; any other (or none stored) throws `AdminConflictError` and writes nothing. */
  expectedRevision?: number;
}

/**
 * Creates a profile or updates it from `by`. A changed definition is a new version (the old rows stay, immutable); an
 * identical one is a no-op. `known` is what the names are checked against, only when a new version would be written.
 * One transaction under a lock per name. Disabling the settings' default profile throws `AdminConflictError`: the
 * check runs under `DEFAULT_PROFILE_LOCK`, the lock `updateSettings` holds while it checks a new default
 * (docs/decisions/0023-admin-revisions.md).
 */
export async function putProfile(
  pool: pg.Pool,
  name: string,
  input: PutProfileInput,
  by: string,
  known: { tools: readonly string[]; mcpServers: readonly string[] },
): Promise<PutProfileResult> {
  const nameError = profileNameError(name);
  if (nameError !== undefined) return { ok: false, message: nameError };
  if (input.enabledForNew !== undefined && typeof input.enabledForNew !== "boolean") {
    return { ok: false, message: "enabledForNew must be a boolean" };
  }
  if (input.definition === undefined && input.enabledForNew === undefined) {
    return { ok: false, message: "body must have definition, enabledForNew or both" };
  }
  let definition: ProfileDefinition | undefined;
  if (input.definition !== undefined) {
    const checked = validateProfileDefinition(input.definition);
    if (typeof checked === "string") return { ok: false, message: checked };
    definition = checked;
  }
  return inTransaction(pool, async (client): Promise<PutProfileResult> => {
    // Serialises writers per name, also for a create (no row to lock yet).
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`profile:${name}`]);
    // Always in this order (profile, then default), and `updateSettings` takes only the second: no cycle.
    if (input.enabledForNew === false) {
      await client.query("select pg_advisory_xact_lock(hashtext($1))", [DEFAULT_PROFILE_LOCK]);
    }
    if (definition?.skills !== undefined) {
      // Skill versions are immutable, so the digests filled in here stay true: the stored definition pins content.
      const pinned = await pinSkillRefs(client, definition.skills);
      if (typeof pinned === "string") return { ok: false, message: pinned };
      definition = ordered({ ...definition, skills: pinned.refs });
    }
    const { rows } = await client.query<ProfileRow>(
      `select ${PROFILE_COLUMNS} ${PROFILE_FROM} where p.name = $1`,
      [name],
    );
    checkRevision(`profile ${name}`, input.expectedRevision, rows[0]?.revision);
    let current: StoredProfile | undefined;
    try {
      current = rows[0] === undefined ? undefined : fromRow(rows[0]);
    } catch {
      // A current version edited by hand into something invalid: a new complete definition replaces it.
      current = undefined;
    }
    const exists = rows[0] !== undefined;
    if (!exists) {
      if (definition === undefined) return { ok: false, message: "definition is required" };
      const unknown = checkProfileNames(definition, known);
      if (unknown !== undefined) return { ok: false, message: unknown };
      const enabled = input.enabledForNew ?? true;
      await client.query(
        `insert into inbox.profiles (name, current_version, enabled_for_new, created_by, updated_by)
         values ($1, 1, $2, $3, $3)`,
        [name, enabled, by],
      );
      await client.query(
        "insert into inbox.profile_versions (name, version, definition, created_by) values ($1, $2, $3, $4)",
        [name, 1, JSON.stringify(definition), by],
      );
      return { ok: true, stored: await readOne(client, name), created: true, versionCreated: true };
    }
    let version = Number(rows[0]?.current_version);
    let versionCreated = false;
    if (
      definition !== undefined &&
      (current === undefined || !sameDefinition(current, definition))
    ) {
      const unknown = checkProfileNames(definition, known);
      if (unknown !== undefined) return { ok: false, message: unknown };
      version += 1;
      versionCreated = true;
      await client.query(
        "insert into inbox.profile_versions (name, version, definition, created_by) values ($1, $2, $3, $4)",
        [name, version, JSON.stringify(definition), by],
      );
    }
    // Checked to be a boolean at the top of the function.
    const enabled =
      (input.enabledForNew as boolean | undefined) ?? rows[0]?.enabled_for_new ?? true;
    if (!enabled && rows[0]?.enabled_for_new === true) {
      const { rows: chosen } = await client.query<{ default_profile: string | null }>(
        "select default_profile from inbox.settings",
      );
      const defaultName =
        chosen[0] === undefined ? undefined : (chosen[0].default_profile ?? DEFAULT_PROFILE_NAME);
      if (defaultName === name) {
        throw new AdminConflictError(
          `profile "${name}" is the default profile for new sessions: select another enabled profile as the default first`,
        );
      }
    }
    if (versionCreated || enabled !== rows[0]?.enabled_for_new) {
      await client.query(
        `update inbox.profiles set current_version = $2, enabled_for_new = $3, revision = revision + 1,
           updated_at = clock_timestamp(), updated_by = $4 where name = $1`,
        [name, version, enabled, by],
      );
    }
    return {
      ok: true,
      stored: await readOne(client, name),
      created: false,
      versionCreated,
    };
  });
}

function sameDefinition(current: StoredProfile, next: ProfileDefinition): boolean {
  return profileDefinitionsEqual(current.definition, next);
}

async function readOne(client: pg.PoolClient, name: string): Promise<StoredProfile> {
  const stored = await readProfile(client, name);
  if (stored === undefined) throw new Error(`profile ${name} vanished inside its transaction`);
  return stored;
}

/** What a session stores of its profile at creation. */
export interface ProfileSnapshot extends ProfileRef {
  definition: ProfileDefinition;
}

export interface Capabilities {
  /** Names of the installed coding tools. */
  tools: string[];
  /** Names of the installed extensions (without the per-server `mcp-*` ones). */
  extensions: string[];
}

/** The orchestrator's start: what it has installed, for ingest to validate profile writes against. */
export async function publishCapabilities(
  pool: pg.Pool,
  capabilities: Capabilities,
  instance: string,
): Promise<void> {
  await pool.query(
    `insert into inbox.orchestrator_capabilities (tools, extensions, instance)
     values ($1, $2, $3)
     on conflict (id) do update set tools = excluded.tools, extensions = excluded.extensions,
       instance = excluded.instance, updated_at = clock_timestamp()`,
    [JSON.stringify(capabilities.tools), JSON.stringify(capabilities.extensions), instance],
  );
}

/** What the orchestrator published; undefined if it never started against this database. */
export async function readCapabilities(db: Db): Promise<Capabilities | undefined> {
  const { rows } = await db.query<{ tools: unknown; extensions: unknown }>(
    "select tools, extensions from inbox.orchestrator_capabilities",
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  return { tools: strings(row.tools), extensions: strings(row.extensions) };
}
