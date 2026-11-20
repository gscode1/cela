import type pg from "pg";
import { AdminBlockedError, lockCatalog, profilesReferring } from "./deletion.js";
import {
  MAX_EGRESS_RULES,
  MAX_RULE_SETS,
  validateEgressRule,
  validateRuleSet,
} from "./egress-rules.js";
import type { EgressRuleSpec, EvaluableRule, RuleSetSpec } from "./egress-rules.js";
import { AdminConflictError } from "./revision.js";

/** Notification channel a writer signals on, with the new revision as payload, in the same transaction as the write. */
export const EGRESS_RULES_CHANNEL = "egress_rules";
/** One advisory transaction lock serialises every write, so revisions are committed in order. */
const EGRESS_LOCK = "egress:rules";

/** A stored rule set; the wire shape of the admin API besides the dates (ISO strings there). */
export interface StoredRuleSet extends RuleSetSpec {
  name: string;
  /**
   * Derived and written by code, never by hand (ADR 0040): the admin API refuses edits of the set and its rules, and no
   * profile may name it. `mcp-catalog` is the first.
   */
  system: boolean;
  /** The revision of the egress data at this set's last write. */
  revision: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/** A stored rule. */
export interface StoredEgressRule extends EvaluableRule {
  revision: number;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

export interface EgressHistoryEntry {
  id: string;
  /** The revision this change created. */
  revision: number;
  changedAt: Date;
  changedBy: string;
  kind: "rule-set" | "rule";
  /** The rule set's name or the rule's id. */
  ref: string;
  action: "create" | "update" | "delete";
  old: unknown;
  new: unknown;
}

export interface EgressData {
  /** The revision of everything in the schema: 0 until the first write, then every write adds at least one. */
  revision: number;
  ruleSets: StoredRuleSet[];
  rules: StoredEgressRule[];
  /** Rows the validator rejects (edited by hand): reported, and not evaluated. */
  invalid: { kind: "rule-set" | "rule"; ref: string; message: string }[];
}

interface Audit {
  revision: number | string;
  created_at: string;
  created_by: string;
  updated_at: string;
  updated_by: string;
}
interface RuleSetRow extends Audit {
  name: string;
  description: string;
  applies_to_all: boolean;
  /** Absent in rows from before migration 029. */
  system?: boolean;
}
interface RuleRow extends Audit {
  id: number | string;
  rule_set: string | null;
  session_id: string | null;
  effect: string;
  host: string;
  ports: number[];
  route: string;
  allows_private: boolean;
  expires_at: string | null;
  note: string;
}

const RULE_COLUMNS =
  "id, rule_set, session_id, effect, host, ports, route, allows_private, expires_at, note, revision, created_at, created_by, updated_at, updated_by";
const SET_COLUMNS =
  "name, description, applies_to_all, system, revision, created_at, created_by, updated_at, updated_by";

const audit = (row: Audit) => ({
  revision: Number(row.revision),
  createdAt: new Date(row.created_at),
  createdBy: row.created_by,
  updatedAt: new Date(row.updated_at),
  updatedBy: row.updated_by,
});

/** A stored rule set row, validated like input. */
function setFromRow(row: RuleSetRow): StoredRuleSet {
  const spec = validateRuleSet(row.name, {
    description: row.description,
    appliesToAll: row.applies_to_all,
  });
  if (typeof spec === "string") throw new Error(`stored rule set ${row.name} is invalid: ${spec}`);
  return { ...spec, name: row.name, system: row.system === true, ...audit(row) };
}

/** A stored rule row, validated like input. The epoch as `now`: a rule that has expired is still a valid row. */
function ruleFromRow(row: RuleRow): StoredEgressRule {
  const spec = validateEgressRule(
    {
      effect: row.effect,
      host: row.host,
      ports: row.ports,
      route: row.route,
      private: row.allows_private,
      expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
      note: row.note,
    },
    new Date(0),
  );
  if (typeof spec === "string")
    throw new Error(`stored egress rule ${String(row.id)} is invalid: ${spec}`);
  return {
    ...spec,
    id: String(row.id),
    ruleSet: row.rule_set,
    sessionId: row.session_id,
    ...audit(row),
  };
}

/** What a history entry keeps of a rule: the spec in wire form. */
function ruleSnapshot(rule: EgressRuleSpec, owner: Pick<EvaluableRule, "ruleSet" | "sessionId">) {
  return {
    ruleSet: owner.ruleSet,
    sessionId: owner.sessionId,
    effect: rule.effect,
    host: rule.host,
    ports: rule.ports,
    route: rule.route,
    private: rule.private,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    note: rule.note,
  };
}

type Db = pg.Pool | pg.PoolClient;

/** A proxy replica is silent when it has not reported for this long (it reports every few seconds). */
export const PROXY_SILENT_SECONDS = 30;

/** What one proxy replica reports in `egress.proxy_status` (ADR 0035). */
export interface ProxyReplicaStatus {
  name: string;
  /** The revision the replica serves; null until its first successful read. */
  revision: number | null;
  /** `starting`, `serving` or `stale` as the replica says, or `silent` when it has stopped reporting. */
  state: "starting" | "serving" | "stale" | "silent";
  /** The replica's last successful read of the rules. */
  lastReadAt: Date | null;
  startedAt: Date;
  /** The replica's last report. */
  updatedAt: Date;
  version: string;
}

/** The replicas that report, by name, with the silent ones marked (the clock is the database's). */
export async function readProxyStatus(db: Db): Promise<ProxyReplicaStatus[]> {
  const { rows } = await db.query<{
    replica: string;
    revision: string | number | null;
    state: "starting" | "serving" | "stale";
    last_read_at: Date | null;
    started_at: Date;
    version: string;
    updated_at: Date;
    silent_seconds: string | number;
  }>(
    `select replica, revision, state, last_read_at, started_at, version, updated_at,
            extract(epoch from clock_timestamp() - updated_at) as silent_seconds
       from egress.proxy_status order by replica`,
  );
  return rows.map((row) => ({
    name: row.replica,
    revision: row.revision === null ? null : Number(row.revision),
    state: Number(row.silent_seconds) > PROXY_SILENT_SECONDS ? "silent" : row.state,
    lastReadAt: row.last_read_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    version: row.version,
  }));
}

/**
 * The revision, every rule set and every rule from one statement, so one snapshot. They come back as JSON columns of
 * one row (dates as ISO strings). Invalid rows are reported, not thrown.
 */
export async function readEgress(db: Db): Promise<EgressData> {
  const { rows } = await db.query<{
    revision: string | number;
    rule_sets: RuleSetRow[];
    rules: RuleRow[];
  }>(
    `select (select coalesce(max(revision), 0) from egress.revisions) as revision,
            (select coalesce(jsonb_agg(to_jsonb(s) order by s.name), '[]') from egress.rule_sets s) as rule_sets,
            (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]') from egress.rules r) as rules`,
  );
  const row = rows[0];
  const data: EgressData = {
    revision: Number(row?.revision ?? 0),
    ruleSets: [],
    rules: [],
    invalid: [],
  };
  const message = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  for (const set of row?.rule_sets ?? []) {
    try {
      data.ruleSets.push(setFromRow(set));
    } catch (error) {
      data.invalid.push({ kind: "rule-set", ref: set.name, message: message(error) });
    }
  }
  for (const rule of row?.rules ?? []) {
    try {
      data.rules.push(ruleFromRow(rule));
    } catch (error) {
      data.invalid.push({ kind: "rule", ref: String(rule.id), message: message(error) });
    }
  }
  return data;
}

/** One connection, one transaction: commits when `work` returns, rolls back when it throws. */
export async function inTransaction<T>(
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

/**
 * Runs one write: the write lock, the `expectedRevision` check (0 matches an empty schema) and `work`, which calls
 * `record` once per change it makes.
 */
type Recorder = (
  kind: EgressHistoryEntry["kind"],
  ref: string,
  action: EgressHistoryEntry["action"],
  old: unknown,
  next: unknown,
) => Promise<number>;

async function write<T>(
  pool: pg.Pool,
  by: string,
  expected: number | undefined,
  work: (client: pg.PoolClient, record: Recorder) => Promise<T>,
  beforeLock?: (client: pg.PoolClient) => Promise<void>,
): Promise<T> {
  return inTransaction(pool, (client) => writeWithin(client, by, expected, work, beforeLock));
}

/**
 * `write` inside a transaction the caller owns: the MCP catalog write derives its rules in its own transaction (ADR 0040),
 * so the row, its history and the rules it implies commit or roll back together. The lock order is the catalog lock, then
 * this one, as in every other writer.
 */
export async function writeWithin<T>(
  client: pg.PoolClient,
  by: string,
  expected: number | undefined,
  work: (client: pg.PoolClient, record: Recorder) => Promise<T>,
  beforeLock?: (client: pg.PoolClient) => Promise<void>,
): Promise<T> {
  // The catalog lock first, like every write that changes what refers to what (ADR 0027).
  if (beforeLock !== undefined) await beforeLock(client);
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [EGRESS_LOCK]);
  if (expected !== undefined) {
    const { rows } = await client.query<{ revision: string }>(
      "select coalesce(max(revision), 0) as revision from egress.revisions",
    );
    const stored = Number(rows[0]?.revision ?? 0);
    if (expected !== stored) {
      throw new AdminConflictError(
        `the egress rules are at revision ${String(stored)}, not the expected ${String(expected)}: reload and retry`,
      );
    }
  }
  let revision: number | undefined;
  return work(client, async (kind, ref, action, old, next) => {
    // One revision per request, however many history rows it writes.
    if (revision === undefined) {
      const { rows } = await client.query<{ revision: string }>(
        "insert into egress.revisions (changed_by) values ($1) returning revision",
        [by],
      );
      revision = Number(rows[0]?.revision);
      await client.query("select pg_notify($1, $2)", [EGRESS_RULES_CHANNEL, String(revision)]);
    }
    await client.query(
      `insert into egress.rules_history (revision, changed_by, kind, ref, action, old, new)
         values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        revision,
        by,
        kind,
        ref,
        action,
        old === null ? null : JSON.stringify(old),
        next === null ? null : JSON.stringify(next),
      ],
    );
    return revision;
  });
}

const setSnapshot = (spec: RuleSetSpec) => ({
  description: spec.description,
  appliesToAll: spec.appliesToAll,
});

async function selectSet(client: pg.PoolClient, name: string): Promise<RuleSetRow | undefined> {
  const { rows } = await client.query<RuleSetRow>(
    `select ${SET_COLUMNS} from egress.rule_sets where name = $1 for update`,
    [name],
  );
  return rows[0];
}

/** The refusal for a hand edit of a derived set (ADR 0040): a 409 that says where the rows come from. */
function systemSetError(name: string): AdminConflictError {
  return new AdminConflictError(
    `rule set ${name} is derived from the MCP server catalog and cannot be changed by hand: edit the catalog (/admin/mcp-servers)`,
  );
}

async function isSystemSet(client: pg.PoolClient, name: string | null): Promise<boolean> {
  if (name === null) return false;
  const { rows } = await client.query<{ system: boolean }>(
    "select system from egress.rule_sets where name = $1",
    [name],
  );
  return rows[0]?.system === true;
}

/**
 * Creates a rule set. Resolves to it or the message for a 400. Throws `AdminConflictError` when the name exists, the
 * limit (`MAX_RULE_SETS`) is reached or `expectedRevision` is stale.
 */
export async function createRuleSet(
  pool: pg.Pool,
  name: string,
  input: unknown,
  by: string,
  expectedRevision?: number,
): Promise<StoredRuleSet | string> {
  const spec = validateRuleSet(name, input);
  if (typeof spec === "string") return spec;
  return write(pool, by, expectedRevision, async (client, record) => {
    if ((await selectSet(client, name)) !== undefined) {
      throw new AdminConflictError(`rule set ${name} already exists: choose another name`);
    }
    const { rows: counted } = await client.query<{ count: string }>(
      "select count(*) as count from egress.rule_sets",
    );
    if (Number(counted[0]?.count) >= MAX_RULE_SETS) {
      throw new AdminConflictError(`at most ${String(MAX_RULE_SETS)} rule sets: delete one first`);
    }
    const revision = await record("rule-set", name, "create", null, setSnapshot(spec));
    const { rows } = await client.query<RuleSetRow>(
      `insert into egress.rule_sets (name, description, applies_to_all, revision, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5) returning ${SET_COLUMNS}`,
      [name, spec.description, spec.appliesToAll, revision, by],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("rule set insert returned no row");
    return setFromRow(row);
  });
}

/** Lays `input` over the stored set. Resolves to it, the message for a 400, or undefined when there is none. A no-op writes nothing. */
export async function updateRuleSet(
  pool: pg.Pool,
  name: string,
  input: unknown,
  by: string,
  expectedRevision?: number,
): Promise<StoredRuleSet | string | undefined> {
  return write(pool, by, expectedRevision, async (client, record) => {
    const found = await selectSet(client, name);
    if (found === undefined) return undefined;
    if (found.system === true) throw systemSetError(name);
    let current: StoredRuleSet | undefined;
    try {
      current = setFromRow(found);
    } catch {
      current = undefined;
    }
    const next = validateRuleSet(name, input, current);
    if (typeof next === "string") return next;
    if (
      current !== undefined &&
      JSON.stringify(setSnapshot(current)) === JSON.stringify(setSnapshot(next))
    ) {
      return current;
    }
    const revision = await record(
      "rule-set",
      name,
      "update",
      current === undefined ? null : setSnapshot(current),
      setSnapshot(next),
    );
    const { rows } = await client.query<RuleSetRow>(
      `update egress.rule_sets set description = $2, applies_to_all = $3, revision = $4,
         updated_at = clock_timestamp(), updated_by = $5 where name = $1 returning ${SET_COLUMNS}`,
      [name, next.description, next.appliesToAll, revision, by],
    );
    return rows[0] === undefined ? undefined : setFromRow(rows[0]);
  });
}

/**
 * Deletes a rule set with its rules (the history keeps them). False when there is none. Throws `AdminBlockedError`
 * while a profile's current version names it (ADR 0027) and `AdminConflictError` for a stale `expectedRevision`.
 */
export async function deleteRuleSet(
  pool: pg.Pool,
  name: string,
  by: string,
  expectedRevision?: number,
): Promise<boolean> {
  return write(
    pool,
    by,
    expectedRevision,
    async (client, record) => {
      const found = await selectSet(client, name);
      if (found === undefined) return false;
      if (found.system === true) throw systemSetError(name);
      const profiles = await profilesReferring(client, "egress-rule-set", name);
      if (profiles.length > 0) {
        throw new AdminBlockedError(
          `rule set ${name} is used by ${profiles.map((p) => p.name).join(", ")}: remove it from those profiles first`,
          { profiles },
        );
      }
      const { rows: taken } = await client.query<RuleRow>(
        `delete from egress.rules where rule_set = $1 returning ${RULE_COLUMNS}`,
        [name],
      );
      let old: unknown = null;
      try {
        old = {
          ...setSnapshot(setFromRow(found)),
          rules: taken.map(ruleFromRow).map((r) => ruleSnapshot(r, r)),
        };
      } catch {
        // A row edited by hand into something invalid is still deleted; the history just has no typed old value.
      }
      await record("rule-set", name, "delete", old, null);
      await client.query("delete from egress.rule_sets where name = $1", [name]);
      return true;
    },
    (client) => lockCatalog(client, "exclusive"),
  );
}

/** Where a new rule goes. */
export type RuleOwner = { ruleSet: string } | { sessionId: string };

/**
 * Adds a rule to a rule set or to a session. Resolves to it, the message for a 400, or undefined when the rule set does
 * not exist. Throws `AdminConflictError` for a stale `expectedRevision` or at `MAX_EGRESS_RULES`.
 */
export async function createEgressRule(
  pool: pg.Pool,
  owner: RuleOwner,
  input: unknown,
  by: string,
  expectedRevision?: number,
  now: Date = new Date(),
): Promise<StoredEgressRule | string | undefined> {
  const rule = validateEgressRule(input, now);
  if (typeof rule === "string") return rule;
  const ruleSet = "ruleSet" in owner ? owner.ruleSet : null;
  const sessionId = "sessionId" in owner ? owner.sessionId : null;
  return write(pool, by, expectedRevision, async (client, record) => {
    if (ruleSet !== null) {
      const set = await selectSet(client, ruleSet);
      if (set === undefined) return undefined;
      if (set.system === true) throw systemSetError(ruleSet);
    }
    const { rows: counted } = await client.query<{ count: string }>(
      "select count(*) as count from egress.rules",
    );
    if (Number(counted[0]?.count) >= MAX_EGRESS_RULES) {
      throw new AdminConflictError(
        `at most ${String(MAX_EGRESS_RULES)} egress rules: delete one first`,
      );
    }
    const revision = await record(
      "rule",
      "",
      "create",
      null,
      ruleSnapshot(rule, { ruleSet, sessionId }),
    );
    const { rows } = await client.query<RuleRow>(
      `insert into egress.rules
         (rule_set, session_id, effect, host, ports, route, allows_private, expires_at, note, revision, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning ${RULE_COLUMNS}`,
      [
        ruleSet,
        sessionId,
        rule.effect,
        rule.host,
        rule.ports,
        rule.route,
        rule.private,
        rule.expiresAt,
        rule.note,
        revision,
        by,
      ],
    );
    const row = rows[0];
    if (row === undefined) throw new Error("egress rule insert returned no row");
    // The id exists only now: the history row written above gets it.
    await client.query(
      "update egress.rules_history set ref = $1 where revision = $2 and kind = 'rule' and ref = ''",
      [String(row.id), revision],
    );
    return ruleFromRow(row);
  });
}

/** Lays `input` over a stored rule (its owner never changes). Resolves to it, the message for a 400, or undefined when there is none. A no-op writes nothing. */
export async function updateEgressRule(
  pool: pg.Pool,
  id: string,
  input: unknown,
  by: string,
  expectedRevision?: number,
  now: Date = new Date(),
): Promise<StoredEgressRule | string | undefined> {
  return write(pool, by, expectedRevision, async (client, record) => {
    const { rows: found } = await client.query<RuleRow>(
      `select ${RULE_COLUMNS} from egress.rules where id = $1 for update`,
      [id],
    );
    const row = found[0];
    if (row === undefined) return undefined;
    if (await isSystemSet(client, row.rule_set)) throw systemSetError(row.rule_set ?? "");
    // A row that no longer validates is replaced by the body alone, which must then be complete.
    let current: StoredEgressRule | undefined;
    try {
      current = ruleFromRow(row);
    } catch {
      current = undefined;
    }
    const next = validateEgressRule(input, now, current);
    if (typeof next === "string") return next;
    const owner = { ruleSet: row.rule_set, sessionId: row.session_id };
    if (
      current !== undefined &&
      JSON.stringify(ruleSnapshot(current, owner)) === JSON.stringify(ruleSnapshot(next, owner))
    ) {
      return current;
    }
    const revision = await record(
      "rule",
      id,
      "update",
      current === undefined ? null : ruleSnapshot(current, owner),
      ruleSnapshot(next, owner),
    );
    const { rows } = await client.query<RuleRow>(
      `update egress.rules set effect = $2, host = $3, ports = $4, route = $5, allows_private = $6, expires_at = $7,
         note = $8, revision = $9, updated_at = clock_timestamp(), updated_by = $10 where id = $1 returning ${RULE_COLUMNS}`,
      [
        id,
        next.effect,
        next.host,
        next.ports,
        next.route,
        next.private,
        next.expiresAt,
        next.note,
        revision,
        by,
      ],
    );
    return rows[0] === undefined ? undefined : ruleFromRow(rows[0]);
  });
}

/** Removes a rule for real; the history keeps it. False when there is none. */
export async function deleteEgressRule(
  pool: pg.Pool,
  id: string,
  by: string,
  expectedRevision?: number,
): Promise<boolean> {
  return write(pool, by, expectedRevision, async (client, record) => {
    const { rows } = await client.query<RuleRow>(
      `delete from egress.rules where id = $1 returning ${RULE_COLUMNS}`,
      [id],
    );
    const row = rows[0];
    if (row === undefined) return false;
    // Raised after the delete statement, inside the transaction: the throw rolls the delete back.
    if (await isSystemSet(client, row.rule_set)) throw systemSetError(row.rule_set ?? "");
    let old: unknown = null;
    try {
      const rule = ruleFromRow(row);
      old = ruleSnapshot(rule, rule);
    } catch {
      // A row edited by hand into something invalid is still deleted; the history just has no typed old value.
    }
    await record("rule", id, "delete", old, null);
    return true;
  });
}

/** Newest first; `ref` limits it to one rule set (by name) or rule (by id). */
export async function listEgressHistory(
  pool: pg.Pool,
  limit: number,
  filter: { kind?: EgressHistoryEntry["kind"]; ref?: string } = {},
): Promise<EgressHistoryEntry[]> {
  const { rows } = await pool.query<{
    id: string;
    revision: string;
    changed_at: Date;
    changed_by: string;
    kind: EgressHistoryEntry["kind"];
    ref: string;
    action: EgressHistoryEntry["action"];
    old: unknown;
    new: unknown;
  }>(
    `select id, revision, changed_at, changed_by, kind, ref, action, old, new from egress.rules_history
     where ($2::text is null or kind = $2) and ($3::text is null or ref = $3) order by id desc limit $1`,
    [limit, filter.kind ?? null, filter.ref ?? null],
  );
  return rows.map((row) => ({
    id: row.id,
    revision: Number(row.revision),
    changedAt: row.changed_at,
    changedBy: row.changed_by,
    kind: row.kind,
    ref: row.ref,
    action: row.action,
    old: row.old,
    new: row.new,
  }));
}
