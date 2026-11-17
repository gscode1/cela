import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import {
  ENV,
  SANDBOXD_TOKEN_SHA256_ENV,
  connectSandboxEnv,
  deriveSandboxToken,
  ensureClaim,
  sandboxTokenSha256,
} from "@pi-durable-k8s/sandbox-env";
import type { SandboxEnv } from "@pi-durable-k8s/sandbox-env";
import type { OrchestratorConfig } from "./config.js";
import {
  deleteClaimAndPvc,
  ensureLabeledClaim,
  listSandboxes,
  recyclePod,
  resumeIfSuspended,
  suspendSandbox,
} from "./kube.js";
import { bridgeCommand } from "./bridge-launcher.js";
import { claimNameFor, conversationOfName, interruptedExec, planSuspend } from "./lifecycle.js";
import { capField } from "./bridge-cap.js";
import { bridgeRssByClaim } from "./bridge-rss.js";
import { readMemoryCurrent } from "./memory-current.js";
import { errorMessage, log } from "./log.js";
import { TurnTimings } from "./timing.js";

export const WORKSPACE = "/workspace";

/** The value of the claim's session label for a conversation: the API session UUID. */
export type SessionKeyOf = (conversationId: number) => Promise<string>;

/** Per-session hooks for repo sessions (Phase 4c). Plain sessions ignore them: both answer "nothing". */
export interface SandboxHooks {
  /** Record the resolved Pod runtime before the attached sandbox serves tools. */
  attached?: (claimName: string) => Promise<void>;
  /** Extra environment for this conversation's tool commands (pi-env `shellEnv`), set when its env is opened. */
  shellEnv?: (conversationId: number) => Promise<Record<string, string> | undefined>;
  /** Runs before every call on an open env; renews credentials that are about to expire. */
  beforeUse?: (conversationId: number) => Promise<void>;
  /** True when the open env was built with credentials that were replaced since; the env is then closed and reopened. */
  envStale?: (conversationId: number) => boolean;
  /**
   * Durable record of "a command may be running in this conversation's sandbox". Set before a burst of commands
   * starts and cleared once the sandbox is known clean. A process that dies mid-command never clears it, so the
   * next one recycles that sandbox's Pod (see `Sandboxes.recycleAtStart`).
   */
  execInFlight?: (conversationId: number, inFlight: boolean) => Promise<void>;
  /**
   * Runs on every new env, after the bridge connects and before the env serves its first operation (the open is
   * single-flight, so concurrent first tool calls wait for it): where a session's skills are written into the
   * workspace (docs/decisions/0011-skills-in-postgres.md). If it throws, the env is closed and the open fails, so the
   * call fails and the next one tries again; a session never runs on a half-prepared sandbox.
   */
  prepareEnv?: (conversationId: number, env: ExecutionEnv) => Promise<void>;
}

/** Per open env: calls in flight, when one last ended, and whether the in-flight record is set. */
interface Usage {
  inUse: number;
  lastUsed: number;
  recorded: boolean;
}

/** A call waiting for a bridge slot. FIFO: the head is served first. */
interface SlotWaiter {
  conversationId: number;
  resolve: (env: Promise<SandboxEnv>) => void;
  reject: (error: Error) => void;
}

/** The abort signal of a call on the env: the last argument of every `ExecutionEnv` method is a chord `Context`. */
function abortSignalOf(args: readonly unknown[]): AbortSignal | undefined {
  const last = args[args.length - 1];
  if (typeof last !== "object" || last === null || !("abortSignal" in last)) return undefined;
  return last.abortSignal instanceof AbortSignal ? last.abortSignal : undefined;
}

/**
 * One long-lived sandbox env per conversation. The env's Connection restarts its bridge by itself,
 * so a recreated sandbox Pod needs no handling here beyond the claim staying put.
 */
export class Sandboxes {
  readonly #config: OrchestratorConfig;
  readonly #envs = new Map<number, Promise<SandboxEnv>>();
  /** Phase timings of the current turn of each conversation (docs/metrics.md); also tags its log lines. */
  readonly timings = new TurnTimings(log);
  /** Conversations whose bridge reported ready and has not been (re)spawned or dropped since. */
  readonly #bridgeUp = new Set<number>();

  /** Per open env. Drives idle eviction. */
  readonly #usage = new Map<number, Usage>();
  readonly #timers: NodeJS.Timeout[] = [];
  /** Conversations whose env open has not settled yet. */
  readonly #opening = new Map<number, Promise<SandboxEnv>>();
  /** Calls that need a new env while `maxOpenBridges` are open or opening and none can be evicted. */
  readonly #slotQueue: SlotWaiter[] = [];

  /**
   * Last use of each conversation's sandbox as this process saw it. Unlike `#usage` it outlives an evicted env: it is
   * what idle suspension measures. Entries go when the sandbox is suspended, recycled or deleted.
   */
  readonly #lastUsed = new Map<number, number>();
  /** Conversations whose last command was interrupted, to be recycled once no call is in flight. */
  readonly #interrupted = new Set<number>();
  /** A recycle or suspend under way. Calls wait for it before opening the env, so none reaches a dying Pod. */
  readonly #replacing = new Map<number, Promise<void>>();
  /**
   * Recycles that failed and are still owed, with the work to run again. While an entry exists the old Pod may hold the
   * leftovers of an interrupted command (ADR 0003), so no call may run until a retry has succeeded.
   */
  readonly #failed = new Map<
    number,
    { why: "interrupted" | "orchestrator-restart"; work: () => Promise<void> }
  >();

  readonly #sessionKeyOf: SessionKeyOf;
  readonly #hooks: SandboxHooks;

  constructor(config: OrchestratorConfig, sessionKeyOf: SessionKeyOf, hooks: SandboxHooks = {}) {
    this.#config = config;
    this.#sessionKeyOf = sessionKeyOf;
    this.#hooks = hooks;
    // Every open env is a Node bridge process (tens of MB). Without eviction a long-lived orchestrator grows
    // with every session it ever ran a tool in (it was OOM-killed at 512Mi after about ten). An evicted env is
    // simply opened again, adopting the same claim, by the next tool call.
    this.#timers.push(setInterval(() => this.#evictIdle(config.sandbox.idleEvictMs), 15_000));
    // Idle suspension (ADR 0004). It lists the Sandboxes, so it runs less often than eviction.
    if (config.sandbox.idleSuspendMs > 0) {
      this.#timers.push(setInterval(() => void this.#suspendIdle(), 30_000));
    }
    if (config.sandbox.bridgeRssIntervalMs > 0) {
      this.#timers.push(
        setInterval(() => void this.#logBridgeRss(), config.sandbox.bridgeRssIntervalMs),
      );
    }
    for (const timer of this.#timers) timer.unref();
  }

  /**
   * True while the conversation's env (bridge) is open or opening in this process. A suspended, recycled or evicted
   * sandbox has none, and asking is free: it never opens or resumes anything.
   */
  isOpen(conversationId: number): boolean {
    return this.#envs.has(conversationId);
  }

  /**
   * One `memory-sample` line, then one `bridge-rss` line per open bridge, keyed by session. Best effort: unavailable
   * numbers are skipped. The sample is logged with no bridge open too: that is the base of the fit.
   */
  async #logBridgeRss(): Promise<void> {
    try {
      const memory = await readMemoryCurrent();
      log("memory-sample", {
        memoryCurrentBytes: memory.bytes,
        memorySource: memory.source,
        open: this.#envs.size,
        max: capField(this.#config.sandbox.maxOpenBridges),
      });
      if (this.#envs.size === 0) return;
      const rss = await bridgeRssByClaim();
      for (const conversationId of this.#envs.keys()) {
        const claim = claimNameFor(this.#config.shard, conversationId);
        const bytes = rss.get(claim);
        if (bytes === undefined) continue;
        log("bridge-rss", {
          session: await this.#sessionKeyOf(conversationId),
          conversation: conversationId,
          claim,
          rssBytes: bytes,
          open: this.#envs.size,
        });
      }
    } catch {
      // A metric must never disturb a session.
    }
  }

  /** Stops the timers. Bridges and sandboxes stay as they are. */
  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
  }

  #evictIdle(idleMs: number): void {
    const now = Date.now();
    for (const [conversationId, usage] of this.#usage) {
      if (usage.inUse > 0 || now - usage.lastUsed < idleMs) continue;
      this.#evict(conversationId, "sandbox-env-evicted");
    }
    this.#serveQueue();
  }

  /** Closes an env nothing is using and frees its slot at once; the bridge process stops when its open settles. */
  #evict(conversationId: number, event: string): void {
    const opened = this.#envs.get(conversationId);
    this.#usage.delete(conversationId);
    // Not `#dropEnv`: callers that serve the queue are mid-loop, and serving from here would re-enter them.
    this.#envs.delete(conversationId);
    this.#bridgeUp.delete(conversationId);
    const counts = {
      claim: claimNameFor(this.#config.shard, conversationId),
      open: this.#envs.size,
      max: capField(this.#config.sandbox.maxOpenBridges),
      waiting: this.#slotQueue.length,
    };
    // A failed open has nothing to close and is already reported to its caller.
    void opened?.then(
      (env) => {
        env.close();
        log(event, counts);
      },
      () => undefined,
    );
  }

  /** Evicts the least recently used env with no call in flight. False when every env is in use. */
  #evictLeastRecentlyUsed(): boolean {
    let victim: number | undefined;
    let oldest = Infinity;
    for (const conversationId of this.#envs.keys()) {
      const usage = this.#usage.get(conversationId);
      // Never touch a conversation with a call in flight (its in-flight record, ADR 0003, stays as it is) or one whose
      // Pod is being replaced (its env is closed by that work).
      if (usage === undefined || usage.inUse > 0 || this.#replacing.has(conversationId)) continue;
      // An open still under way is left alone: its caller holds the promise and would get an env that is already closed.
      if (this.#opening.has(conversationId)) continue;
      if (usage.lastUsed < oldest) {
        oldest = usage.lastUsed;
        victim = conversationId;
      }
    }
    if (victim === undefined) return false;
    this.#evict(victim, "bridge-cap-evict");
    return true;
  }

  /** Removes an env from the map, which frees its slot, and hands freed slots to waiting calls. */
  #dropEnv(conversationId: number): void {
    this.#envs.delete(conversationId);
    this.#bridgeUp.delete(conversationId);
    this.#serveQueue();
  }

  /** Serves waiting calls in arrival order for as long as a slot is free or can be made by eviction. */
  #serveQueue(): void {
    for (let head = this.#slotQueue[0]; head !== undefined; head = this.#slotQueue[0]) {
      const existing = this.#envs.get(head.conversationId);
      if (existing === undefined) {
        const { maxOpenBridges } = this.#config.sandbox;
        if (this.#envs.size >= maxOpenBridges && !this.#evictLeastRecentlyUsed()) return;
      }
      this.#slotQueue.shift();
      head.resolve(existing ?? this.#start(head.conversationId));
    }
  }

  /**
   * The env handed to Pi Durable. Pi Durable asks for it at every model request, before any tool runs, so
   * building the real env there would create a SandboxClaim for a session that only chats. This stand-in
   * does nothing until a method is first called (a tool call), then creates or adopts the claim and
   * forwards to the real env. `id` and `cwd` are plain properties; every other member is an async method.
   */
  lazyEnv(conversationId: number): ExecutionEnv {
    const target = {
      id: `pi-env:${claimNameFor(this.#config.shard, conversationId)}`,
      cwd: WORKSPACE,
    };
    return new Proxy(target, {
      get: (object, property) => {
        if (property === "id" || property === "cwd") return object[property];
        if (typeof property === "symbol" || property === "then") return undefined;
        return async (...args: unknown[]): Promise<unknown> => {
          // Ending a run with no tool call must not open a sandbox just to clean it up.
          if (property === "cleanup" && !this.#envs.has(conversationId)) return;
          const usage = this.#usage.get(conversationId) ?? {
            inUse: 0,
            lastUsed: Date.now(),
            recorded: false,
          };
          this.#usage.set(conversationId, usage);
          usage.inUse++;
          // Before anything the call may wait for (a recycle, credential renewal, a bridge slot at the cap).
          this.timings.mark(conversationId, "tool-requested");
          let outcome: { threw: true } | { threw: false; result: unknown } | undefined;
          try {
            // A recycle or suspend of this sandbox finishes first; the env opened below is then for the new Pod.
            await this.#awaitCleanPod(conversationId);
            await this.#hooks.beforeUse?.(conversationId);
            // The env's `shellEnv` is fixed when it opens. Only when no other call is using it (this one is the only
            // user), so a running command is never cut off; otherwise a later call does it.
            if (usage.inUse === 1 && this.#hooks.envStale?.(conversationId) === true) {
              log("env-reopen", {
                ...this.timings.fields(conversationId),
                claim: claimNameFor(this.#config.shard, conversationId),
                reason: "credentials-replaced",
              });
              await this.#closeEnv(conversationId);
              this.#usage.set(conversationId, usage);
            }
            const real = (await this.ensure(conversationId, abortSignalOf(args)))
              .env as unknown as Record<string, (...a: unknown[]) => unknown>;
            // Only commands can leave processes behind. Record that one may be running before it starts, so a
            // crash in the middle is still known after the restart.
            if (property === "exec" && !usage.recorded) {
              await this.#hooks.execInFlight?.(conversationId, true);
              usage.recorded = true;
            }
            try {
              if (property === "exec") {
                this.timings.mark(conversationId, "first-exec-start");
                // A bridge that is up sends the request at once; otherwise bridge-ready marks it (TurnTimings).
                if (this.#bridgeUp.has(conversationId))
                  this.timings.mark(conversationId, "first-exec-sent");
              }
              const result = await real[property]?.(...args);
              outcome = { threw: false, result };
              return result;
            } catch (error) {
              outcome = { threw: true };
              throw error;
            }
          } finally {
            usage.inUse--;
            usage.lastUsed = Date.now();
            this.#lastUsed.set(conversationId, usage.lastUsed);
            if (property === "exec" && outcome !== undefined && interruptedExec(outcome)) {
              this.#interrupted.add(conversationId);
            }
            if (usage.inUse === 0) {
              this.#settle(conversationId, usage);
              // This env may now be the one a waiting call can evict.
              this.#serveQueue();
            }
          }
        };
      },
      set: (object, property, value) => {
        if (property === "cwd") object.cwd = String(value);
        return property === "cwd";
      },
    }) as unknown as ExecutionEnv;
  }

  /**
   * No call is in flight any more. An interrupted command means its sandbox may hold children that escaped the
   * process-group kill: replace the Pod. Otherwise the commands ended on their own and the in-flight record goes.
   */
  #settle(conversationId: number, usage: Usage): void {
    if (this.#interrupted.has(conversationId) && !this.#replacing.has(conversationId)) {
      this.#interrupted.delete(conversationId);
      this.#replace(conversationId, "interrupted", async () => {
        await this.#closeEnv(conversationId);
        await recyclePod(this.#config.namespace, claimNameFor(this.#config.shard, conversationId));
        // Cleared only now: if the recycle fails or the process dies first, the record is still there.
        await this.#hooks.execInFlight?.(conversationId, false);
        usage.recorded = false;
      });
    } else if (usage.recorded) {
      usage.recorded = false;
      void this.#hooks.execInFlight?.(conversationId, false).catch((error: unknown) => {
        usage.recorded = true; // still recorded: the next settle clears it
        log("exec-record-failed", {
          ...this.timings.fields(conversationId),
          claim: claimNameFor(this.#config.shard, conversationId),
          message: errorMessage(error),
        });
      });
    }
  }

  /**
   * Waits for a replacement under way, then makes sure no recycle is still owed. A failed recycle is retried here, by
   * the call that needs the Pod; if it fails again the call throws (the inbox retries the input) rather than run in a
   * Pod that may still hold an interrupted command's leftovers.
   */
  async #awaitCleanPod(conversationId: number): Promise<void> {
    await this.#replacing.get(conversationId);
    const owed = this.#failed.get(conversationId);
    if (owed === undefined) return;
    this.#replace(conversationId, owed.why, owed.work);
    await this.#replacing.get(conversationId);
    if (this.#failed.has(conversationId)) {
      throw new Error(
        `sandbox ${claimNameFor(this.#config.shard, conversationId)} could not be recycled after an interrupted command`,
      );
    }
  }

  /**
   * Runs a Pod replacement (recycle) or suspension for a conversation's sandbox. Calls made meanwhile wait for it.
   * A failure is logged; a failed recycle stays owed in `#failed` and blocks calls until a retry succeeds.
   */
  #replace(
    conversationId: number,
    why: "interrupted" | "orchestrator-restart" | "idle",
    work: () => Promise<void>,
  ): void {
    if (this.#replacing.has(conversationId)) return;
    const claim = claimNameFor(this.#config.shard, conversationId);
    const run = (async () => {
      await work();
      this.#failed.delete(conversationId);
      this.#lastUsed.delete(conversationId);
      log(why === "idle" ? "sandbox-suspended" : "sandbox-recycled", { claim, why });
    })()
      .catch((error: unknown) => {
        if (why !== "idle") this.#failed.set(conversationId, { why, work });
        log("sandbox-replace-failed", { claim, why, message: errorMessage(error) });
      })
      .finally(() => this.#replacing.delete(conversationId));
    this.#replacing.set(conversationId, run);
  }

  /**
   * After a start: the conversations that had a command in flight when the previous process stopped. Their Pods are
   * replaced before Pi Durable resumes (the caller invokes this first), so the continuing run finds a clean sandbox.
   * Nothing is known about which of them really has a leftover child, so every one is recycled.
   */
  recycleAtStart(conversationIds: readonly number[]): void {
    for (const conversationId of conversationIds) {
      this.#replace(conversationId, "orchestrator-restart", async () => {
        await recyclePod(this.#config.namespace, claimNameFor(this.#config.shard, conversationId));
        await this.#hooks.execInFlight?.(conversationId, false);
      });
    }
  }

  async #closeEnv(conversationId: number): Promise<void> {
    const opened = this.#envs.get(conversationId);
    if (this.#usage.get(conversationId)?.inUse === 0) this.#usage.delete(conversationId);
    this.#dropEnv(conversationId);
    if (opened !== undefined) (await opened.catch(() => undefined))?.close();
  }

  /** The claim name of a conversation of this orchestrator's shard. */
  claimOf(conversationId: number): string {
    return claimNameFor(this.#config.shard, conversationId);
  }

  /** Suspends the sandboxes that have been idle for `idleSuspendMs`. Never throws: it runs on a timer. */
  async #suspendIdle(): Promise<void> {
    try {
      const sandboxes = await listSandboxes(this.#config.namespace);
      const now = Date.now();
      const busy = new Set<number>(this.#replacing.keys());
      for (const [conversationId, usage] of this.#usage)
        if (usage.inUse > 0) busy.add(conversationId);
      for (const sandbox of sandboxes) {
        const conversationId = conversationOfName(this.#config.shard, sandbox.name);
        if (conversationId !== undefined && sandbox.mode === "Suspended")
          this.#lastUsed.delete(conversationId);
      }
      const plan = planSuspend({
        shard: this.#config.shard,
        running: sandboxes.filter((s) => s.mode === "Running").map((s) => s.name),
        lastUsed: this.#lastUsed,
        busy,
        now,
        afterMs: this.#config.sandbox.idleSuspendMs,
      });
      for (const conversationId of plan.seen) this.#lastUsed.set(conversationId, now);
      for (const conversationId of plan.suspend) {
        this.#replace(conversationId, "idle", async () => {
          await this.#closeEnv(conversationId);
          await suspendSandbox(
            this.#config.namespace,
            claimNameFor(this.#config.shard, conversationId),
          );
        });
      }
    } catch (error) {
      log("suspend-scan-failed", { message: errorMessage(error) });
    }
  }

  /**
   * Creates or adopts the claim and waits for its Sandbox; safe to call on every start. At `maxOpenBridges` open or
   * opening envs, a new one first evicts the least recently used env with nothing in use; if every env is in use the
   * call waits in a FIFO queue until a slot frees. `signal` ends that wait (and only the wait).
   */
  async ensure(conversationId: number, signal?: AbortSignal): Promise<SandboxEnv> {
    const existing = this.#envs.get(conversationId);
    if (existing !== undefined) return existing;
    const { maxOpenBridges } = this.#config.sandbox;
    // An earlier waiter goes first even when a slot happens to be free right now.
    if (
      this.#slotQueue.length === 0 &&
      (this.#envs.size < maxOpenBridges || this.#evictLeastRecentlyUsed())
    )
      return this.#start(conversationId);
    if (signal?.aborted === true) throw new Error("aborted while waiting for a bridge slot");
    const waiter = new Promise<SandboxEnv>((resolve, reject) => {
      // A long-lived signal must not keep a served or rejected waiter (and its env) alive.
      const onAbort = (): void => {
        const at = this.#slotQueue.indexOf(entry);
        if (at < 0) return;
        this.#slotQueue.splice(at, 1);
        reject(new Error("aborted while waiting for a bridge slot"));
        // The head may have been the one that could not be served.
        this.#serveQueue();
      };
      const entry: SlotWaiter = {
        conversationId,
        resolve: (env) => {
          signal?.removeEventListener("abort", onAbort);
          resolve(env);
        },
        reject,
      };
      this.#slotQueue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    log("bridge-cap-wait", {
      ...this.timings.fields(conversationId),
      claim: claimNameFor(this.#config.shard, conversationId),
      open: this.#envs.size,
      max: capField(maxOpenBridges),
      waiting: this.#slotQueue.length,
    });
    return await waiter;
  }

  /** Registers a new env, which takes a slot until it is dropped (closed, evicted or failed to open). */
  #start(conversationId: number): Promise<SandboxEnv> {
    const env = this.#open(conversationId);
    this.#envs.set(conversationId, env);
    this.#opening.set(conversationId, env);
    const settled = (): void => {
      if (this.#opening.get(conversationId) === env) this.#opening.delete(conversationId);
    };
    env.then(settled, settled);
    if (!this.#usage.has(conversationId))
      this.#usage.set(conversationId, { inUse: 0, lastUsed: Date.now(), recorded: false });
    // A failed open must not be cached: the next tool call tries again. Its slot goes to the next waiter.
    env.catch(() => {
      if (this.#envs.get(conversationId) === env) this.#dropEnv(conversationId);
    });
    return env;
  }

  async #open(conversationId: number): Promise<SandboxEnv> {
    const claimName = claimNameFor(this.#config.shard, conversationId);
    const { namespace, warmPool } = this.#config;
    // Required: a sandbox with no token would be unauthenticated or unreachable. Only the hash goes into the claim.
    const master = process.env[ENV.masterKey];
    if (master === undefined || master === "") throw new Error(`${ENV.masterKey} is not set`);
    const token = deriveSandboxToken(master, claimName);
    this.timings.mark(conversationId, "claim-requested");
    try {
      // Create the claim with the session label, or accept an existing one only if the label matches. The SDK
      // then adopts it by name.
      const created = await ensureLabeledClaim(
        namespace,
        claimName,
        warmPool,
        await this.#sessionKeyOf(conversationId),
        [{ name: SANDBOXD_TOKEN_SHA256_ENV, value: sandboxTokenSha256(token) }],
      );
      if (created) this.timings.setState(conversationId, "cold");
      // A suspended sandbox is never Ready, so the wait below would only time out: resume it first.
      if (await resumeIfSuspended(namespace, claimName)) {
        this.timings.setState(conversationId, "resumed");
        log("sandbox-resumed", { ...this.timings.fields(conversationId), claim: claimName });
      }
      await ensureClaim({
        claimName,
        namespace,
        warmPool,
        connectivity: "in-cluster-service",
        authToken: token,
      });
    } catch (error) {
      log("claim-failed", {
        ...this.timings.fields(conversationId),
        claim: claimName,
        message: errorMessage(error),
      });
      throw error;
    }
    await this.#hooks.attached?.(claimName);
    this.timings.mark(conversationId, "claim-ready");
    log("claim-ready", { ...this.timings.fields(conversationId), claim: claimName });
    // Credentials for a repo session's commands only; plain sessions get nothing here. The token travels through the
    // pi-env protocol to the daemon. The sandboxd token stays in this process (the env's broker uses it); the relay
    // child that bridgeCommand starts has a trimmed environment and no token.
    const shellEnv = await this.#hooks.shellEnv?.(conversationId);
    const opened = connectSandboxEnv({
      claimName,
      namespace,
      cwd: WORKSPACE,
      id: `pi-env:${claimName}`,
      authToken: token,
      relayCommand: bridgeCommand(process.env),
      ...(shellEnv === undefined ? {} : { shellEnv }),
      onPhase: (phase) => {
        if (phase === "bridge-ready") this.#bridgeUp.add(conversationId);
        else this.#bridgeUp.delete(conversationId);
        this.timings.mark(conversationId, phase);
      },
    });
    try {
      await this.#hooks.prepareEnv?.(conversationId, opened.env);
    } catch (error) {
      opened.close();
      log("env-prepare-failed", {
        ...this.timings.fields(conversationId),
        claim: claimName,
        message: errorMessage(error),
      });
      throw error;
    }
    return opened;
  }

  /**
   * Session deletion: stops the bridge, then deletes the SandboxClaim and the PVC. Idempotent, so a deletion cut
   * off by a crash is simply run again. With `destroyOrphan` the only place that deletes a claim.
   */
  async destroy(conversationId: number): Promise<void> {
    await this.#teardown(conversationId, await this.#sessionKeyOf(conversationId));
  }

  /**
   * The orphan sweep's delete: the same teardown as a session deletion, for a claim whose session is deleted or
   * unknown. `sessionLabel` is the label the sweep read from the claim, so `deleteClaimAndPvc` still refuses a
   * claim that changed hands meanwhile.
   */
  async destroyOrphan(claimName: string, sessionLabel: string): Promise<void> {
    const conversationId = conversationOfName(this.#config.shard, claimName);
    if (conversationId === undefined) throw new Error(`${claimName} is not a conversation claim`);
    await this.#teardown(conversationId, sessionLabel);
  }

  async #teardown(conversationId: number, sessionKey: string): Promise<void> {
    await this.#replacing.get(conversationId);
    this.#interrupted.delete(conversationId);
    this.#failed.delete(conversationId);
    this.#lastUsed.delete(conversationId);
    this.timings.clear(conversationId);
    const opened = this.#envs.get(conversationId);
    this.#usage.delete(conversationId);
    this.#dropEnv(conversationId);
    if (opened !== undefined) {
      const env = await opened.catch(() => undefined);
      env?.close();
    }
    const claimName = claimNameFor(this.#config.shard, conversationId);
    await deleteClaimAndPvc(this.#config.namespace, claimName, sessionKey);
    log("sandbox-deleted", { claim: claimName });
  }

  /** Stops every bridge. Never deletes a claim. */
  async closeAll(): Promise<void> {
    this.stop();
    const opened = await Promise.allSettled([...this.#envs.values()]);
    for (const result of opened) if (result.status === "fulfilled") result.value.close();
    this.#envs.clear();
  }
}
