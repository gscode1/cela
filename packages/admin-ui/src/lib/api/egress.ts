import { adminJson } from "@/lib/api/raw";

/** Rule sets and rules of the egress API (docs/session-api.md, docs/decisions/0034-egress-rules.md). */

export type EgressEffect = "allow" | "deny";
export type EgressRoute = "direct" | "onecli";

export interface RuleSet {
  name: string;
  description: string;
  appliesToAll: boolean;
  /** The revision of the egress data at this set's last write; writes use the schema revision instead. */
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface RuleSetSummary extends RuleSet {
  ruleCount: number;
}

export interface RuleSetList {
  /** The revision of everything in the schema: what a write sends back as `expectedRevision`. */
  revision: number;
  ruleSets: RuleSetSummary[];
  invalid: { kind: "rule-set" | "rule"; ref: string; message: string }[];
}

export interface EgressRule {
  id: string;
  ruleSet: string | null;
  sessionId: string | null;
  effect: EgressEffect;
  host: string;
  ports: number[];
  route: EgressRoute;
  private: boolean;
  expiresAt: string | null;
  note: string;
  revision: number;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface RuleSetDetail extends RuleSet {
  rules: EgressRule[];
}

/** The fields of a rule a write may carry. */
export interface RuleBody {
  effect: EgressEffect;
  host: string;
  ports: number[];
  route: EgressRoute;
  private: boolean;
  expiresAt: string | null;
  note: string;
}

/** Where a new rule goes: a rule set, or one session (an admin writes session rules by hand). */
export type RuleOwner = { ruleSet: string } | { sessionId: string };

export const RULE_SET_NAME = /^[a-z][a-z0-9-]{0,31}$/;
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const base = "/admin/egress";
const init = (signal?: AbortSignal) => (signal ? { signal } : {});

export function listRuleSets(token: string, signal?: AbortSignal): Promise<RuleSetList> {
  return adminJson<RuleSetList>(token, `${base}/rule-sets`, init(signal));
}

export function getRuleSet(
  token: string,
  name: string,
  signal?: AbortSignal,
): Promise<RuleSetDetail> {
  return adminJson<RuleSetDetail>(
    token,
    `${base}/rule-sets/${encodeURIComponent(name)}`,
    init(signal),
  );
}

export function createRuleSet(
  token: string,
  body: { name: string; description: string; appliesToAll: boolean },
  expectedRevision: number,
): Promise<RuleSet> {
  return adminJson<RuleSet>(token, `${base}/rule-sets`, {
    method: "POST",
    body: { ...body, expectedRevision },
  });
}

export function updateRuleSet(
  token: string,
  name: string,
  changes: { description?: string; appliesToAll?: boolean },
  expectedRevision: number,
): Promise<RuleSet> {
  return adminJson<RuleSet>(token, `${base}/rule-sets/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: { ...changes, expectedRevision },
  });
}

export function deleteRuleSet(
  token: string,
  name: string,
  expectedRevision: number,
): Promise<{ name: string; deleted: true }> {
  return adminJson(
    token,
    `${base}/rule-sets/${encodeURIComponent(name)}?expectedRevision=${String(expectedRevision)}`,
    { method: "DELETE" },
  );
}

export function addRule(
  token: string,
  owner: RuleOwner,
  body: RuleBody,
  expectedRevision: number,
): Promise<EgressRule> {
  const path =
    "ruleSet" in owner
      ? `${base}/rule-sets/${encodeURIComponent(owner.ruleSet)}/rules`
      : `${base}/sessions/${encodeURIComponent(owner.sessionId)}/rules`;
  return adminJson<EgressRule>(token, path, {
    method: "POST",
    body: { ...body, expectedRevision },
  });
}

export function updateRule(
  token: string,
  id: string,
  changes: Partial<RuleBody>,
  expectedRevision: number,
): Promise<EgressRule> {
  return adminJson<EgressRule>(token, `${base}/rules/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { ...changes, expectedRevision },
  });
}

export function deleteRule(
  token: string,
  id: string,
  expectedRevision: number,
): Promise<{ id: string; deleted: true }> {
  return adminJson(
    token,
    `${base}/rules/${encodeURIComponent(id)}?expectedRevision=${String(expectedRevision)}`,
    { method: "DELETE" },
  );
}

export function listSessionRules(
  token: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<{ revision: number; rules: EgressRule[] }> {
  return adminJson(token, `${base}/sessions/${encodeURIComponent(sessionId)}/rules`, init(signal));
}

export interface ExplainRequest {
  host: string;
  port?: number;
  sessionId?: string;
  profile?: string;
  addresses?: string[];
}

export interface ExplainResult {
  decision: "allow" | "deny";
  route: EgressRoute | null;
  matchedRuleId: string | null;
  ruleSet: string | null;
  reason: string;
  matchedRule: EgressRule | null;
  conflictingRules: EgressRule[];
  needsPrivate?: boolean;
  host: string;
  port: number;
  revision: number;
  profileRuleSets: string[];
  /** Where `profileRuleSets` came from: the named profile, the session's own principal (as created), or none. */
  profileSource?: "profile" | "principal" | "none";
  addressesChecked: boolean;
  /** Whether the asked session has a OneCLI binding at the proxy (a route onecli allow is denied without one); null when no session was asked about. */
  binding?: boolean | null;
}

export function explainEgress(token: string, request: ExplainRequest): Promise<ExplainResult> {
  return adminJson<ExplainResult>(token, `${base}/explain`, { method: "POST", body: request });
}

export interface EgressStatus {
  revision: number;
  ruleSets: number;
  rules: number;
  invalid: number;
  /** Sessions with an egress token: live, live with a known Pod address, revoked. */
  principals?: { active: number; withPodIp: number; revoked: number };
  /** Sessions whose OneCLI token is sealed for the proxy (ADR 0037). */
  bindings?: { total: number };
  proxy: {
    replicas: {
      name?: string;
      revision?: number | null;
      /** `starting`, `serving`, `stale` (denying everything) or `silent` (stopped reporting). */
      state?: string;
    }[];
    note?: string;
  };
}

export function getEgressStatus(token: string, signal?: AbortSignal): Promise<EgressStatus> {
  return adminJson<EgressStatus>(token, `${base}/status`, init(signal));
}

export interface EgressHistoryEntry {
  id: string;
  revision: number;
  changedAt: string;
  changedBy: string;
  kind: "rule-set" | "rule";
  ref: string;
  action: "create" | "update" | "delete";
  old: unknown;
  new: unknown;
}

export async function listEgressHistory(
  token: string,
  signal?: AbortSignal,
): Promise<EgressHistoryEntry[]> {
  const body = await adminJson<{ history: EgressHistoryEntry[] }>(
    token,
    `${base}/history?limit=50`,
    init(signal),
  );
  return body.history;
}
