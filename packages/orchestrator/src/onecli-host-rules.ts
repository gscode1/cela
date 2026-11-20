import { MCP_RULE_SET, readEgress } from "@cela/session-core";
import type { EgressData, StoredEgressRule } from "@cela/session-core";
import type pg from "pg";
import { errorMessage, log } from "./log.js";
import type { OneCliAdmin, OneCliHostRule } from "./onecli-admin.js";

/**
 * The OneCLI host rules (the gateway's second gate, docs/onecli-host-rules.md), reconciled from the egress rules
 * (docs/decisions/0040-mcp-egress-flow.md). The gateway relays any public host for a valid agent token unless org rules
 * say otherwise, and it applies them in creation order, first match wins: `allow <host>` rules, then `block *`. So that a
 * host an admin or a catalog row opens is reachable without a GitOps change, this reconciler keeps one `allow` rule per
 * host the egress rules send through OneCLI:
 *
 *  - every allow rule with `route=onecli` (a set, a repo session's rules, an admin's), and
 *  - every host of the derived `mcp-catalog` set, whatever its route: the orchestrator reaches even a credential-less MCP
 *    server through the gateway.
 *
 * Ownership: only rules named `pi-egress-allow-<pattern>` are ever created or deleted here. A hand-made rule is never
 * changed, and a host one of them already covers (an exact pattern, or `*.suffix`, in front of the terminal block) gets
 * no rule of ours. The one exception is the terminal `block *`: its position is its meaning, so when owned allows would
 * sit behind it, it is recreated (same name, same body) behind them, the copy first and the original second, so the gateway
 * is never without a block. Nothing here creates a block when there is none: the gate's posture is the operator's choice.
 *
 * Temporary: provisioning in the orchestrator uses its OneCLI admin key; epic #65 moves that out, and this reconciler
 * moves with it.
 */

export const OWNED_PREFIX = "pi-egress-allow-";
const DESCRIPTION = "Managed by the cela egress reconciler from the egress rules: do not edit.";

/** The host pattern of OneCLI for an egress rule host: an exact host, or `*.suffix` for a leading-dot suffix. */
export function onecliPattern(host: string): string | undefined {
  if (host === "*" || host.includes("/")) return undefined;
  return host.startsWith(".") ? `*${host}` : host;
}

export function ruleName(pattern: string): string {
  return `${OWNED_PREFIX}${pattern.replace(/^\*\./, "wild-")}`;
}

/** The rule's source of truth for the gateway: hosts to allow, each with why. Pure. */
export function desiredHosts(data: EgressData, now: Date): Map<string, string[]> {
  const wanted = new Map<string, string[]>();
  const add = (host: string, why: string): void => {
    const pattern = onecliPattern(host);
    if (pattern === undefined) return;
    const reasons = wanted.get(pattern) ?? [];
    if (!reasons.includes(why)) reasons.push(why);
    wanted.set(pattern, reasons);
  };
  const live = (rule: StoredEgressRule): boolean =>
    rule.expiresAt === null || rule.expiresAt.getTime() > now.getTime();
  for (const rule of data.rules) {
    if (rule.effect !== "allow" || !live(rule)) continue;
    if (rule.ruleSet === MCP_RULE_SET) add(rule.host, "mcp");
    else if (rule.route === "onecli") add(rule.host, "onecli-route");
  }
  return wanted;
}

/** Whether `pattern` (an exact host or `*.suffix`) is covered by the hand-made pattern `by`. */
export function patternCovers(by: string, pattern: string): boolean {
  if (by === pattern) return true;
  if (!by.startsWith("*.")) return false;
  const suffix = by.slice(1);
  // `*.x.com` covers `a.x.com` and `*.a.x.com`, not `x.com` itself.
  const host = pattern.startsWith("*.") ? pattern.slice(1) : `.${pattern}`;
  return host !== suffix && host.endsWith(suffix);
}

export interface HostRulePlan {
  /** Patterns to create an owned allow for. */
  create: string[];
  /** Owned allows nobody asks for any more. */
  remove: OneCliHostRule[];
  /** The terminal block that sits in front of owned allows and must be recreated behind them (the copy first). */
  relocate: OneCliHostRule[];
  /** Further terminal blocks in front of owned allows that a block behind them already makes redundant (an interrupted move). */
  drop: OneCliHostRule[];
}

const isTerminalBlock = (rule: OneCliHostRule): boolean =>
  rule.action === "block" &&
  rule.enabled &&
  rule.hostPatterns !== null &&
  rule.hostPatterns.length === 1 &&
  rule.hostPatterns[0] === "*";

const isOwned = (rule: OneCliHostRule): boolean => rule.name.startsWith(OWNED_PREFIX);

/**
 * What to change so the owned allows equal `wanted` and take effect. Pure, and empty (idempotent) when nothing differs.
 * Hand-made rules in front of the first terminal block count as cover; behind it they are ineffective and count for nothing.
 */
export function planHostRules(
  wanted: ReadonlyMap<string, unknown>,
  existing: readonly OneCliHostRule[],
): HostRulePlan {
  const rules = [...existing].sort((a, b) => a.priority - b.priority);
  const blocks = rules.filter(isTerminalBlock);
  const firstBlock = blocks[0]?.priority ?? Number.POSITIVE_INFINITY;
  const handMadeCover = rules
    .filter(
      (rule) =>
        !isOwned(rule) &&
        rule.action === "allow" &&
        rule.enabled &&
        rule.hostPatterns !== null &&
        rule.priority < firstBlock,
    )
    .flatMap((rule) => rule.hostPatterns ?? []);
  const needed = [...wanted.keys()].filter(
    (pattern) => !handMadeCover.some((by) => patternCovers(by, pattern)),
  );
  const ownedByPattern = new Map<string, OneCliHostRule>();
  const remove: OneCliHostRule[] = [];
  for (const rule of rules.filter(isOwned)) {
    const pattern = rule.hostPatterns?.length === 1 ? rule.hostPatterns[0] : undefined;
    if (
      pattern === undefined ||
      !needed.includes(pattern) ||
      ownedByPattern.has(pattern) ||
      !rule.enabled ||
      rule.action !== "allow"
    ) {
      remove.push(rule);
      continue;
    }
    ownedByPattern.set(pattern, rule);
  }
  const create = needed.filter((pattern) => !ownedByPattern.has(pattern));
  // New rules go behind every existing one. An existing owned allow behind a terminal block is just as shadowed.
  const shadowed = blocks.filter(
    (block) =>
      create.length > 0 ||
      [...ownedByPattern.values()].some((rule) => rule.priority > block.priority),
  );
  const last = blocks[blocks.length - 1];
  if (last === undefined || shadowed.length === 0)
    return { create, remove, relocate: [], drop: [] };
  // The last block is already behind every owned allow: the earlier ones are leftovers of a move that was interrupted.
  if (!shadowed.includes(last)) return { create, remove, relocate: [], drop: shadowed };
  return { create, remove, relocate: [last], drop: shadowed.filter((block) => block !== last) };
}

export interface HostRuleReconcilerOptions {
  pool: pg.Pool;
  onecli: OneCliAdmin;
  /** Safety net for a missed notification and for a rule deleted by hand behind our back. */
  pollMs?: number;
  /** Called after a pass that changed the gateway's rules (the MCP servers retry their discovery at once). */
  onChanged?: () => void;
  now?: () => Date;
}

export interface HostRuleResult {
  created: string[];
  removed: string[];
  relocated: string[];
}

const LOCK = "onecli:host-rules";

/**
 * Keeps the OneCLI host rules equal to what the egress rules ask for (see the file comment). One pass reads the egress
 * rules and the gateway's rules and applies `planHostRules`; passes are idempotent and serialised across orchestrators
 * by an advisory lock, so two shards never create one rule twice. Runs on `egress_rules` notifications (a catalog PUT, a
 * rule write, a repo session's rules) and on a poll.
 */
export class HostRuleReconciler {
  readonly #opts: HostRuleReconcilerOptions;
  #stopped = false;
  #timer: NodeJS.Timeout | undefined;
  #listener: pg.PoolClient | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #pending = false;
  readonly #reported = new Set<string>();

  constructor(options: HostRuleReconcilerOptions) {
    this.#opts = options;
  }

  async start(): Promise<void> {
    this.#timer = setInterval(() => void this.request(), this.#opts.pollMs ?? 30_000);
    this.#timer.unref();
    void this.#listen();
    await this.request();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    const client = this.#listener;
    this.#listener = undefined;
    try {
      client?.removeAllListeners();
      client?.release(true);
    } catch {
      // already released
    }
  }

  /** Runs a pass soon. Requests that arrive during a pass share the next one. */
  request(): Promise<void> {
    if (this.#pending) return this.#queue.then(() => undefined);
    this.#pending = true;
    const run = this.#queue.then(async () => {
      this.#pending = false;
      try {
        await this.reconcile();
      } catch (error) {
        this.#report("host-rules-failed", errorMessage(error));
      }
    });
    this.#queue = run;
    return run;
  }

  /** A method, not a field read: TypeScript narrows `#stopped` to false in the loop, but stop() flips it at an await. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  async #listen(): Promise<void> {
    while (!this.#isStopped()) {
      try {
        const client = await this.#opts.pool.connect();
        if (this.#isStopped()) {
          client.release(true);
          return;
        }
        this.#listener = client;
        await new Promise<void>((resolve) => {
          client.on("notification", () => void this.request());
          client.on("error", () => resolve());
          client.on("end", () => resolve());
          client
            .query("listen egress_rules")
            .then(() => this.request())
            .catch(() => resolve());
        });
        this.#listener = undefined;
        try {
          client.removeAllListeners();
          client.release(true);
        } catch {
          // already released
        }
      } catch (error) {
        this.#report("host-rules-listen-failed", errorMessage(error));
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  /** One pass, under the advisory lock (a pass in another orchestrator makes this one skip: its result is the same). */
  async reconcile(): Promise<HostRuleResult | undefined> {
    const client = await this.#opts.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>(
        "select pg_try_advisory_lock(hashtext($1)) as locked",
        [LOCK],
      );
      if (rows[0]?.locked !== true) return undefined;
      try {
        return await this.#pass();
      } finally {
        await client
          .query("select pg_advisory_unlock(hashtext($1))", [LOCK])
          .catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async #pass(): Promise<HostRuleResult> {
    const { onecli } = this.#opts;
    const data = await readEgress(this.#opts.pool);
    const wanted = desiredHosts(data, this.#opts.now?.() ?? new Date());
    const existing = await onecli.listHostRules();
    const plan = planHostRules(wanted, existing);
    const result: HostRuleResult = { created: [], removed: [], relocated: [] };
    // Allows first, then the block behind them (copy before original), then the clean-up: every step leaves the gate shut
    // or exactly as open as the rules say.
    for (const pattern of plan.create) {
      await onecli.createHostRule({
        name: ruleName(pattern),
        action: "allow",
        hostPattern: pattern,
        description: DESCRIPTION,
      });
      result.created.push(pattern);
    }
    for (const block of plan.relocate) {
      await onecli.createHostRule({
        name: block.name,
        action: "block",
        hostPattern: "*",
        ...(block.description === "" ? {} : { description: block.description }),
      });
      await onecli.deleteHostRule(block.id);
      result.relocated.push(block.name);
    }
    for (const block of plan.drop) await onecli.deleteHostRule(block.id);
    for (const rule of plan.remove) {
      await onecli.deleteHostRule(rule.id);
      result.removed.push(rule.hostPatterns?.[0] ?? rule.name);
    }
    if (result.created.length + result.removed.length + result.relocated.length > 0) {
      log("onecli-host-rules-reconciled", { ...result, revision: data.revision });
      this.#opts.onChanged?.();
    }
    this.#reported.clear();
    return result;
  }

  /** Logs a problem once until a pass succeeds. */
  #report(event: string, message: string): void {
    const key = `${event}:${message}`;
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    log(event, { level: "warn", message });
  }
}
