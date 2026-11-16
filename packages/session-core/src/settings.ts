import type pg from "pg";
import {
  exceedsReasoning,
  loadModelPolicy,
  modelKey,
  parseModelKey,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "./models.js";
import type { ModelPolicy, ThinkingLevel } from "./models.js";

/** Notification channel a writer signals on, in the same transaction as the write. */
export const SETTINGS_CHANNEL = "pi_settings";

/**
 * The settings every process reads (docs/decisions/0008-settings-in-postgres.md). This is also the wire shape of the
 * admin API, so a GET can be edited and PUT back.
 */
export interface Settings {
  /** `provider/model`. */
  defaultModel: string;
  /** `provider/model` pairs, the default included and first. */
  allowlist: string[];
  /** Reasoning effort applied to every new session; null for none (Pi's default, `off`). */
  reasoning: ThinkingLevel | null;
  /** Highest reasoning effort a session request may ask for; null for no cap. */
  maxReasoning: ThinkingLevel | null;
  /** Model turns one session may use in total. */
  turnBudget: number;
}

export interface StoredSettings {
  settings: Settings;
  updatedAt: Date;
  updatedBy: string;
}

export interface SettingsHistoryEntry {
  id: string;
  changedAt: Date;
  changedBy: string;
  old: Settings | null;
  new: Settings;
}

const KEYS = ["defaultModel", "allowlist", "reasoning", "maxReasoning", "turnBudget"] as const;
const MAX_ALLOWLIST = 100;
const MAX_ENTRY = 200;
/** Bound on what is parsed; the real limit applies to the normalised list (default added, duplicates dropped). */
const MAX_INPUT_ALLOWLIST = 1_000;
const MAX_TURN_BUDGET = 1_000_000;
const DEFAULT_TURN_BUDGET = 100;

/** The settings the environment describes (`PI_MODEL_*`, `PI_SESSION_TURN_BUDGET`): the seed, never read again after. */
export function settingsFromEnv(env: Readonly<Record<string, string | undefined>>): Settings {
  const policy = loadModelPolicy(env);
  const turnBudget = Number(env.PI_SESSION_TURN_BUDGET ?? String(DEFAULT_TURN_BUDGET));
  if (!Number.isInteger(turnBudget) || turnBudget < 1) {
    throw new Error("PI_SESSION_TURN_BUDGET must be an integer of 1 or more");
  }
  // The same rules as stored settings, so an env that would never be readable back fails at start, before anything
  // is written.
  const settings = validateSettings({
    defaultModel: modelKey(policy.default),
    allowlist: policy.allowed.map(modelKey),
    reasoning: policy.reasoning ?? null,
    maxReasoning: null,
    turnBudget,
  });
  if (typeof settings === "string")
    throw new Error(`invalid model settings in the environment: ${settings}`);
  return settings;
}

/** The model policy ingest checks `POST /sessions` against. */
export function policyOf(settings: Settings): ModelPolicy {
  const reasoning = settings.reasoning ?? undefined;
  const withReasoning = reasoning === undefined ? {} : { reasoning };
  const maxReasoning = settings.maxReasoning ?? undefined;
  return {
    ...(maxReasoning === undefined ? {} : { maxReasoning }),
    default: { ...parseModelKey(settings.defaultModel), ...withReasoning },
    allowed: settings.allowlist.map(parseModelKey),
    ...withReasoning,
  };
}

/**
 * Validates a full settings object, or a partial one laid over `current`. Returns the normalised settings (the
 * default is first in the allowlist, duplicates dropped) or the message for a 400.
 */
export function validateSettings(input: unknown, current?: Settings): Settings | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "settings must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(KEYS as readonly string[]).includes(key)) return `unknown setting "${key.slice(0, 50)}"`;
  }
  // A missing cap is no cap: older clients and rows predate the field.
  const pick = (key: (typeof KEYS)[number]): unknown => {
    const value = key in body ? body[key] : current?.[key];
    return key === "maxReasoning" && value === undefined ? null : value;
  };
  const pickLevel = (key: "reasoning" | "maxReasoning"): ThinkingLevel | null | "invalid" => {
    const value = pick(key);
    if (value === null) return null;
    return parseThinkingLevel(value) ?? "invalid";
  };
  const missing = KEYS.find((key) => pick(key) === undefined);
  if (missing !== undefined) return `${missing} is required`;

  const defaultText = pick("defaultModel");
  if (typeof defaultText !== "string") return "defaultModel must be a string provider/model";
  const listText = pick("allowlist");
  if (
    !Array.isArray(listText) ||
    listText.length > MAX_INPUT_ALLOWLIST ||
    !listText.every((entry): entry is string => typeof entry === "string")
  ) {
    return `allowlist must be an array of at most ${String(MAX_ALLOWLIST)} provider/model strings`;
  }
  const reasoning = pickLevel("reasoning");
  if (reasoning === "invalid")
    return `reasoning must be null or one of ${THINKING_LEVELS.join(", ")}`;
  const maxReasoning = pickLevel("maxReasoning");
  if (maxReasoning === "invalid") {
    return `maxReasoning must be null or one of ${THINKING_LEVELS.join(", ")}`;
  }
  if (reasoning !== null && maxReasoning !== null && exceedsReasoning(reasoning, maxReasoning)) {
    return `reasoning ${reasoning} is above maxReasoning ${maxReasoning}`;
  }
  const turnBudget = pick("turnBudget");
  if (
    typeof turnBudget !== "number" ||
    !Number.isInteger(turnBudget) ||
    turnBudget < 1 ||
    turnBudget > MAX_TURN_BUDGET
  ) {
    return `turnBudget must be an integer from 1 to ${String(MAX_TURN_BUDGET)}`;
  }

  const keys: string[] = [];
  for (const entry of [defaultText, ...listText]) {
    try {
      if (entry.length > MAX_ENTRY) throw new Error("too long");
      keys.push(modelKey(parseModelKey(entry)));
    } catch {
      return `model "${entry.slice(0, 80)}" is not provider/model`;
    }
  }
  const allowlist = [...new Set(keys)];
  if (allowlist.length > MAX_ALLOWLIST) {
    return `allowlist (with the default model) must have at most ${String(MAX_ALLOWLIST)} distinct provider/model entries`;
  }
  return {
    defaultModel: keys[0] ?? defaultText,
    allowlist,
    reasoning,
    maxReasoning,
    turnBudget,
  };
}

export function settingsEqual(a: Settings, b: Settings): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface SettingsRow {
  default_model: string;
  allowlist: unknown;
  default_reasoning: string | null;
  max_reasoning: string | null;
  turn_budget: number;
  updated_at: Date;
  updated_by: string;
}

/** A stored row, validated like input: a bad row throws so callers keep the last good value. */
function fromRow(row: SettingsRow): StoredSettings {
  const settings = validateSettings({
    defaultModel: row.default_model,
    allowlist: row.allowlist,
    reasoning: row.default_reasoning,
    maxReasoning: row.max_reasoning,
    turnBudget: row.turn_budget,
  });
  if (typeof settings === "string") throw new Error(`stored settings are invalid: ${settings}`);
  return { settings, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

const COLUMNS =
  "default_model, allowlist, default_reasoning, max_reasoning, turn_budget, updated_at, updated_by";

type Db = pg.Pool | pg.PoolClient;

/** The settings row, undefined while it is not seeded. Throws for an invalid row. */
export async function readSettings(db: Db): Promise<StoredSettings | undefined> {
  const { rows } = await db.query<SettingsRow>(`select ${COLUMNS} from inbox.settings`);
  return rows[0] === undefined ? undefined : fromRow(rows[0]);
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

async function writeHistoryAndNotify(
  client: pg.PoolClient,
  by: string,
  old: Settings | null,
  next: Settings,
): Promise<void> {
  await client.query(
    "insert into inbox.settings_history (changed_by, old, new) values ($1, $2, $3)",
    [by, old === null ? null : JSON.stringify(old), JSON.stringify(next)],
  );
  await client.query("select pg_notify($1, $2)", [SETTINGS_CHANNEL, "changed"]);
}

/**
 * Seeds the row once. Race-safe: two replicas starting together both run this and exactly one inserts, so the
 * history has one seed entry. True if this call inserted.
 */
export async function seedSettings(pool: pg.Pool, input: Settings): Promise<boolean> {
  // Never persist a row the read path would reject: that would block every start until someone fixed the table by hand.
  const seed = validateSettings(input);
  if (typeof seed === "string") throw new Error(`invalid seed settings: ${seed}`);
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query(
      `insert into inbox.settings (default_model, allowlist, default_reasoning, max_reasoning, turn_budget, updated_by)
       values ($1, $2, $3, $4, $5, 'seed')
       on conflict (id) do nothing
       returning default_model`,
      [
        seed.defaultModel,
        JSON.stringify(seed.allowlist),
        seed.reasoning,
        seed.maxReasoning,
        seed.turnBudget,
      ],
    );
    if (rows.length === 0) return false;
    await writeHistoryAndNotify(client, "seed", null, seed);
    return true;
  });
}

/**
 * Applies a full or partial update from `by` (the owner name): validates it over the current row (locked, so two
 * admins cannot interleave), writes the row and the history entry and notifies, in one transaction. A change that
 * alters nothing writes nothing. Resolves to the stored settings or the message for a 400.
 */
export async function updateSettings(
  pool: pg.Pool,
  patch: unknown,
  by: string,
): Promise<StoredSettings | string> {
  return inTransaction(pool, async (client) => {
    const { rows } = await client.query<SettingsRow>(
      `select ${COLUMNS} from inbox.settings for update`,
    );
    const current = rows[0] === undefined ? undefined : fromRow(rows[0]);
    const next = validateSettings(patch, current?.settings);
    if (typeof next === "string") return next;
    if (current !== undefined && settingsEqual(current.settings, next)) return current;
    const { rows: written } = await client.query<SettingsRow>(
      `insert into inbox.settings (default_model, allowlist, default_reasoning, max_reasoning, turn_budget, updated_by)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         default_model = excluded.default_model, allowlist = excluded.allowlist,
         default_reasoning = excluded.default_reasoning, max_reasoning = excluded.max_reasoning,
         turn_budget = excluded.turn_budget,
         updated_at = clock_timestamp(), updated_by = excluded.updated_by
       returning ${COLUMNS}`,
      [
        next.defaultModel,
        JSON.stringify(next.allowlist),
        next.reasoning,
        next.maxReasoning,
        next.turnBudget,
        by,
      ],
    );
    await writeHistoryAndNotify(client, by, current?.settings ?? null, next);
    return written[0] === undefined
      ? { settings: next, updatedAt: new Date(), updatedBy: by }
      : fromRow(written[0]);
  });
}

/** Newest first. */
export async function listSettingsHistory(
  pool: pg.Pool,
  limit: number,
): Promise<SettingsHistoryEntry[]> {
  const { rows } = await pool.query<{
    id: string;
    changed_at: Date;
    changed_by: string;
    old: Settings | null;
    new: Settings;
  }>(
    "select id, changed_at, changed_by, old, new from inbox.settings_history order by id desc limit $1",
    [limit],
  );
  return rows.map((row) => ({
    id: row.id,
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    old: row.old,
    new: row.new,
  }));
}
