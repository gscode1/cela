import type {
  EgressEffect,
  EgressHistoryEntry,
  EgressRoute,
  EgressRule,
  RuleBody,
} from "@/lib/api/egress";

/**
 * The checks of the egress validator (`validateEgressRule`, packages/session-core/src/egress-rules.ts) that need no
 * data, so a form can say so before saving. The API stays the authority: a cidr is only checked for its shape and
 * prefix here, and its message for a 400 is shown as it is.
 */

export const MAX_PORTS = 32;
export const MAX_NOTE = 500;
export const MAX_DESCRIPTION = 500;
const MAX_HOST = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export const APPLIES_TO_ALL_WARNING =
  "Every session gets these rules, not only sessions whose profile names this set.";

/** What the form holds while an operator types; ports and the expiry stay text. */
export interface RuleForm {
  effect: EgressEffect;
  host: string;
  /** Comma or space separated; empty stands for the default `443` on a public rule. */
  ports: string;
  route: EgressRoute;
  private: boolean;
  /** A `datetime-local` value (local time, minutes), or empty for never. */
  expiresAt: string;
  note: string;
}

export const EMPTY_RULE_FORM: RuleForm = {
  effect: "allow",
  host: "",
  ports: "",
  route: "direct",
  private: false,
  expiresAt: "",
  note: "",
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** The `datetime-local` text of an ISO time, in local time. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formFromRule(rule: EgressRule): RuleForm {
  return {
    effect: rule.effect,
    host: rule.host,
    ports: rule.ports.join(", "),
    route: rule.route,
    private: rule.private,
    expiresAt: rule.expiresAt === null ? "" : toLocalInput(rule.expiresAt),
    note: rule.note,
  };
}

/** Lowercase, one trailing dot dropped: the form rules are stored in (`normalizeHost`). */
export const normalizeHost = (host: string): string => {
  const lower = host.trim().toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
};

export type HostForm = "exact" | "suffix" | "any" | "cidr";

export function hostFormOf(host: string): HostForm {
  if (host === "*") return "any";
  if (host.includes("/")) return "cidr";
  return host.startsWith(".") ? "suffix" : "exact";
}

/** The ports typed, or the first thing wrong with them. An empty text is `[]`. */
export function parsePorts(text: string): number[] | string {
  const parts = text.split(/[\s,]+/).filter((part) => part !== "");
  const ports: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,5}$/.test(part)) return `"${part.slice(0, 20)}" is not a port`;
    ports.push(Number(part));
  }
  if (ports.some((port) => port < 1 || port > 65535)) return "ports are from 1 to 65535";
  const distinct = [...new Set(ports)].sort((a, b) => a - b);
  if (distinct.length > MAX_PORTS) return `at most ${String(MAX_PORTS)} ports`;
  return distinct;
}

function dnsNameProblem(name: string): string | undefined {
  if (name.length === 0 || name.length > MAX_HOST)
    return `the host has 1 to ${String(MAX_HOST)} characters`;
  const labels = name.split(".");
  if (!labels.every((label) => LABEL.test(label)))
    return "the host is a DNS name of lowercase letters, digits and hyphens, with no wildcard other than a leading dot";
  const last = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last))
    return "the host must not be an IP address";
  return undefined;
}

function cidrProblem(host: string): string | undefined {
  const [address = "", prefixText = "", ...rest] = host.split("/");
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
  const v6 = address.includes(":") && /^[0-9a-f:.]+$/.test(address);
  if (rest.length > 0 || !/^\d{1,3}$/.test(prefixText) || (!v4 && !v6))
    return "a cidr looks like 10.20.0.0/16 (a network address, IPv4 or IPv6)";
  const prefix = Number(prefixText);
  if (v4 && (prefix < 8 || prefix > 32 || address.split(".").some((part) => Number(part) > 255)))
    return "an IPv4 cidr is from /8 to /32";
  if (v6 && (prefix < 32 || prefix > 128)) return "an IPv6 cidr is from /32 to /128";
  return undefined;
}

/** True when the route is not a choice: a deny, `*` and a private rule are always `direct`. */
export function routeLocked(
  form: Pick<RuleForm, "effect" | "host" | "private">,
): string | undefined {
  if (form.effect === "deny") return "A deny is always direct.";
  if (normalizeHost(form.host) === "*") return "A * rule is always direct.";
  if (form.private) return "A private rule is always direct.";
  return undefined;
}

/** The route a save sends: a locked one is `direct` whatever the select was left on. */
export const effectiveRoute = (form: RuleForm): EgressRoute =>
  routeLocked(form) === undefined ? form.route : "direct";

/** What is wrong with the form, in the validator's own terms; empty when it would pass the checks made here. */
export function ruleProblems(
  form: RuleForm,
  now: Date = new Date(),
  original?: RuleForm,
): string[] {
  const problems: string[] = [];
  const host = normalizeHost(form.host);
  const kind = hostFormOf(host);
  if (host === "") problems.push("the host is required");
  else if (form.private) {
    if (form.effect !== "allow") problems.push("private applies to an allow rule only");
    if (kind === "any" || kind === "suffix")
      problems.push(
        "a private rule needs a narrow target: an exact host or a cidr, not * or a suffix",
      );
    else if (kind === "cidr") {
      const issue = cidrProblem(host);
      if (issue !== undefined) problems.push(issue);
    } else if (host === "localhost" || host.endsWith(".localhost"))
      problems.push("localhost can never be allowed");
    else {
      const issue = dnsNameProblem(host);
      if (issue !== undefined) problems.push(issue);
    }
  } else if (kind === "cidr") {
    problems.push("a cidr host needs private: public hosts are matched by name");
  } else if (kind !== "any") {
    const issue = dnsNameProblem(kind === "suffix" ? host.slice(1) : host);
    if (issue !== undefined) problems.push(issue);
    else if (kind === "suffix" && form.effect === "allow" && host.slice(1).split(".").length < 2)
      problems.push(
        "an allow suffix rule needs at least two labels (.example.com), not a whole top-level domain",
      );
  }

  const ports = parsePorts(form.ports);
  if (typeof ports === "string") problems.push(ports);
  else if (form.private && ports.length === 0) problems.push("a private rule needs explicit ports");

  if (form.expiresAt !== "" && form.expiresAt !== original?.expiresAt) {
    const when = new Date(form.expiresAt);
    if (Number.isNaN(when.getTime())) problems.push("the expiry is not a date and time");
    else if (when.getTime() <= now.getTime()) problems.push("the expiry must lie in the future");
  }
  if (form.note.length > MAX_NOTE)
    problems.push(`the note has at most ${String(MAX_NOTE)} characters`);
  return problems;
}

/**
 * The body a save sends. `original` is the rule being edited: an expiry the operator did not touch goes back exactly
 * as stored (a kept one may have passed; a new one must lie in the future).
 */
export function ruleBody(form: RuleForm, original?: EgressRule): RuleBody {
  const ports = parsePorts(form.ports);
  const listed = typeof ports === "string" ? [] : ports;
  const stored = original?.expiresAt ?? null;
  const unchangedExpiry = stored !== null && form.expiresAt === toLocalInput(stored);
  return {
    effect: form.effect,
    host: normalizeHost(form.host),
    ports: listed.length === 0 && !form.private ? [443] : listed,
    route: effectiveRoute(form),
    private: form.private,
    expiresAt:
      form.expiresAt === ""
        ? null
        : unchangedExpiry
          ? stored
          : new Date(form.expiresAt).toISOString(),
    note: form.note,
  };
}

/** The message for a rule set name, like `ruleSetNameError`; undefined when it passes. */
export function ruleSetNameProblem(name: string): string | undefined {
  return /^[a-z][a-z0-9-]{0,31}$/.test(name)
    ? undefined
    : "Names start with a letter and use lowercase letters, digits and hyphens, at most 32 characters.";
}

/** "443", "80, 443". */
export const portsText = (ports: readonly number[]): string => ports.join(", ");

/** True when the rule has an expiry that has passed: evaluation ignores it. */
export const isExpired = (rule: Pick<EgressRule, "expiresAt">, now: Date = new Date()): boolean =>
  rule.expiresAt !== null && new Date(rule.expiresAt).getTime() <= now.getTime();

/** The 409 a stale revision gets (`checkRevision` words: "... reload and retry"); other 409s are name or limit refusals. */
export const isStaleMessage = (message: string): boolean => /reload and retry/.test(message);

function snapshotText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const v = value as Record<string, unknown>;
  if (typeof v.host === "string") {
    const ports = Array.isArray(v.ports) ? ` ports ${(v.ports as number[]).join(", ")}` : "";
    const route = v.effect === "allow" && typeof v.route === "string" ? ` via ${v.route}` : "";
    return `${String(v.effect)} ${v.host}${ports}${route}${v.private === true ? " (private)" : ""}`;
  }
  const parts: string[] = [];
  if (typeof v.description === "string" && v.description !== "") parts.push(`"${v.description}"`);
  if (typeof v.appliesToAll === "boolean")
    parts.push(v.appliesToAll ? "applies to all sessions" : "only where a profile names it");
  return parts.join(", ");
}

/** One history row as a sentence. */
export function describeEgressChange(entry: EgressHistoryEntry): string {
  const subject = entry.kind === "rule-set" ? `rule set ${entry.ref}` : `rule #${entry.ref}`;
  const owner = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return "";
    const v = value as { ruleSet?: string | null; sessionId?: string | null };
    if (typeof v.ruleSet === "string") return ` in ${v.ruleSet}`;
    return typeof v.sessionId === "string" ? ` of session ${v.sessionId}` : "";
  };
  if (entry.action === "create") {
    const what = snapshotText(entry.new);
    return `created ${subject}${owner(entry.new)}${what === "" ? "" : `: ${what}`}`;
  }
  if (entry.action === "delete") {
    const old = entry.old as { rules?: unknown[] } | null;
    const rules =
      old !== null && Array.isArray(old.rules) ? ` with ${String(old.rules.length)} rules` : "";
    const what = snapshotText(entry.old);
    return `deleted ${subject}${owner(entry.old)}${rules}${what === "" ? "" : `: ${what}`}`;
  }
  const before = snapshotText(entry.old);
  const after = snapshotText(entry.new);
  return `changed ${subject}${owner(entry.new)}: ${before === "" ? "(none)" : before} to ${after === "" ? "(none)" : after}`;
}
