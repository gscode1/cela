/**
 * Decision logic of the sandbox lifecycle that is not about talking to Kubernetes: what counts as an interrupted
 * command (docs/decisions/0003-recycle-pod-on-interrupt.md) and which sandboxes are due for suspension
 * (docs/decisions/0004-idle-suspend.md). Pure, so it is unit tested without a cluster.
 */

/**
 * True when an `ExecutionEnv.exec` outcome says the command did not end on its own: Pi Durable aborted it (steer
 * or cancel) or its timeout hit. The daemon kills the command's process group, but a child that called `setsid`
 * is in no such group and keeps running, so the sandbox Pod must be replaced. A thrown error counts too: the
 * connection to the sandbox broke while the command ran, and what it started may still be there.
 */
export function interruptedExec(
  outcome: { threw: true } | { threw: false; result: unknown },
): boolean {
  if (outcome.threw) return true;
  const result = outcome.result as { ok?: unknown; error?: { code?: unknown } } | undefined;
  if (result?.ok !== false) return false;
  return result.error?.code === "aborted" || result.error?.code === "timeout";
}

const SANDBOX_NAME = /^pi-conv-(\d+)$/;

/** The conversation id of a `pi-conv-<n>` sandbox or claim name; undefined for any other name (e.g. `e2e-phase1`). */
export function conversationOfName(name: string): number | undefined {
  const match = SANDBOX_NAME.exec(name);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export interface SuspendInput {
  /** Names of the Sandboxes whose mode is `Running`. */
  running: readonly string[];
  /** When each conversation's sandbox was last used by this process (a call started or ended). */
  lastUsed: ReadonlyMap<number, number>;
  /** Conversations with a call in flight or a recycle or suspend under way: never suspended. */
  busy: ReadonlySet<number>;
  now: number;
  /** Idle time after which a sandbox is suspended. 0 or less turns suspension off. */
  afterMs: number;
}

export interface SuspendPlan {
  /** Running sandboxes this process has no record of (it restarted, or never used them): their idle clock starts now. */
  seen: number[];
  /** Sandboxes idle for at least `afterMs`. */
  suspend: number[];
}

/**
 * Which sandboxes to suspend. Time is measured from the last use this process saw, and a sandbox it has never seen
 * starts its clock at first sight, so an orchestrator restart postpones suspension instead of suspending sessions that
 * are in use. Only `pi-conv-<n>` names are considered.
 */
export function planSuspend(input: SuspendInput): SuspendPlan {
  const plan: SuspendPlan = { seen: [], suspend: [] };
  if (input.afterMs <= 0) return plan;
  for (const name of input.running) {
    const conversation = conversationOfName(name);
    if (conversation === undefined || input.busy.has(conversation)) continue;
    const last = input.lastUsed.get(conversation);
    if (last === undefined) plan.seen.push(conversation);
    else if (input.now - last >= input.afterMs) plan.suspend.push(conversation);
  }
  return plan;
}
