import { errorMessage } from "@cela/session-core";
import { log } from "./log.js";

/** An open transaction older than this holds the owner feed back long enough to be worth a warning (ADR 0058). */
export const FEED_LAG_WARN_SECONDS = 60;

export interface FeedMaintenanceDeps {
  /** Deletes rows past retention and moves the horizon; returns how many went. */
  prune: () => Promise<number>;
  /** Age of the oldest open transaction, which delays (never loses) feed rows. */
  lagSeconds: () => Promise<number>;
}

/**
 * Shard 0's periodic work on the owner feed (ADR 0058): retention and the lag warning. The feed is shared by every
 * shard, so one shard does it, like the other shared rows (ADR 0017).
 */
export class FeedMaintenanceLoop {
  readonly #deps: FeedMaintenanceDeps;
  #running = false;
  #timer: NodeJS.Timeout | undefined;

  constructor(deps: FeedMaintenanceDeps) {
    this.#deps = deps;
  }

  start(intervalMs: number): void {
    this.#timer = setInterval(() => void this.run(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /** One pass; never throws. Skipped while the previous one still runs. */
  async run(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const lag = await this.#deps.lagSeconds();
      if (lag > FEED_LAG_WARN_SECONDS) log("feed-lag", { level: "warn", seconds: lag });
      const deleted = await this.#deps.prune();
      if (deleted > 0) log("feed-pruned", { rows: deleted });
    } catch (error) {
      log("feed-maintenance-failed", { message: errorMessage(error) });
    } finally {
      this.#running = false;
    }
  }
}
