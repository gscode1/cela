import type { SessionRef } from "@pi-durable-k8s/session-core";
import { errorMessage, log } from "./log.js";
import { planSweep } from "./sweep.js";
import type { SweepAction, SweepAgent, SweepClaim, SweepPvc, SweepSecret } from "./sweep.js";

export interface SweeperDeps {
  listSessions: () => Promise<SessionRef[]>;
  listClaims: () => Promise<SweepClaim[]>;
  listPvcs: () => Promise<SweepPvc[]>;
  /** Undefined when OneCLI is not configured: the sweep then leaves agents alone. */
  listOneCli: (() => Promise<{ agents: SweepAgent[]; secrets: SweepSecret[] }>) | undefined;
  /** The session deletion's teardown: stops the bridge, deletes the claim, then the PVC. Also removes a lone PVC. */
  destroyClaim: (claimName: string, sessionLabel: string) => Promise<void>;
  revokeSession: (sessionId: string) => Promise<void>;
  graceMs: number;
  maxActions: number;
  now?: () => number;
}

/**
 * The execution half of the orphan sweep: reads the world, asks `planSweep` what is orphaned, does it, logs each
 * action. One run at a time. A failing action is logged and the run goes on; the next run retries it. The log lines
 * carry names and ids only, never a token or secret value.
 */
export class OrphanSweeper {
  readonly #deps: SweeperDeps;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: SweeperDeps) {
    this.#deps = deps;
  }

  start(intervalMs: number): void {
    if (intervalMs <= 0) {
      log("sweep-disabled", {});
      return;
    }
    this.#timer = setInterval(() => void this.run(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One sweep. Returns the actions that succeeded; never throws. */
  async run(): Promise<SweepAction[]> {
    if (this.#running) return [];
    this.#running = true;
    const done: SweepAction[] = [];
    try {
      const d = this.#deps;
      // Resources first, sessions last. A session row exists before any of its objects does, so a session whose object
      // was listed here is in a snapshot taken after the listing; the other order let a session created in between
      // look unknown and have its fresh OneCLI agent revoked (secrets have no grace age).
      // Kubernetes and OneCLI are listed independently: an outage of one must not stop cleanup in the other. Claims and
      // PVCs stand or fall together, because a PVC is orphaned only if no claim of that name exists.
      const [kube, oneCli] = await Promise.all([
        Promise.all([d.listClaims(), d.listPvcs()]).catch((error: unknown) => {
          log("sweep-list-failed", { source: "kubernetes", message: errorMessage(error) });
          return undefined;
        }),
        (d.listOneCli?.() ?? Promise.resolve(undefined)).catch((error: unknown) => {
          log("sweep-list-failed", { source: "onecli", message: errorMessage(error) });
          return undefined;
        }),
      ]);
      const sessions = await d.listSessions();
      const [claims, pvcs] = kube ?? [[], []];
      const actions = planSweep({
        sessions,
        claims,
        pvcs,
        // A failed or unconfigured OneCLI listing leaves agents alone.
        agents: oneCli?.agents,
        secrets: oneCli?.secrets ?? [],
        now: d.now?.() ?? Date.now(),
        graceMs: d.graceMs,
        maxActions: d.maxActions,
      });
      for (const action of actions) {
        try {
          await this.#apply(action);
          log("sweep-action", { ...action });
          done.push(action);
        } catch (error) {
          log("sweep-action-failed", { ...action, message: errorMessage(error) });
        }
      }
      if (actions.length > 0) log("sweep-done", { planned: actions.length, done: done.length });
    } catch (error) {
      log("sweep-failed", { message: errorMessage(error) });
    } finally {
      this.#running = false;
    }
    return done;
  }

  async #apply(action: SweepAction): Promise<void> {
    switch (action.kind) {
      case "delete-claim":
        return this.#deps.destroyClaim(action.claim, action.sessionLabel);
      case "delete-pvc":
        // The claim does not exist, so there is no label to check; deleteClaimAndPvc refuses if one appears meanwhile.
        return this.#deps.destroyClaim(action.claim, "orphan-pvc-sweep");
      case "revoke-agent":
        return this.#deps.revokeSession(action.sessionId);
    }
  }
}
