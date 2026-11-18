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

/** A submission once it settled; undefined when Pi Durable never admitted it. */
export type Settlement = Extract<SubmissionState, { status: "done" | "unanswered" }> | undefined;

export interface RunWatcherOptions {
  /** Resolves once the submission settles (`Host.settlement`, built on `Submission.wait()`). */
  settle: (conversationId: number, requestId: string) => Promise<Settlement>;
  /** A submission ended `unanswered`: the run it belonged to failed or was aborted. Called once per submission. */
  onUnanswered: (watched: Watched, outcome: RunOutcome) => Promise<void>;
  /** A submission was answered. A run queued behind it may have started right away. */
  onDone?: (watched: Watched) => Promise<void>;
  onError?: (error: unknown) => void;
  /** Wait before retrying a failed `settle` or handler; tests shorten it. */
  retryMs?: number;
}

/**
 * Notices runs that end without an answer. Pi Durable reports a model error only inside the conversation (the run's
 * submissions settle `unanswered` with the reason and error text), not through `onReport`, so the orchestrator awaits
 * each submission it handed over with `Submission.wait()`. A run that a previous process started and this one resumed
 * is covered the same way: `add` it again at start. Each watch is its own promise, so a slow handler never holds back
 * the others; a failed `settle` or handler is retried until `stop()`, so a storage hiccup does not lose the failure.
 */
export class RunWatcher {
  readonly #options: RunWatcherOptions;
  readonly #pending = new Map<string, Promise<void>>();
  #stopped = false;

  constructor(options: RunWatcherOptions) {
    this.#options = options;
  }

  add(watched: Watched): void {
    if (this.#stopped) return;
    const key = `${String(watched.conversationId)}/${watched.requestId}`;
    if (this.#pending.has(key)) return;
    const followed = this.#follow(watched).finally(() => this.#pending.delete(key));
    this.#pending.set(key, followed);
  }

  get size(): number {
    return this.#pending.size;
  }

  /** Resolves once every watch added so far ended. Exposed so tests need no timers. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending.values()]);
  }

  /** Stops retrying. A wait in flight ends when the Harness closes and is then dropped. */
  stop(): void {
    this.#stopped = true;
  }

  /** A call, not a field read: `stop()` can run while `#retry` awaits, which flow narrowing cannot see. */
  #isStopped(): boolean {
    return this.#stopped;
  }

  async #follow(watched: Watched): Promise<void> {
    const settled = await this.#retry(() =>
      this.#options.settle(watched.conversationId, watched.requestId),
    );
    if (settled === undefined || settled.value === undefined) return;
    const state = settled.value;
    if (state.status === "done") {
      const onDone = this.#options.onDone;
      if (onDone !== undefined) await this.#retry(() => onDone(watched));
      return;
    }
    const detail =
      typeof state.detail === "string"
        ? state.detail
        : state.detail === undefined
          ? undefined
          : JSON.stringify(state.detail);
    const outcome = { reason: state.reason, ...(detail === undefined ? {} : { detail }) };
    await this.#retry(() => this.#options.onUnanswered(watched, outcome));
  }

  /** Runs `work` until it succeeds; undefined once stopped. */
  async #retry<T>(work: () => Promise<T>): Promise<{ value: T } | undefined> {
    while (!this.#isStopped()) {
      try {
        return { value: await work() };
      } catch (error) {
        // A wait rejected by the Harness closing at shutdown is not an error worth logging.
        if (this.#isStopped()) return undefined;
        this.#options.onError?.(error);
        // Unref'd like the old poll timer: a watch waiting to retry must not keep the process alive.
        await new Promise((resolve) => setTimeout(resolve, this.#options.retryMs ?? 2_000).unref());
      }
    }
    return undefined;
  }
}
