import { BRIDGE_READY } from "./bridge.js";

/**
 * Lets one bridge cold-start at a time. A bridge process loads the Kubernetes and gRPC clients before it
 * can answer pi-env's hello, which takes about 12 s of wall time on the orchestrator's 250m CPU limit.
 * Several at once share that CPU, each takes several times longer, and pi-env gives up on a connection
 * that stays silent for 30 s ("pi-env connection timed out"). Serialising the starts keeps each one fast.
 */
export class StartGate {
  readonly #maxHoldMs: number;
  #tail: Promise<void> = Promise.resolve();

  /** `maxHoldMs` frees the turn even if the holder never reports ready (a bridge that crashed early). */
  constructor(maxHoldMs: number) {
    this.#maxHoldMs = maxHoldMs;
  }

  /**
   * Resolves on this caller's turn. The returned release hands the turn on; calling it again is a no-op. Aborting
   * `signal` while waiting gives the turn up at once and rejects: a waiter that is gone must not take the gate later
   * and hold it until `maxHoldMs`.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => mine);
    const cancelled = new Promise<never>((_resolve, reject) => {
      const cancel = (): void => {
        release();
        reject(new Error("start gate wait cancelled"));
      };
      if (signal?.aborted === true) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
    // Nobody may be waiting on `cancelled` any more once `previous` won; it must not become an unhandled rejection.
    cancelled.catch(() => undefined);
    await Promise.race([previous, cancelled]);
    const timer = setTimeout(release, this.#maxHoldMs);
    timer.unref();
    return () => {
      clearTimeout(timer);
      release();
    };
  }
}

export interface GatedStart {
  /** For `ConnectionOptions.command`: waits for the gate, then yields the bridge argv. */
  command: () => Promise<readonly string[]>;
  /** For `ConnectionOptions.onLog`: frees the gate when the bridge reports ready. */
  onLog: (text: string) => void;
  /** On close: frees the gate if this connection holds it, and cancels a turn it is still waiting for. */
  release: () => void;
}

/**
 * Wires one connection's bridge launches through `gate`; every respawn takes a new turn. `argv` may be a function,
 * called once per launch after the turn is taken (the broker's relay needs a fresh nonce each time).
 */
export function gatedStart(
  gate: StartGate,
  argv: readonly string[] | (() => readonly string[] | Promise<readonly string[]>),
): GatedStart {
  let release: (() => void) | undefined;
  let waiting: AbortController | undefined;
  const free = (): void => {
    release?.();
    release = undefined;
  };
  return {
    command: async () => {
      free();
      const mine = new AbortController();
      waiting = mine;
      try {
        release = await gate.acquire(mine.signal);
      } finally {
        if (waiting === mine) waiting = undefined;
      }
      return typeof argv === "function" ? await argv() : argv;
    },
    onLog: (text) => {
      if (text.includes(BRIDGE_READY)) free();
    },
    release: () => {
      // A command() still waiting for its turn must give it up, or it would take the gate after the close.
      waiting?.abort();
      free();
    },
  };
}
