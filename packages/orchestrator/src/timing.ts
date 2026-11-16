/**
 * Per-turn timing bookkeeping (issue #58, docs/metrics.md). A turn starts when the inbox hands an input to the session
 * service. The sandbox phases that follow happen lazily, at the turn's first tool call, so they are keyed by
 * conversation: only one turn per conversation is tracked at a time. Pure apart from the injected clock and sink.
 */

/** In the order a cold start passes through them. */
export const PHASES = [
  "input-submitted",
  "claim-requested",
  "claim-ready",
  "bridge-started",
  "bridge-ready",
  "first-exec",
] as const;
export type Phase = (typeof PHASES)[number];

/** `cold`: the claim was created for this turn. `resumed`: a suspended sandbox was resumed. `warm`: it already ran. */
export type SandboxState = "cold" | "resumed" | "warm";

/** Named intervals of the summary, each from one phase to a later one. Omitted when either end was not reached. */
export const SPANS = {
  "agent-to-tool": ["input-submitted", "claim-requested"],
  claim: ["claim-requested", "claim-ready"],
  bridge: ["bridge-started", "bridge-ready"],
  "sandbox-to-exec": ["claim-requested", "first-exec"],
} as const satisfies Record<string, readonly [Phase, Phase]>;

/** What ties a log line to a turn. `turn` is the inbox event id, which is also the Pi Durable request id. */
export interface TurnContext {
  session: string;
  conversation: number;
  turn: string;
}

export interface TimingSink {
  (event: string, fields: Record<string, unknown>): void;
}

interface Turn extends TurnContext {
  startedAt: number;
  state: SandboxState;
  /** Phase -> ms since the turn started. First occurrence only. */
  phases: Partial<Record<Phase, number>>;
}

export class TurnTimings {
  readonly #now: () => number;
  readonly #emit: TimingSink;
  readonly #turns = new Map<number, Turn>();

  constructor(emit: TimingSink, now: () => number = Date.now) {
    this.#emit = emit;
    this.#now = now;
  }

  /**
   * Starts the clock of a turn. A turn of the same conversation that never ran a tool is dropped without a summary,
   * and a message queued behind a running turn restarts the clock: the summary then belongs to the later input.
   */
  begin(context: TurnContext): void {
    this.#turns.set(context.conversation, {
      ...context,
      startedAt: this.#now(),
      state: "warm",
      phases: {},
    });
  }

  /** `session`, `conversation` and `turn` of the conversation's current turn, to spread into a log line. */
  fields(conversation: number): Partial<TurnContext> {
    const turn = this.#turns.get(conversation);
    if (turn === undefined) return {};
    return { session: turn.session, conversation: turn.conversation, turn: turn.turn };
  }

  setState(conversation: number, state: SandboxState): void {
    const turn = this.#turns.get(conversation);
    if (turn !== undefined) turn.state = state;
  }

  /**
   * Records the first time the turn reaches a phase and logs it. Reaching `first-exec` ends the cold-start part of the
   * turn: the summary is logged and the turn is forgotten, so a later exec of the same turn adds nothing.
   * A phase with no turn (a bridge restarting between turns) is ignored.
   */
  mark(conversation: number, phase: Phase): void {
    const turn = this.#turns.get(conversation);
    if (turn === undefined || turn.phases[phase] !== undefined) return;
    const ms = this.#now() - turn.startedAt;
    turn.phases[phase] = ms;
    this.#emit("turn-phase", { ...contextOf(turn), phase, ms });
    if (phase === "first-exec") {
      this.#turns.delete(conversation);
      this.#emit("turn-timing", {
        ...contextOf(turn),
        sandbox: turn.state,
        phases: turn.phases,
        spans: spansOf(turn.phases),
      });
    }
  }
}

function contextOf(turn: Turn): TurnContext {
  return { session: turn.session, conversation: turn.conversation, turn: turn.turn };
}

/** The named intervals whose two ends were both reached, in ms. */
export function spansOf(phases: Partial<Record<Phase, number>>): Record<string, number> {
  const spans: Record<string, number> = {};
  for (const [name, [from, to]] of Object.entries(SPANS)) {
    const start = phases[from];
    const end = phases[to];
    if (start !== undefined && end !== undefined && end >= start) spans[name] = end - start;
  }
  return spans;
}
