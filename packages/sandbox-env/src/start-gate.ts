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

  /** Resolves on this caller's turn. The returned release hands the turn on; calling it again is a no-op. */
  async acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => mine);
    await previous;
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
  /** Frees the gate if this connection still holds it (on close). */
  release: () => void;
}

/** Wires one connection's bridge launches through `gate`; every respawn takes a new turn. */
export function gatedStart(gate: StartGate, argv: readonly string[]): GatedStart {
  let release: (() => void) | undefined;
  const free = (): void => {
    release?.();
    release = undefined;
  };
  return {
    command: async () => {
      free();
      release = await gate.acquire();
      return argv;
    },
    onLog: (text) => {
      if (text.includes(BRIDGE_READY)) free();
    },
    release: free,
  };
}
