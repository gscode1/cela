import type pg from "pg";
import { errorMessage } from "./http.js";
import type { ModelPolicy, ThinkingLevel } from "./models.js";
import { policyOf, readSettings, SETTINGS_CHANNEL, settingsEqual } from "./settings.js";
import type { Settings } from "./settings.js";

export interface SettingsCacheOptions {
  /** Poll interval; the safety net for a missed notification. */
  pollMs?: number;
  /** Wait before the LISTEN connection is re-established. */
  relistenMs?: number;
  /** Used until the row can be read (the orchestrator, which does not seed): the environment's values. */
  fallback?: Settings;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/**
 * What ingest and the orchestrator read settings through. Loads at start, refreshes on a notification of channel
 * `pi_settings` (sent by the writer in the same transaction) and on a poll. A failed or invalid read keeps the last
 * good value and logs: settings are never a reason to crash.
 */
export class SettingsCache {
  readonly #pool: pg.Pool;
  readonly #pollMs: number;
  readonly #relistenMs: number;
  readonly #log: NonNullable<SettingsCacheOptions["log"]>;
  #current: Settings | undefined;
  #loaded = false;
  #listener: pg.PoolClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #queue: Promise<void> = Promise.resolve();
  #lastError: string | undefined;

  constructor(pool: pg.Pool, options: SettingsCacheOptions = {}) {
    this.#pool = pool;
    this.#pollMs = options.pollMs ?? 30_000;
    this.#relistenMs = options.relistenMs ?? 2_000;
    this.#log = options.log ?? (() => undefined);
    this.#current = options.fallback;
  }

  /** Loads once (a failure is logged, not thrown), then listens and polls. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.refresh(), this.#pollMs);
    this.#timer.unref();
    void this.#listen();
  }

  stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#releaseListener();
    return Promise.resolve();
  }

  /** Releases the listener client once; a second call (stop during the relisten delay) is a no-op, and never throws. */
  #releaseListener(): void {
    const client = this.#listener;
    this.#listener = undefined;
    if (client === undefined) return;
    try {
      client.removeAllListeners();
      client.release(true);
    } catch {
      // Already released or destroyed: nothing left to do.
    }
  }

  /** Reads the row now. Reads are serialised, so the last one issued is the last one applied. */
  refresh(): Promise<void> {
    this.#queue = this.#queue.then(() => this.#load());
    return this.#queue;
  }

  /** True once the row has been read, false while the fallback (or nothing) is in use. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** The last good settings. Throws only if nothing was ever read and there is no fallback. */
  get(): Settings {
    if (this.#current === undefined) throw new Error("settings are not loaded yet");
    return this.#current;
  }

  policy(): ModelPolicy {
    return policyOf(this.get());
  }

  /** Reasoning effort of a new session when the request names none (per-session override: issue #37). */
  defaultReasoning(): ThinkingLevel | undefined {
    return this.get().reasoning ?? undefined;
  }

  turnBudget(): number {
    return this.get().turnBudget;
  }

  async #load(): Promise<void> {
    try {
      const stored = await readSettings(this.#pool);
      if (stored === undefined) {
        this.#report("settings-row-missing");
        return;
      }
      this.#lastError = undefined;
      const changed = this.#current === undefined || !settingsEqual(this.#current, stored.settings);
      this.#current = stored.settings;
      this.#loaded = true;
      if (changed) this.#log("settings-loaded", { updatedBy: stored.updatedBy });
    } catch (error) {
      this.#report("settings-load-failed", errorMessage(error));
    }
  }

  /** Logs a problem once per distinct message, so a poll does not repeat it every 30 s. */
  #report(event: string, message?: string): void {
    const key = `${event}:${message ?? ""}`;
    if (this.#lastError === key) return;
    this.#lastError = key;
    this.#log(event, message === undefined ? {} : { message });
  }

  /** A method, not a field read: TypeScript narrows `#stopped` to false inside the loop, but stop() can flip it at an await. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  async #listen(): Promise<void> {
    while (!this.#stopped) {
      try {
        const client = await this.#pool.connect();
        // stop() ran while the connect was pending, so it found no listener to release.
        if (this.#isStopped()) {
          client.release(true);
          return;
        }
        this.#listener = client;
        await new Promise<void>((resolve) => {
          client.on("notification", () => void this.refresh());
          client.on("error", () => resolve());
          client.on("end", () => resolve());
          client
            .query(`listen ${SETTINGS_CHANNEL}`)
            // A change between the load and the LISTEN would otherwise wait for the poll.
            .then(() => this.refresh())
            .catch(() => resolve());
        });
        this.#releaseListener();
      } catch (error) {
        this.#log("settings-listen-failed", { message: errorMessage(error) });
      }
      await new Promise((resolve) => setTimeout(resolve, this.#relistenMs));
    }
  }
}
