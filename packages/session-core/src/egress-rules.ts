import { UUID } from "./http.js";

/**
 * Egress rules (docs/decisions/0034-egress-rules.md): what a rule may say, and which rule decides a connection. Pure:
 * no database, no clock (callers pass `now`), so the proxy of slice 3 can reuse it. Address safety (private,
 * cluster, metadata and IPv6-mapped addresses, checked on the resolved IP) is the proxy's job and comes before any of
 * this.
 *
 * Rules belong to a named rule set or to one session. A rule set applies to a session when it has `appliesToAll` or
 * the session's profile names it.
 */

export const EGRESS_EFFECTS = ["allow", "deny"] as const;
export type EgressEffect = (typeof EGRESS_EFFECTS)[number];
/** `onecli` sends the tunnel through the credential injector; only those hosts need it (epic #50). */
export const EGRESS_ROUTES = ["direct", "onecli"] as const;
export type EgressRoute = (typeof EGRESS_ROUTES)[number];

/** Same syntax as a profile name. */
export const RULE_SET_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** A named group of rules that profiles reference. This is also the wire shape of the admin API besides `name`. */
export interface RuleSetSpec {
  description: string;
  /** The set applies to every session, not only to profiles that name it. */
  appliesToAll: boolean;
}

/** What the admin API takes and returns for one rule, besides its `id`, owner and bookkeeping. */
export interface EgressRuleSpec {
  effect: EgressEffect;
  /**
   * Lowercase, no trailing dot. `registry.npmjs.org` matches that host only; `.githubusercontent.com` (leading dot)
   * matches every subdomain of it, not the bare domain (add an exact rule for that). `*` matches any host (open
   * web, `direct` only); it never reaches private addresses unless a `private` rule allows them. A CIDR
   * (`10.20.0.0/16`, a `cidr` match) is only valid on a `private` rule.
   */
  host: string;
  /** Distinct, sorted, 1 to 65535. */
  ports: number[];
  /** Applies to an allow; a deny is always `direct`. */
  route: EgressRoute;
  /**
   * An allow that may reach a private or cluster address: the host resolves to one, or it lies in the `cidr` host. It
   * needs a narrow target (an exact host or a cidr), explicit ports and route `direct`. Default false: a host that
   * resolves to a private address is denied even when the host is allowed.
   */
  private: boolean;
  /** The rule is ignored from this instant on; null for never. */
  expiresAt: Date | null;
  note: string;
}

/** The part of a stored rule that evaluation reads. Exactly one of `ruleSet` and `sessionId` is set. */
export interface EvaluableRule extends EgressRuleSpec {
  /** A decimal string (a Postgres bigint). */
  id: string;
  ruleSet: string | null;
  /** Lowercase session id. */
  sessionId: string | null;
}

export interface EvaluableRuleSet {
  name: string;
  appliesToAll: boolean;
}

export const MAX_EGRESS_RULES = 2000;
export const MAX_RULE_SETS = 200;
export const MAX_RULE_PORTS = 32;
export const MAX_RULE_NOTE = 500;
export const MAX_RULE_SET_DESCRIPTION = 500;
export const DEFAULT_RULE_PORTS: readonly number[] = [443];
/** The host pattern of a rule that matches every host. */
export const ANY_HOST = "*";
const MAX_HOST = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const KEYS = ["effect", "host", "ports", "route", "private", "expiresAt", "note"] as const;
const SET_KEYS = ["description", "appliesToAll"] as const;

/** The message for a 400 when `name` cannot be a rule set's name, else undefined. */
export function ruleSetNameError(name: unknown): string | undefined {
  return typeof name === "string" && RULE_SET_NAME.test(name)
    ? undefined
    : `rule set name must match ${RULE_SET_NAME.source}`;
}

/** The message for a 400 when `id` is not a session id (lowercase UUID), else undefined. */
export function sessionIdError(id: unknown): string | undefined {
  return typeof id === "string" && UUID.test(id)
    ? undefined
    : "session id must be a lowercase UUID";
}

/**
 * Rule set validation, like `validateEgressRule`: `name` comes from the path, `current` is the stored set for a partial
 * update. Returns the normalised spec or the message for a 400.
 */
export function validateRuleSet(
  name: string,
  input: unknown,
  current?: RuleSetSpec,
): RuleSetSpec | string {
  const nameError = ruleSetNameError(name);
  if (nameError !== undefined) return nameError;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "rule set must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (key === "name") {
      if (body.name !== name) return "name is immutable and must match the path";
      continue;
    }
    if (!(SET_KEYS as readonly string[]).includes(key))
      return `unknown field "${key.slice(0, 50)}"`;
  }
  const description = "description" in body ? body.description : (current?.description ?? "");
  if (typeof description !== "string" || description.length > MAX_RULE_SET_DESCRIPTION) {
    return `description must be a string of at most ${String(MAX_RULE_SET_DESCRIPTION)} characters`;
  }
  const appliesToAll =
    "appliesToAll" in body ? body.appliesToAll : (current?.appliesToAll ?? false);
  if (typeof appliesToAll !== "boolean") return "appliesToAll must be a boolean";
  return { description, appliesToAll };
}

/** Lowercases and strips one trailing dot, the form rules are stored in and requests are compared in. */
export function normalizeHost(host: string): string {
  const lower = host.toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * Whether the last label makes `labels` an address, in any spelling a resolver or browser accepts: all digits
 * (`10.0.0.1`, `2130706433`) or hex (`0x7f.1`). Such a name is never a rule: the proxy decides on addresses.
 */
function looksLikeAddress(labels: string[]): boolean {
  const last = labels[labels.length - 1] ?? "";
  return /^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last);
}

/** The message for a 400 when `host` (already normalised, without the suffix dot) is not a DNS name, else undefined. */
function dnsNameError(host: string): string | undefined {
  if (host.length === 0 || host.length > MAX_HOST)
    return `host must have 1 to ${String(MAX_HOST)} characters`;
  const labels = host.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    return "host must be a DNS name of lowercase letters, digits and hyphens (punycode for non-ASCII), with no wildcard other than a leading dot";
  }
  if (looksLikeAddress(labels)) return "host must not be an IP address";
  return undefined;
}

/**
 * The message for a 400 when `host` cannot be the host of a public rule, else undefined. Expects the normalised form. A
 * suffix rule that allows needs two labels, so no allow covers a whole top-level domain.
 */
export function ruleHostError(host: string, effect: EgressEffect): string | undefined {
  if (host === ANY_HOST) return undefined;
  if (host.includes("/")) {
    return "a cidr host needs private: true (public hosts are matched by name)";
  }
  const suffix = host.startsWith(".");
  const error = dnsNameError(suffix ? host.slice(1) : host);
  if (error !== undefined) return error;
  if (suffix && effect === "allow" && host.slice(1).split(".").length < 2) {
    return "an allow suffix rule needs at least two labels (.example.com), not a whole top-level domain";
  }
  return undefined;
}

export interface Address {
  family: 4 | 6;
  value: bigint;
}
export interface Cidr extends Address {
  prefix: number;
}

const bits = (family: 4 | 6): number => (family === 4 ? 32 : 128);

export function parseIp(text: string): Address | undefined {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4 !== null) {
    let value = 0n;
    for (const part of v4.slice(1)) {
      if ((part.length > 1 && part.startsWith("0")) || Number(part) > 255) return undefined;
      value = (value << 8n) | BigInt(part);
    }
    return { family: 4, value };
  }
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (const [index, piece] of pieces.entries()) {
      if (index === pieces.length - 1 && piece.includes(".")) {
        const tail = parseIp(piece);
        if (tail?.family !== 4) return undefined;
        out.push(Number(tail.value >> 16n), Number(tail.value & 0xffffn));
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) out.push(parseInt(piece, 16));
      else return undefined;
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => 0),
    ...tail,
  ];
  return { family: 6, value: all.reduce((acc, group) => (acc << 16n) | BigInt(group), 0n) };
}

const maskOf = (family: 4 | 6, prefix: number): bigint =>
  ((1n << BigInt(bits(family))) - 1n) ^ ((1n << BigInt(bits(family) - prefix)) - 1n);

function parseCidrText(text: string): Cidr | undefined {
  const match = /^([0-9a-f:.]+)\/(\d{1,3})$/i.exec(text);
  if (match === null) return undefined;
  const address = parseIp(match[1] ?? "");
  const prefix = Number(match[2]);
  if (address === undefined || prefix > bits(address.family)) return undefined;
  return (address.value & maskOf(address.family, prefix)) === address.value
    ? { ...address, prefix }
    : undefined;
}

const inCidr = (cidr: Cidr, address: Address): boolean =>
  cidr.family === address.family &&
  (address.value & maskOf(cidr.family, cidr.prefix)) === cidr.value;

function overlaps(a: Cidr, b: Cidr): boolean {
  if (a.family !== b.family) return false;
  const mask = maskOf(a.family, Math.min(a.prefix, b.prefix));
  return (a.value & mask) === (b.value & mask);
}

const cidrs = (list: string[]): Cidr[] =>
  list.map((text) => {
    const cidr = parseCidrText(text);
    if (cidr === undefined) throw new Error(`bad built-in cidr ${text}`);
    return cidr;
  });

/**
 * Destinations no rule can open (ADR 0034): loopback, link-local (cloud metadata included), "this network", multicast
 * and reserved space, and IPv4-mapped IPv6 (write the IPv4 form). They also cover the platform itself in practice
 * (Postgres, the orchestrator, ingest, OneCLI and the Kubernetes API are cluster addresses); which cluster addresses
 * those are is the proxy's to know (slice 3), so it enforces that part from its own configuration.
 */
export const ALWAYS_BLOCKED_CIDRS: readonly string[] = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "fe80::/10",
  "fd00:ec2::254/128",
  "ff00::/8",
];
/** Addresses that are denied unless a `private` rule allows them. The proxy may add its cluster ranges. */
export const PRIVATE_CIDRS: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "fc00::/7",
  "2001:db8::/32",
];
const BLOCKED = cidrs([...ALWAYS_BLOCKED_CIDRS]);
const PRIVATE = cidrs([...PRIVATE_CIDRS]);

/** `blocked`: no rule can allow it. `private`: only a private rule can. `invalid`: not an IP address. */
export function classifyAddress(text: string): "blocked" | "private" | "public" | "invalid" {
  let address = parseIp(text.toLowerCase());
  if (address === undefined) return "invalid";
  // An IPv4 address in IPv6 clothes is judged as the IPv4 address it is (::ffff:10.0.0.1 is private, ::ffff:8.8.8.8 not).
  if (address.family === 6 && address.value >> 32n === 0xffffn) {
    address = { family: 4, value: address.value & 0xffffffffn };
  }
  const here = address;
  if (BLOCKED.some((cidr) => inCidr(cidr, here))) return "blocked";
  return PRIVATE.some((cidr) => inCidr(cidr, here)) ? "private" : "public";
}

/** The message for a 400 when `host` cannot be the host of a private rule, else undefined: an exact name or a narrow cidr. */
function privateHostError(host: string): string | undefined {
  if (host === ANY_HOST || host.startsWith(".")) {
    return "a private rule needs a narrow target: an exact host or a cidr, not * or a suffix";
  }
  if (!host.includes("/")) {
    if (host === "localhost" || host.endsWith(".localhost"))
      return "localhost can never be allowed";
    return dnsNameError(host);
  }
  const cidr = parseCidrText(host);
  if (cidr === undefined)
    return "host must be a cidr like 10.20.0.0/16 (network address, IPv4 or IPv6)";
  const least = cidr.family === 4 ? 8 : 32;
  if (cidr.prefix < least) {
    return `a cidr must be at least /${String(least)} for IPv${String(cidr.family)}`;
  }
  if (BLOCKED.some((blocked) => overlaps(blocked, cidr))) {
    return "cidr overlaps an always-blocked range (loopback, link-local and metadata, multicast, reserved): no rule can allow it";
  }
  return undefined;
}

function portsError(ports: unknown): string | undefined {
  if (
    !Array.isArray(ports) ||
    ports.length < 1 ||
    ports.length > MAX_RULE_PORTS ||
    !ports.every((p) => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535)
  ) {
    return `ports must be 1 to ${String(MAX_RULE_PORTS)} integers from 1 to 65535`;
  }
  return undefined;
}

/**
 * The one rule validator: admin writes (`current` is the stored rule for a partial update, undefined for a create) and
 * stored rows read back both pass through it. `effect` and `host` have no default. Returns the normalised rule or the
 * message for a 400. A new `expiresAt` must lie in the future; a kept one may have passed.
 */
export function validateEgressRule(
  input: unknown,
  now: Date,
  current?: EgressRuleSpec,
): EgressRuleSpec | string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return "rule must be a JSON object";
  }
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(KEYS as readonly string[]).includes(key)) return `unknown field "${key.slice(0, 50)}"`;
  }
  const has = (key: (typeof KEYS)[number]): boolean => key in body;
  const pick = (key: (typeof KEYS)[number], fallback: unknown): unknown =>
    has(key) ? body[key] : current === undefined ? fallback : current[key];

  const effect = pick("effect", undefined);
  if (typeof effect !== "string" || !(EGRESS_EFFECTS as readonly string[]).includes(effect)) {
    return `effect is required and must be one of ${EGRESS_EFFECTS.join(", ")}`;
  }
  const hostInput = pick("host", undefined);
  if (typeof hostInput !== "string") return "host is required";
  const host = normalizeHost(hostInput);
  const allowsPrivate = pick("private", false);
  if (typeof allowsPrivate !== "boolean") return "private must be a boolean";
  const hostError = allowsPrivate
    ? privateHostError(host)
    : ruleHostError(host, effect as EgressEffect);
  if (hostError !== undefined) return hostError;
  if (allowsPrivate) {
    if (effect !== "allow") return "private applies to an allow rule only";
    // No default: a rule that opens an internal address names the ports it opens.
    if (!has("ports") && current?.private !== true) return "a private rule needs explicit ports";
  }

  const ports = pick("ports", DEFAULT_RULE_PORTS);
  const badPorts = portsError(ports);
  if (badPorts !== undefined) return badPorts;
  const route = pick("route", "direct");
  if (typeof route !== "string" || !(EGRESS_ROUTES as readonly string[]).includes(route)) {
    return `route must be one of ${EGRESS_ROUTES.join(", ")}`;
  }
  if (effect === "deny" && route !== "direct")
    return "route applies to an allow; omit it for a deny";
  // OneCLI decrypts what it carries, so it only ever sees hosts an admin named.
  if (host === ANY_HOST && route !== "direct") return 'a "*" rule must have route direct';
  if (allowsPrivate && route !== "direct") return "a private rule must have route direct";

  let expiresAt: Date | null;
  if (has("expiresAt")) {
    if (body.expiresAt === null) expiresAt = null;
    else if (
      typeof body.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(body.expiresAt) ||
      Number.isNaN(new Date(body.expiresAt).getTime())
    ) {
      return "expiresAt must be null or an ISO 8601 timestamp with a time zone";
    } else {
      expiresAt = new Date(body.expiresAt);
      if (expiresAt.getTime() <= now.getTime()) return "expiresAt must lie in the future";
    }
  } else expiresAt = current?.expiresAt ?? null;

  const note = pick("note", "");
  if (typeof note !== "string" || note.length > MAX_RULE_NOTE) {
    return `note must be a string of at most ${String(MAX_RULE_NOTE)} characters`;
  }
  return {
    effect: effect as EgressEffect,
    host,
    ports: [...new Set(ports as number[])].sort((a, b) => a - b),
    route: route as EgressRoute,
    private: allowsPrivate,
    expiresAt,
    note,
  };
}

export interface EgressRequest {
  host: string;
  port: number;
  /** The session making the request; its own rules apply. */
  sessionId?: string | undefined;
  /** The names of the rule sets its profile references; the sets that apply to all are added. */
  profileRuleSets?: readonly string[] | undefined;
  /**
   * The addresses the host resolved to, when known (the proxy always knows; `explain` takes them as input). Each must
   * be allowed: an always-blocked one denies, a private one needs a `private` rule. Absent: only names are judged.
   */
  addresses?: readonly string[] | undefined;
  now: Date;
}

/**
 * Why a decision came out as it did, as a stable word (`reason` is prose for people). The Go evaluator of the proxy
 * returns the same words, and packages/session-core/test/egress-vectors.json pins both to the same answers.
 */
export type EgressReasonKind =
  | "allowed"
  | "default-deny"
  | "denied-by-rule"
  | "conflicting-routes"
  | "always-blocked"
  | "needs-private"
  | "invalid-host"
  | "invalid-port"
  | "invalid-address"
  | "mixed-routes";

export interface EgressDecision {
  decision: "allow" | "deny";
  /** The allow's route; null for a deny. */
  route: EgressRoute | null;
  /** The rule that decided; null for the default deny, an always-blocked address and conflicting routes. */
  matchedRuleId: string | null;
  /** The rule set of the matching rule; null for a session rule and when no rule decided. */
  ruleSet: string | null;
  /** Set when two equally specific allows disagree on the route: their ids. The decision is then a deny. */
  conflictingRuleIds?: string[];
  /** The decision turned on `private`: an address was private, so only a private rule could allow it. */
  needsPrivate?: boolean;
  reasonKind: EgressReasonKind;
  reason: string;
}

function hostMatches(rule: EvaluableRule, host: string): boolean {
  if (rule.host === ANY_HOST) return true;
  // The leading dot of a suffix rule is kept, so `a.example.com` matches `.example.com` and `example.com` does not.
  return rule.host.startsWith(".")
    ? host.length > rule.host.length && host.endsWith(rule.host)
    : host === rule.host;
}

const isCidr = (rule: EvaluableRule): boolean => rule.host.includes("/");

/** Exact first, then a cidr, then a longer suffix, then a shorter one, then `*`. Matching suffixes are nested, so length orders them. */
function hostRank(rule: EvaluableRule): number {
  return rule.host === ANY_HOST
    ? 0
    : isCidr(rule)
      ? Number.MAX_SAFE_INTEGER - 1
      : rule.host.startsWith(".")
        ? rule.host.length
        : Number.MAX_SAFE_INTEGER;
}

const idOrder = (a: EvaluableRule, b: EvaluableRule): number =>
  a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function describe(rule: EvaluableRule): string {
  const owner = rule.ruleSet === null ? "session rule" : `rule set ${rule.ruleSet}`;
  const kind =
    rule.host === ANY_HOST
      ? "any host"
      : isCidr(rule)
        ? "cidr"
        : rule.host.startsWith(".")
          ? "suffix"
          : "exact";
  return `rule ${rule.id} (${owner}, ${kind} ${rule.host}${rule.private ? ", private" : ""})`;
}

const deny = (
  reason: string,
  reasonKind: EgressReasonKind,
  rule?: EvaluableRule,
): EgressDecision => ({
  decision: "deny",
  route: null,
  matchedRuleId: rule?.id ?? null,
  ruleSet: rule?.ruleSet ?? null,
  reasonKind,
  reason,
});

/** The most specific of `allows` as a decision, or undefined when there are none; two best that disagree on the route deny. */
function bestAllow(allows: EvaluableRule[], target: string): EgressDecision | undefined {
  const bestHost = Math.max(-1, ...allows.map(hostRank));
  const sameHost = allows.filter((rule) => hostRank(rule) === bestHost);
  // A session rule beats a rule set's rule.
  const own = sameHost.filter((rule) => rule.ruleSet === null);
  const best = (own.length > 0 ? own : sameHost).sort(idOrder);
  const winner = best[0];
  if (winner === undefined) return undefined;
  if (best.some((rule) => rule.route !== winner.route)) {
    return {
      ...deny(
        `${target} is denied: conflicting routes between ${best.map(describe).join(" and ")}`,
        "conflicting-routes",
      ),
      conflictingRuleIds: best.map((rule) => rule.id),
    };
  }
  return {
    decision: "allow",
    route: winner.route,
    matchedRuleId: winner.id,
    ruleSet: winner.ruleSet,
    reasonKind: "allowed",
    reason: `${target} is allowed by ${describe(winner)}`,
  };
}

/**
 * Whether a connection to `host:port` may be made, and by which route. The rules considered are those of the rule
 * sets that apply to all, those of the sets the session's profile names, and the session's own. Precedence (ADR 0034,
 * epic #50):
 *
 * 0. With `addresses`: one that is always blocked (loopback, link-local and metadata, ...) denies, whatever the rules.
 * 1. Any matching deny wins, whatever its host specificity or where it comes from.
 * 2. Else the most specific matching allow: an exact host, then a cidr, a longer suffix, a shorter one, then `*`. On
 *    equal host specificity a session rule beats a rule set's rule. If the best allows that remain disagree on the
 *    route (two rule sets), the answer is a deny, "conflicting routes", and says which rules: fail closed.
 *    A public address is judged by the rules without `private`; a private address only by `private` rules, an exact
 *    host or a cidr that contains it. Every address must be allowed.
 * 3. Else deny.
 *
 * A rule matches when it has not expired and lists the port. Names are compared case-insensitively, one trailing dot
 * ignored. A name that is not a DNS name, an IP literal or a bad port is denied without looking at the rules.
 */
export function evaluateEgress(
  ruleSets: readonly EvaluableRuleSet[],
  rules: readonly EvaluableRule[],
  request: EgressRequest,
): EgressDecision {
  const host = normalizeHost(request.host);
  const target = `${host}:${String(request.port)}`;
  if (!Number.isInteger(request.port) || request.port < 1 || request.port > 65535) {
    return deny(`port ${String(request.port)} is not valid`, "invalid-port");
  }
  const error = dnsNameError(host);
  if (error !== undefined) return deny(`${target} is denied: ${error}`, "invalid-host");

  const named = new Set(request.profileRuleSets ?? []);
  const active = new Set(
    ruleSets.filter((set) => set.appliesToAll || named.has(set.name)).map((set) => set.name),
  );
  const session = request.sessionId?.toLowerCase();
  const owned = rules.filter((rule) => {
    if (rule.expiresAt !== null && rule.expiresAt.getTime() <= request.now.getTime()) return false;
    if (!rule.ports.includes(request.port)) return false;
    return rule.ruleSet === null
      ? session !== undefined && rule.sessionId === session
      : active.has(rule.ruleSet);
  });
  const byName = owned.filter((rule) => !isCidr(rule) && hostMatches(rule, host));

  const firstDeny = byName
    .filter((rule) => rule.effect === "deny")
    .sort((a, b) => hostRank(b) - hostRank(a) || idOrder(a, b))[0];
  if (firstDeny !== undefined) {
    return deny(`${target} is denied by ${describe(firstDeny)}`, "denied-by-rule", firstDeny);
  }
  const allowsByName = byName.filter((rule) => rule.effect === "allow");

  if (request.addresses === undefined || request.addresses.length === 0) {
    // Names only. A private rule by exact host is a candidate: whether it is needed depends on the address.
    return (
      bestAllow(allowsByName, target) ??
      deny(`${target} matches no allow rule (default deny)`, "default-deny")
    );
  }

  let result: EgressDecision | undefined;
  for (const text of request.addresses) {
    const kind = classifyAddress(text);
    let decision: EgressDecision;
    if (kind === "invalid")
      return deny(
        `${target} is denied: "${text.slice(0, 64)}" is not an IP address`,
        "invalid-address",
      );
    if (kind === "blocked") {
      return deny(
        `${target} is denied: it resolves to ${text}, an always-blocked address (loopback, link-local or metadata, multicast or reserved) that no rule can allow`,
        "always-blocked",
      );
    }
    if (kind === "public") {
      decision =
        bestAllow(
          allowsByName.filter((rule) => !rule.private),
          target,
        ) ?? deny(`${target} matches no allow rule (default deny)`, "default-deny");
    } else {
      const address = parseIp(text.toLowerCase());
      const mapped =
        address?.family === 6 && address.value >> 32n === 0xffffn
          ? { family: 4 as const, value: address.value & 0xffffffffn }
          : address;
      const candidates = owned.filter(
        (rule) =>
          rule.effect === "allow" &&
          rule.private &&
          mapped !== undefined &&
          (isCidr(rule)
            ? inCidr(parseCidrText(rule.host) ?? { family: 4, value: 0n, prefix: 33 }, mapped)
            : hostMatches(rule, host)),
      );
      decision = bestAllow(candidates, target) ?? {
        ...deny(
          `${target} resolves to ${text}, a private address; it needs an allow rule with private: true (an exact host or a cidr that contains it)`,
          "needs-private",
        ),
        needsPrivate: true,
      };
      if (decision.decision === "allow") decision.needsPrivate = true;
    }
    if (decision.decision === "deny") return decision;
    if (result !== undefined && result.route !== decision.route) {
      return deny(
        `${target} is denied: its addresses need different routes (${String(result.route)} and ${String(decision.route)})`,
        "mixed-routes",
      );
    }
    result ??= decision;
  }
  return result ?? deny(`${target} matches no allow rule (default deny)`, "default-deny");
}
