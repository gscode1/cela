import type { RunOutcome } from "./failure.js";

/** One input the orchestrator handed to Pi Durable and has not yet seen settled. */
export interface Watched {
  sessionId: string;
  conversationId: number;
  /** The inbox row id: the Pi Durable `requestId` of the submission. */
  requestId: string;
}

/** What the storage says about a submission; only the fields the watcher reads. */
export type SubmissionState =
  | { status: "queued" | "placed" }
  | { status: "done" }
  | { status: "unanswered"; reason: string; detail?: unknown };

export interface RunWatcherOptions {
  lookup: (conversationId: number, requestId: string) => Promise<SubmissionState | undefined>;
  /** A submission ended `unanswered`: the run it belonged to failed or was aborted. Called once per submission. */
  onUnanswered: (watched: Watched, outcome: RunOutcome) => Promise<void>;
  pollMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Notices runs that end without an answer. Pi Durable reports a model error only inside the conversation (the run's
 * submissions settle `unanswered` with the reason and error text), not to the host, so the orchestrator reads the
 * submissions it handed over until each is settled. Polling the storage also covers a run that a previous process
 * started and this one resumed: `add` it again at start and it is picked up the same way.
 */
export class RunWatcher {
  readonly #options: RunWatcherOptions;
  readonly #pending = new Map<string, Watched>();
  #timer: NodeJS.Timeout | undefined;
  #polling = false;
  /** Submissions whose handler is running: later passes leave them alone. */
  readonly #handling = new Set<string>();

  constructor(options: RunWatcherOptions) {
    this.#options = options;
  }

  add(watched: Watched): void {
    this.#pending.set(`${String(watched.conversationId)}/${watched.requestId}`, watched);
    this.#timer ??= setInterval(() => void this.poll(), this.#options.pollMs ?? 2_000);
    this.#timer.unref();
  }

  get size(): number {
    return this.#pending.size;
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * One pass over the pending submissions. Exposed so tests need no timers. The lookups run one after the other, but a
   * handler runs on its own: `onUnanswered` aborts the run and resolves only once the conversation is idle, which can
   * take as long as a tool call, and must not hold back the failure detection of every other watch.
   */
  async poll(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    const handlers: Promise<void>[] = [];
    try {
      for (const [key, watched] of [...this.#pending]) {
        if (this.#handling.has(key)) continue;
        try {
          const state = await this.#options.lookup(watched.conversationId, watched.requestId);
          if (state === undefined || state.status === "done") {
            this.#pending.delete(key);
          } else if (state.status === "unanswered") {
            const detail =
              typeof state.detail === "string"
                ? state.detail
                : state.detail === undefined
                  ? undefined
                  : JSON.stringify(state.detail);
            this.#handling.add(key);
            handlers.push(
              this.#handle(key, watched, {
                reason: state.reason,
                ...(detail === undefined ? {} : { detail }),
              }),
            );
          }
        } catch (error) {
          // Keep it pending: a storage hiccup must not lose the watch, nor crash the orchestrator.
          this.#options.onError?.(error);
        }
      }
    } finally {
      this.#polling = false;
    }
    await Promise.all(handlers);
    if (this.#pending.size === 0) this.stop();
  }

  async #handle(key: string, watched: Watched, outcome: RunOutcome): Promise<void> {
    try {
      await this.#options.onUnanswered(watched, outcome);
      // Only now: a handler that threw leaves the watch in place, so the failure is not lost.
      this.#pending.delete(key);
    } catch (error) {
      this.#options.onError?.(error);
    } finally {
      this.#handling.delete(key);
    }
  }
}
