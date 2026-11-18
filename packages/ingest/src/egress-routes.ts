import type { IncomingMessage, ServerResponse } from "node:http";
import {
  BodyError,
  createEgressRule,
  createRuleSet,
  deleteEgressRule,
  deleteRuleSet,
  evaluateEgress,
  listEgressHistory,
  normalizeHost,
  parseExpectedRevision,
  PROFILE_NAME,
  readEgress,
  readProxyStatus,
  readJsonObject,
  readProfile,
  ruleSetNameError,
  sendBodyError,
  sendJson,
  sessionIdError,
  updateEgressRule,
  updateRuleSet,
} from "@pi-durable-k8s/session-core";
import type { RuleOwner, StoredEgressRule, StoredRuleSet } from "@pi-durable-k8s/session-core";
import type pg from "pg";

const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 500;
const RULE_ID = /^[1-9][0-9]{0,17}$/;

function ruleJson(rule: StoredEgressRule) {
  return {
    ...rule,
    expiresAt: rule.expiresAt?.toISOString() ?? null,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

function ruleSetJson(set: StoredRuleSet) {
  return {
    ...set,
    createdAt: set.createdAt.toISOString(),
    updatedAt: set.updatedAt.toISOString(),
  };
}

/** The body, or undefined after answering the 400 for it. */
async function readBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJsonObject(req);
  } catch (error) {
    if (error instanceof BodyError) {
      sendBodyError(res, req, error);
      return undefined;
    }
    throw error;
  }
}

/** `expectedRevision` out of the body (`rest` is what is left), or the message for a 400. 0 means an empty schema. */
function takeRevision(
  body: Record<string, unknown>,
): { expectedRevision: number | undefined; rest: Record<string, unknown> } | string {
  const { expectedRevision, ...rest } = body;
  const parsed = parseExpectedRevision(expectedRevision, { create: true });
  return typeof parsed === "string" ? parsed : { expectedRevision: parsed, rest };
}

/**
 * `/admin/egress/*` (the caller is already known to be an admin; ADR 0034): rule sets and their rules, a session's own
 * rules, `explain`, `status` and the history. The writes send `NOTIFY egress_rules` in their transaction; the proxy of
 * slice 3 listens to it. A write the stored state refuses throws `AdminConflictError` (or `AdminBlockedError`), which
 * the caller turns into a 409.
 */
export async function handleAdminEgress(
  req: IncomingMessage,
  res: ServerResponse,
  pool: pg.Pool,
  owner: string,
  url: URL,
  parts: string[],
): Promise<void> {
  const method = req.method ?? "GET";
  const say = (status: number, body: unknown): void => {
    sendJson(res, status, body);
  };
  const bad = (message: string): void => {
    say(400, { error: message });
  };
  const notAllowed = (): void => {
    say(405, { error: "method not allowed" });
  };
  const what = parts[2];

  /** The `expectedRevision` of a DELETE (ADR 0027): a query parameter, required. A number, or answers 400. */
  const requiredRevision = (): number | undefined => {
    const asked = url.searchParams.get("expectedRevision");
    if (asked === null) {
      bad("expectedRevision is required: DELETE ...?expectedRevision=<current revision>");
      return undefined;
    }
    const parsed = parseExpectedRevision(/^[0-9]{1,10}$/.test(asked) ? Number(asked) : asked);
    if (typeof parsed !== "number") {
      bad("expectedRevision must be a positive integer");
      return undefined;
    }
    return parsed;
  };

  /** Create a rule for `target` from the body; answers for every outcome. */
  const addRule = async (target: RuleOwner): Promise<void> => {
    const body = await readBody(req, res);
    if (body === undefined) return;
    const taken = takeRevision(body);
    if (typeof taken === "string") {
      bad(taken);
      return;
    }
    const created = await createEgressRule(pool, target, taken.rest, owner, taken.expectedRevision);
    if (created === undefined) {
      say(404, { error: "rule set not found" });
      return;
    }
    if (typeof created === "string") {
      bad(created);
      return;
    }
    say(201, ruleJson(created));
  };

  if (what === "rule-sets" && parts.length === 3) {
    if (method === "GET") {
      const data = await readEgress(pool);
      say(200, {
        revision: data.revision,
        ruleSets: data.ruleSets.map((set) => ({
          ...ruleSetJson(set),
          ruleCount: data.rules.filter((rule) => rule.ruleSet === set.name).length,
        })),
        invalid: data.invalid,
      });
      return;
    }
    if (method !== "POST") {
      notAllowed();
      return;
    }
    const body = await readBody(req, res);
    if (body === undefined) return;
    const taken = takeRevision(body);
    if (typeof taken === "string") {
      bad(taken);
      return;
    }
    const { name, ...spec } = taken.rest;
    const nameError = ruleSetNameError(name);
    if (nameError !== undefined) {
      bad(nameError);
      return;
    }
    const created = await createRuleSet(pool, name as string, spec, owner, taken.expectedRevision);
    if (typeof created === "string") {
      bad(created);
      return;
    }
    say(201, ruleSetJson(created));
    return;
  }

  if (
    what === "rule-sets" &&
    (parts.length === 4 || (parts.length === 5 && parts[4] === "rules"))
  ) {
    const name = parts[3] ?? "";
    const nameError = ruleSetNameError(name);
    if (nameError !== undefined) {
      bad(nameError);
      return;
    }
    if (parts.length === 5) {
      if (method !== "POST") {
        notAllowed();
        return;
      }
      await addRule({ ruleSet: name });
      return;
    }
    if (method === "GET") {
      const data = await readEgress(pool);
      const found = data.ruleSets.find((set) => set.name === name);
      if (found === undefined) {
        say(404, { error: "rule set not found" });
        return;
      }
      say(200, {
        ...ruleSetJson(found),
        revision: found.revision,
        rules: data.rules.filter((rule) => rule.ruleSet === name).map(ruleJson),
      });
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req, res);
      if (body === undefined) return;
      const taken = takeRevision(body);
      if (typeof taken === "string") {
        bad(taken);
        return;
      }
      const updated = await updateRuleSet(pool, name, taken.rest, owner, taken.expectedRevision);
      if (updated === undefined) {
        say(404, { error: "rule set not found" });
        return;
      }
      if (typeof updated === "string") {
        bad(updated);
        return;
      }
      say(200, ruleSetJson(updated));
      return;
    }
    if (method === "DELETE") {
      const expected = requiredRevision();
      if (expected === undefined) return;
      if (!(await deleteRuleSet(pool, name, owner, expected))) {
        say(404, { error: "rule set not found" });
        return;
      }
      say(200, { name, deleted: true });
      return;
    }
    notAllowed();
    return;
  }

  if (what === "rules" && parts.length === 4) {
    const id = parts[3] ?? "";
    if (!RULE_ID.test(id)) {
      bad("rule id must be a positive integer");
      return;
    }
    if (method === "PUT") {
      const body = await readBody(req, res);
      if (body === undefined) return;
      const taken = takeRevision(body);
      if (typeof taken === "string") {
        bad(taken);
        return;
      }
      const updated = await updateEgressRule(pool, id, taken.rest, owner, taken.expectedRevision);
      if (updated === undefined) {
        say(404, { error: "rule not found" });
        return;
      }
      if (typeof updated === "string") {
        bad(updated);
        return;
      }
      say(200, ruleJson(updated));
      return;
    }
    if (method === "DELETE") {
      const expected = requiredRevision();
      if (expected === undefined) return;
      if (!(await deleteEgressRule(pool, id, owner, expected))) {
        say(404, { error: "rule not found" });
        return;
      }
      say(200, { id, deleted: true });
      return;
    }
    notAllowed();
    return;
  }

  if (what === "sessions" && parts.length === 5 && parts[4] === "rules") {
    const sessionId = parts[3] ?? "";
    const idError = sessionIdError(sessionId);
    if (idError !== undefined) {
      bad(idError);
      return;
    }
    if (method === "GET") {
      const data = await readEgress(pool);
      say(200, {
        revision: data.revision,
        rules: data.rules.filter((rule) => rule.sessionId === sessionId).map(ruleJson),
      });
      return;
    }
    if (method !== "POST") {
      notAllowed();
      return;
    }
    await addRule({ sessionId });
    return;
  }

  if (what === "explain" && parts.length === 3) {
    if (method !== "POST") {
      notAllowed();
      return;
    }
    const body = await readBody(req, res);
    if (body === undefined) return;
    const { host, port = 443, sessionId, profile, addresses, ...unknown } = body;
    const extra = Object.keys(unknown)[0];
    if (extra !== undefined) {
      bad(`unknown field "${extra.slice(0, 50)}"`);
      return;
    }
    if (typeof host !== "string" || host.length === 0 || host.length > 300) {
      bad("host is required");
      return;
    }
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      bad("port must be an integer from 1 to 65535");
      return;
    }
    if (sessionId !== undefined && sessionIdError(sessionId) !== undefined) {
      bad("sessionId must be a lowercase session id (a UUID)");
      return;
    }
    if (profile !== undefined && (typeof profile !== "string" || !PROFILE_NAME.test(profile))) {
      bad("profile must be a profile name");
      return;
    }
    if (
      addresses !== undefined &&
      (!Array.isArray(addresses) ||
        addresses.length > 16 ||
        !addresses.every((a) => typeof a === "string" && a.length <= 64))
    ) {
      bad("addresses must be an array of at most 16 IP addresses (what the host resolves to)");
      return;
    }
    let profileRuleSets: string[] = [];
    if (typeof profile === "string") {
      const stored = await readProfile(pool, profile);
      if (stored === undefined) {
        bad(`profile "${profile}" not found`);
        return;
      }
      profileRuleSets = stored.definition.egressRuleSets ?? [];
    }
    const data = await readEgress(pool);
    const decision = evaluateEgress(data.ruleSets, data.rules, {
      host,
      port,
      sessionId: sessionId as string | undefined,
      profileRuleSets,
      addresses: addresses as string[] | undefined,
      now: new Date(),
    });
    const ruleById = (id: string) => data.rules.find((rule) => rule.id === id);
    const matched = decision.matchedRuleId === null ? undefined : ruleById(decision.matchedRuleId);
    say(200, {
      ...decision,
      host: normalizeHost(host),
      port,
      revision: data.revision,
      profileRuleSets,
      matchedRule: matched === undefined ? null : ruleJson(matched),
      conflictingRules: (decision.conflictingRuleIds ?? []).flatMap((id) => {
        const rule = ruleById(id);
        return rule === undefined ? [] : [ruleJson(rule)];
      }),
      // Without addresses only names were judged: whether the host resolves to a private address is not known here.
      addressesChecked: addresses !== undefined && (addresses as string[]).length > 0,
    });
    return;
  }

  if (what === "status" && parts.length === 3) {
    if (method !== "GET") {
      notAllowed();
      return;
    }
    const data = await readEgress(pool);
    const replicas = await readProxyStatus(pool);
    say(200, {
      revision: data.revision,
      ruleSets: data.ruleSets.length,
      rules: data.rules.length,
      invalid: data.invalid.length,
      // Each proxy replica's last report (ADR 0035): a change has arrived when every serving replica shows its revision.
      proxy: {
        replicas: replicas.map((replica) => ({
          name: replica.name,
          revision: replica.revision,
          state: replica.state,
          lastReadAt: replica.lastReadAt?.toISOString() ?? null,
          startedAt: replica.startedAt.toISOString(),
          updatedAt: replica.updatedAt.toISOString(),
          version: replica.version,
        })),
        ...(replicas.length === 0 ? { note: "no egress proxy reports yet" } : {}),
      },
    });
    return;
  }

  if (what === "history" && parts.length === 3) {
    if (method !== "GET") {
      notAllowed();
      return;
    }
    const asked = Number(url.searchParams.get("limit") ?? HISTORY_DEFAULT);
    const limit =
      Number.isInteger(asked) && asked >= 1 ? Math.min(asked, HISTORY_MAX) : HISTORY_DEFAULT;
    const kind = url.searchParams.get("kind") ?? undefined;
    if (kind !== undefined && kind !== "rule-set" && kind !== "rule") {
      bad("kind must be rule-set or rule");
      return;
    }
    const ref = url.searchParams.get("ref") ?? undefined;
    const history = await listEgressHistory(pool, limit, {
      ...(kind === undefined ? {} : { kind }),
      ...(ref === undefined ? {} : { ref }),
    });
    say(200, {
      history: history.map((entry) => ({ ...entry, changedAt: entry.changedAt.toISOString() })),
    });
    return;
  }
  say(404, { error: "not found" });
}
