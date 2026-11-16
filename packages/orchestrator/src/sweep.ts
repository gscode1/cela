import type { SessionRef } from "@pi-durable-k8s/session-core";
import { UUID } from "@pi-durable-k8s/session-core";
import { DEFAULT_ONECLI_NAME_PREFIX, namePatterns } from "./onecli-names.js";

/**
 * The decision half of the orphan sweep (docs/decisions/0002-orphan-sweep.md): which sandbox resources have no
 * live session. Pure: the inputs are what the cluster, OneCLI and the inbox report right now, the output is the
 * list of things to remove. Nothing here calls Kubernetes, OneCLI or Postgres.
 *
 * Only three kinds of object are ever candidates, and only by exact name or label pattern:
 *  - a SandboxClaim `pi-conv-<n>` whose `pi-durable-k8s/session-id` label is a session UUID;
 *  - a PVC `workspace-pi-conv-<n>` for which no SandboxClaim of that name exists;
 *  - a OneCLI agent `<prefix><uuid>` and its secrets `<prefix><uuid>-git` / `-api`, where the prefix is this
 *    orchestrator's own (`pi-session-` by default). Names with any other prefix belong to another stack that shares
 *    the OneCLI workspace and are never judged.
 * Anything else is left alone: unlabelled claims (the e2e Phase 1 claim `e2e-phase1`), `control-<n>` labels of
 * the test-only control sessions, other namespaces' naming schemes.
 *
 * A session is an orphan's owner only if it is `deleted` or unknown. `active`, `failed` and `deleting` sessions
 * are live: a claim of an active session whose sandbox can never work again (a token from before ADR 0001) is an
 * operator decision, because removing it destroys the workspace of a session the user can still talk to.
 */

export interface SweepClaim {
  name: string;
  sessionLabel: string | undefined;
  createdAt: Date;
}

export interface SweepPvc {
  name: string;
  createdAt: Date;
}

export interface SweepAgent {
  id: string;
  identifier: string;
  /** OneCLI does not always report it; an agent without it is judged by its session alone. */
  createdAt?: Date;
}

export interface SweepSecret {
  id: string;
  name: string;
}

export interface SweepInput {
  sessions: readonly SessionRef[];
  claims: readonly SweepClaim[];
  pvcs: readonly SweepPvc[];
  /** Undefined when OneCLI is not configured: no agent is judged. */
  agents: readonly SweepAgent[] | undefined;
  secrets: readonly SweepSecret[];
  /** This orchestrator's OneCLI name prefix; see `onecli-names.ts`. Default `pi-session-`. */
  namePrefix?: string | undefined;
  now: number;
  /** An object younger than this is never touched, so a session being created cannot race the sweep. */
  graceMs: number;
  /** Upper bound of actions in one run; the rest waits for the next run. */
  maxActions: number;
}

export type SweepReason = "session-deleted" | "session-unknown";

export type SweepAction =
  /** Deletes the claim and its PVC (the session delete path, `deleteClaimAndPvc`). */
  | { kind: "delete-claim"; claim: string; sessionLabel: string; reason: SweepReason }
  /** A workspace PVC whose claim is gone and whose session is deleted or unknown. */
  | { kind: "delete-pvc"; claim: string; reason: SweepReason }
  /** Revokes a session's OneCLI agent and per-session secrets. Ids are not secret; tokens are never carried. */
  | {
      kind: "revoke-agent";
      sessionId: string;
      agentIds: string[];
      secretIds: string[];
      reason: SweepReason;
    };

const CLAIM_NAME = /^pi-conv-(\d+)$/;
const PVC_NAME = /^workspace-(pi-conv-(\d+))$/;

export function planSweep(input: SweepInput): SweepAction[] {
  const { agent: AGENT_IDENTIFIER, secret: SECRET_NAME } = namePatterns(
    input.namePrefix ?? DEFAULT_ONECLI_NAME_PREFIX,
  );
  const bySession = new Map(input.sessions.map((s) => [s.id, s]));
  const byConversation = new Map(
    input.sessions.flatMap((s) => (s.conversationId === null ? [] : [[s.conversationId, s]])),
  );
  const old = (createdAt: Date | undefined): boolean =>
    createdAt === undefined || input.now - createdAt.getTime() >= input.graceMs;
  /** The reason a session no longer owns anything, or undefined if it is live. */
  const orphanReason = (session: SessionRef | undefined): SweepReason | undefined => {
    if (session === undefined) return "session-unknown";
    return session.status === "deleted" ? "session-deleted" : undefined;
  };

  const actions: SweepAction[] = [];

  for (const claim of input.claims) {
    if (!CLAIM_NAME.test(claim.name)) continue;
    const label = claim.sessionLabel;
    if (label === undefined || !UUID.test(label)) continue;
    if (!old(claim.createdAt)) continue;
    const reason = orphanReason(bySession.get(label));
    if (reason !== undefined)
      actions.push({ kind: "delete-claim", claim: claim.name, sessionLabel: label, reason });
  }

  // Any claim of that name, labelled or not, means the PVC is (or may soon be) in use: leave it.
  const claimNames = new Set(input.claims.map((c) => c.name));
  for (const pvc of input.pvcs) {
    const match = PVC_NAME.exec(pvc.name);
    if (match === null || !old(pvc.createdAt)) continue;
    const [, claim, conversation] = match;
    if (claim === undefined || conversation === undefined || claimNames.has(claim)) continue;
    const reason = orphanReason(byConversation.get(Number(conversation)));
    if (reason !== undefined) actions.push({ kind: "delete-pvc", claim, reason });
  }

  if (input.agents !== undefined) {
    const found = new Map<string, { agentIds: string[]; secretIds: string[] }>();
    const entry = (sessionId: string) => {
      let e = found.get(sessionId);
      if (e === undefined) {
        e = { agentIds: [], secretIds: [] };
        found.set(sessionId, e);
      }
      return e;
    };
    for (const agent of input.agents) {
      const sessionId = AGENT_IDENTIFIER.exec(agent.identifier)?.[1];
      if (sessionId === undefined || !old(agent.createdAt)) continue;
      if (orphanReason(bySession.get(sessionId)) !== undefined)
        entry(sessionId).agentIds.push(agent.id);
    }
    for (const secret of input.secrets) {
      const sessionId = SECRET_NAME.exec(secret.name)?.[1];
      if (sessionId === undefined) continue;
      if (orphanReason(bySession.get(sessionId)) !== undefined)
        entry(sessionId).secretIds.push(secret.id);
    }
    for (const [sessionId, ids] of found) {
      const reason = orphanReason(bySession.get(sessionId));
      if (reason !== undefined) actions.push({ kind: "revoke-agent", sessionId, ...ids, reason });
    }
  }

  return actions.slice(0, Math.max(0, input.maxActions));
}
