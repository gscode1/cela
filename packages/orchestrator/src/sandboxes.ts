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
import { fileURLToPath } from "node:url";
import {
  deleteClaimAndPvc,
  ensureLabeledClaim,
  listSandboxes,
  recyclePod,
  resumeIfSuspended,
  suspendSandbox,
} from "./kube.js";
import { conversationOfName, interruptedExec, planSuspend } from "./lifecycle.js";
import { errorMessage, log } from "./log.js";

export const WORKSPACE = "/workspace";

/** The value of the claim's session label for a conversation: the API session UUID. */
export type SessionKeyOf = (conversationId: number) => Promise<string>;

/** The bridge is started through this launcher so it does not inherit the orchestrator's secrets. */
const BRIDGE_LAUNCHER = fileURLToPath(new URL("./bridge-launcher.js", import.meta.url));

/** Per-session hooks for repo sessions (Phase 4c). Plain sessions ignore them: both answer "nothing". */
export interface SandboxHooks {
  /** Extra environment for this conversation's tool commands (pi-env `shellEnv`), set when its env is opened. */
  shellEnv?: (conversationId: number) => Promise<Record<string, string> | undefined>;
  /** Runs before every call on an open env; renews credentials that are about to expire. */
  beforeUse?: (conversationId: number) => Promise<void>;
  /**
   * Durable record of "a command may be running in this conversation's sandbox". Set before a burst of commands
   * starts and cleared once the sandbox is known clean. A process that dies mid-command never clears it, so the
   * next one recycles that sandbox's Pod (see `Sandboxes.recycleAtStart`).
   */
  execInFlight?: (conversationId: number, inFlight: boolean) => Promise<void>;
}

/** Per open env: calls in flight, when one last ended, and whether the in-flight record is set. */
interface Usage {
  inUse: number;
  lastUsed: number;
  recorded: boolean;
}

/** One conversation maps to one SandboxClaim, named from the conversation id (and so to one PVC). */
export function claimNameFor(conversationId: number): string {
  return `pi-conv-${String(conversationId)}`;
}

/**
 * One long-lived sandbox env per conversation. The env's Connection restarts its bridge by itself,
 * so a recreated sandbox Pod needs no handling here beyond the claim staying put.
 */
export class Sandboxes {
  readonly #config: OrchestratorConfig;
  readonly #envs = new Map<number, Promise<SandboxEnv>>();

  /** Per open env. Drives idle eviction. */
  readonly #usage = new Map<number, Usage>();
  readonly #timers: NodeJS.Timeout[] = [];

  /**
   * Last use of each conversation's sandbox as this process saw it. Unlike `#usage` it outlives an evicted env: it is
   * what idle suspension measures. Entries go when the sandbox is suspended, recycled or deleted.
   */
  readonly #lastUsed = new Map<number, number>();
  /** Conversations whose last command was interrupted, to be recycled once no call is in flight. */
  readonly #interrupted = new Set<number>();
  /** A recycle or suspend under way. Calls wait for it before opening the env, so none reaches a dying Pod. */
  readonly #replacing = new Map<number, Promise<void>>();

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
    for (const timer of this.#timers) timer.unref();
  }

  /** Stops the timers. Bridges and sandboxes stay as they are. */
  stop(): void {
    for (const timer of this.#timers) clearInterval(timer);
  }

  #evictIdle(idleMs: number): void {
    const now = Date.now();
    for (const [conversationId, usage] of this.#usage) {
      if (usage.inUse > 0 || now - usage.lastUsed < idleMs) continue;
      const opened = this.#envs.get(conversationId);
      this.#usage.delete(conversationId);
      this.#envs.delete(conversationId);
      void opened?.then((env) => {
        env.close();
        log("sandbox-env-evicted", { claim: claimNameFor(conversationId) });
      });
    }
  }

  /**
   * The env handed to Pi Durable. Pi Durable asks for it at every model request, before any tool runs, so
   * building the real env there would create a SandboxClaim for a session that only chats. This stand-in
   * does nothing until a method is first called (a tool call), then creates or adopts the claim and
   * forwards to the real env. `id` and `cwd` are plain properties; every other member is an async method.
   */
  lazyEnv(conversationId: number): ExecutionEnv {
    const target = { id: `pi-env:${claimNameFor(conversationId)}`, cwd: WORKSPACE };
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
          let outcome: { threw: true } | { threw: false; result: unknown } | undefined;
          try {
            // A recycle or suspend of this sandbox finishes first; the env opened below is then for the new Pod.
            await this.#replacing.get(conversationId);
            await this.#hooks.beforeUse?.(conversationId);
            const real = (await this.ensure(conversationId)).env as unknown as Record<
              string,
              (...a: unknown[]) => unknown
            >;
            // Only commands can leave processes behind. Record that one may be running before it starts, so a
            // crash in the middle is still known after the restart.
            if (property === "exec" && !usage.recorded) {
              await this.#hooks.execInFlight?.(conversationId, true);
              usage.recorded = true;
            }
            try {
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
            if (usage.inUse === 0) this.#settle(conversationId, usage);
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
        await recyclePod(this.#config.namespace, claimNameFor(conversationId));
        // Cleared only now: if the recycle fails or the process dies first, the record is still there.
        await this.#hooks.execInFlight?.(conversationId, false);
        usage.recorded = false;
      });
    } else if (usage.recorded) {
      usage.recorded = false;
      void this.#hooks.execInFlight?.(conversationId, false).catch((error: unknown) => {
        usage.recorded = true; // still recorded: the next settle clears it
        log("exec-record-failed", {
          claim: claimNameFor(conversationId),
          message: errorMessage(error),
        });
      });
    }
  }

  /**
   * Runs a Pod replacement (recycle) or suspension for a conversation's sandbox. Calls made meanwhile wait for it.
   * A failure is logged and leaves the conversation to try again: an interrupted one stays queued.
   */
  #replace(
    conversationId: number,
    why: "interrupted" | "orchestrator-restart" | "idle",
    work: () => Promise<void>,
  ): void {
    if (this.#replacing.has(conversationId)) return;
    const claim = claimNameFor(conversationId);
    const run = (async () => {
      await work();
      this.#lastUsed.delete(conversationId);
      log(why === "idle" ? "sandbox-suspended" : "sandbox-recycled", { claim, why });
    })()
      .catch((error: unknown) => {
        if (why !== "idle") this.#interrupted.add(conversationId);
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
        await recyclePod(this.#config.namespace, claimNameFor(conversationId));
        await this.#hooks.execInFlight?.(conversationId, false);
      });
    }
  }

  async #closeEnv(conversationId: number): Promise<void> {
    const opened = this.#envs.get(conversationId);
    if (this.#usage.get(conversationId)?.inUse === 0) this.#usage.delete(conversationId);
    this.#envs.delete(conversationId);
    if (opened !== undefined) (await opened.catch(() => undefined))?.close();
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
        const conversationId = conversationOfName(sandbox.name);
        if (conversationId !== undefined && sandbox.mode === "Suspended")
          this.#lastUsed.delete(conversationId);
      }
      const plan = planSuspend({
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
          await suspendSandbox(this.#config.namespace, claimNameFor(conversationId));
        });
      }
    } catch (error) {
      log("suspend-scan-failed", { message: errorMessage(error) });
    }
  }

  /** Creates or adopts the claim and waits for its Sandbox; safe to call on every start. */
  async ensure(conversationId: number): Promise<SandboxEnv> {
    let env = this.#envs.get(conversationId);
    if (env === undefined) {
      env = this.#open(conversationId);
      this.#envs.set(conversationId, env);
      // A failed open must not be cached: the next tool call tries again.
      env.catch(() => this.#envs.delete(conversationId));
    }
    return env;
  }

  async #open(conversationId: number): Promise<SandboxEnv> {
    const claimName = claimNameFor(conversationId);
    const { namespace, warmPool } = this.#config;
    // Required: a sandbox with no token would be unauthenticated or unreachable. Only the hash goes into the claim.
    const master = process.env[ENV.masterKey];
    if (master === undefined || master === "") throw new Error(`${ENV.masterKey} is not set`);
    const token = deriveSandboxToken(master, claimName);
    try {
      // Create the claim with the session label, or accept an existing one only if the label matches. The SDK
      // then adopts it by name.
      await ensureLabeledClaim(
        namespace,
        claimName,
        warmPool,
        await this.#sessionKeyOf(conversationId),
        [{ name: SANDBOXD_TOKEN_SHA256_ENV, value: sandboxTokenSha256(token) }],
      );
      // A suspended sandbox is never Ready, so the wait below would only time out: resume it first.
      if (await resumeIfSuspended(namespace, claimName))
        log("sandbox-resumed", { claim: claimName });
      await ensureClaim({
        claimName,
        namespace,
        warmPool,
        connectivity: "in-cluster-service",
        authToken: token,
      });
    } catch (error) {
      log("claim-failed", { claim: claimName, message: errorMessage(error) });
      throw error;
    }
    log("claim-ready", { claim: claimName });
    // Credentials for a repo session's commands only; plain sessions get nothing here. The token travels through the
    // pi-env protocol to the daemon, never through the bridge process environment (bridge-launcher derives its own claim's token and drops the master).
    const shellEnv = await this.#hooks.shellEnv?.(conversationId);
    return connectSandboxEnv({
      claimName,
      namespace,
      cwd: WORKSPACE,
      id: `pi-env:${claimName}`,
      bridgeCommand: [process.execPath, BRIDGE_LAUNCHER],
      ...(shellEnv === undefined ? {} : { shellEnv }),
    });
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
    const conversationId = conversationOfName(claimName);
    if (conversationId === undefined) throw new Error(`${claimName} is not a conversation claim`);
    await this.#teardown(conversationId, sessionLabel);
  }

  async #teardown(conversationId: number, sessionKey: string): Promise<void> {
    await this.#replacing.get(conversationId);
    this.#interrupted.delete(conversationId);
    this.#lastUsed.delete(conversationId);
    const opened = this.#envs.get(conversationId);
    this.#usage.delete(conversationId);
    this.#envs.delete(conversationId);
    if (opened !== undefined) {
      const env = await opened.catch(() => undefined);
      env?.close();
    }
    const claimName = claimNameFor(conversationId);
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
