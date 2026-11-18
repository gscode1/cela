/** What a probe connection did. `error` covers every failure that is not a refusal or a timeout. */
export type Outcome = "connected" | "refused" | "timeout" | "error";

/** A destination a sandbox must not reach, with whether the orchestrator (an allowed source) could. */
export interface DeniedTarget {
  name: string;
  address: string;
  /** The positive control: the orchestrator connected to it, so a failure from the probe Pod is policy, not downtime. */
  upFromOrchestrator: boolean;
}

/** What the probe Pod printed. */
export interface PodReport {
  /** A DNS lookup (allowed) worked; null when none was tried (a proxied sandbox has no DNS, ADR 0038). */
  dns: boolean | null;
  /** A TCP connection to the allowed control (the egress proxy; without it the OneCLI gateway, else a public address) worked. */
  control: Outcome;
  targets: Record<string, Outcome>;
}

export type TargetVerdict = "blocked" | "reachable" | "unverified";
export type ProbeState = "enforced" | "not-enforced" | "inconclusive";

export interface ProbeResult {
  state: ProbeState;
  reason: string;
  controls: { dns: boolean | null; allowedTcp: boolean } | null;
  targets: TargetRow[];
}

export interface TargetRow {
  name: string;
  address: string;
  verdict: TargetVerdict;
  outcome: Outcome | "none";
}

/**
 * The verdict rules (docs/network-policy.md):
 * - `not-enforced`: any denied target accepted a connection from the probe Pod. That proves it is up and reachable, so
 *   no control is needed to believe it.
 * - `inconclusive`: the Pod produced no report, or an allowed control failed (a Pod that cannot reach DNS or an
 *   allowed address blocks everything), or no denied target was shown to be up from the orchestrator. A refusal or a
 *   timeout from a target nobody can reach proves nothing.
 * - `enforced`: all of that holds and at least one target that the orchestrator reached was blocked for the Pod, and
 *   none got through. Targets the orchestrator could not reach are listed as `unverified` and do not count.
 */
export function decide(
  targets: readonly DeniedTarget[],
  report: PodReport | undefined,
  failure = "the probe Pod produced no report",
): ProbeResult {
  const rows = targets.map((target): TargetRow => {
    const outcome = report?.targets[target.name];
    const verdict: TargetVerdict =
      outcome === "connected"
        ? "reachable"
        : outcome !== undefined && target.upFromOrchestrator
          ? "blocked"
          : "unverified";
    return { name: target.name, address: target.address, verdict, outcome: outcome ?? "none" };
  });
  const controls =
    report === undefined ? null : { dns: report.dns, allowedTcp: report.control === "connected" };
  const reachable = rows.filter((row) => row.verdict === "reachable").map((row) => row.name);
  if (reachable.length > 0) {
    return {
      state: "not-enforced",
      reason: `a sandbox reached: ${reachable.join(", ")}`,
      controls,
      targets: rows,
    };
  }
  const inconclusive = (reason: string): ProbeResult => ({
    state: "inconclusive",
    reason,
    controls,
    targets: rows,
  });
  if (controls === null) return inconclusive(failure);
  if (controls.dns === false || !controls.allowedTcp) {
    return inconclusive(
      `the allowed control failed (${[controls.dns === false && "dns", !controls.allowedTcp && "tcp"].filter(Boolean).join(", ")}): blocked is not distinguishable from broken`,
    );
  }
  if (!rows.some((row) => row.verdict === "blocked")) {
    return inconclusive(
      "no denied target was reachable from the orchestrator, so none can be judged",
    );
  }
  return {
    state: "enforced",
    reason: "every verified denied target was blocked",
    controls,
    targets: rows,
  };
}
