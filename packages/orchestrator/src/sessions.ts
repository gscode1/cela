import { writeSync } from "node:fs";
import type pg from "pg";
import {
  completeTombstone,
  errorMessage,
  failSession,
  getSession,
  writeTombstone,
} from "@pi-durable-k8s/session-core";
import type { InboxEvent, ModelChoice, SessionRow } from "@pi-durable-k8s/session-core";
import { terminalFailure } from "./failure.js";
import type { RunOutcome } from "./failure.js";
import { GithubDeniedError } from "./github-app.js";
import type { Host } from "./host.js";
import { log } from "./log.js";
import { RepoUnavailableError } from "./repo-access.js";
import type { RepoAccess } from "./repo-access.js";
import { WorkspaceLostError } from "./workspace.js";
import { RunWatcher } from "./watcher.js";
import type { Watched } from "./watcher.js";

/** An event that can never succeed (deleted session, malformed payload): the row is marked failed, not retried. */
export class PermanentError extends Error {}

/** Open SSE streams by session, so deleting a session can end them. */
export class StreamRegistry {
  readonly #streams = new Map<string, Set<(reason: string) => void>>();

  add(sessionId: string, close: (reason: string) => void): () => void {
    let set = this.#streams.get(sessionId);
    if (set === undefined) {
      set = new Set();
      this.#streams.set(sessionId, set);
    }
    set.add(close);
    return () => {
      set.delete(close);
      if (set.size === 0) this.#streams.delete(sessionId);
    };
  }

  closeSession(sessionId: string, reason: string): void {
    for (const close of [...(this.#streams.get(sessionId) ?? [])]) close(reason);
  }
}

export interface SessionServiceOptions {
  /**
   * Honour `payload.testFault` on inbox rows. Test-only (PI_ORCH_TEST_FAULTS=1): lets the e2e suite kill the
   * orchestrator between "submitted to Pi Durable" and "row marked submitted".
   */
  testFaults: boolean;
  /** Model of a session that predates the per-session model (null in `inbox.sessions`). */
  defaultModel: ModelChoice;
  /** Model turns one session may use in total. A session that reaches it is `failed`. */
  turnBudget: number;
  /** Repo workspaces (Phase 4c). Without it a session that asked for a repo is refused at its first input. */
  repos?: RepoAccess;
}

/**
 * Maps API sessions onto Pi Durable and applies inbox events. One session = one conversation = one
 * SandboxClaim `pi-conv-<conversation id>` = one PVC; the claim is created lazily by the Harness at the first
 * tool call, never here.
 */
export class SessionService {
  readonly #pool: pg.Pool;
  readonly #host: Host;
  readonly #options: SessionServiceOptions;
  readonly streams = new StreamRegistry();
  readonly #creating = new Map<string, Promise<number>>();
  readonly #watcher: RunWatcher;

  constructor(pool: pg.Pool, host: Host, options: SessionServiceOptions) {
    this.#pool = pool;
    this.#host = host;
    this.#options = options;
    this.#watcher = new RunWatcher({
      lookup: (conversationId, requestId) => host.submissionState(conversationId, requestId),
      onUnanswered: (watched, outcome) => this.#runEnded(watched, outcome),
      onError: (error) => {
        log("run-watch-failed", { message: errorMessage(error) });
      },
    });
  }

  stop(): void {
    this.#watcher.stop();
  }

  /**
   * After a start: watch the inputs of live sessions that were handed over recently, because the process that
   * handed them over may have died before it saw the run fail. Settled ones drop out at the first poll.
   */
  async recoverWatches(): Promise<void> {
    const { rows } = await this.#pool.query<{
      id: string;
      session_id: string;
      conversation_id: string;
    }>(
      `select e.id, e.session_id, s.conversation_id
         from inbox.events e join inbox.sessions s on s.id = e.session_id
        where e.kind in ('message', 'steer') and e.status = 'submitted'
          and s.status = 'active' and s.conversation_id is not null
          and e.submitted_at > clock_timestamp() - interval '24 hours'
        order by e.submitted_at desc limit 1000`,
    );
    for (const row of rows) {
      this.#watcher.add({
        sessionId: row.session_id,
        conversationId: Number(row.conversation_id),
        requestId: row.id,
      });
    }
    if (rows.length > 0) log("run-watches-recovered", { count: rows.length });
  }

  /**
   * A submission ended without an answer. Rejected model credentials and a used-up turn budget end the session
   * for good (`failed`); anything else leaves it active. The stored message is ours, never the provider's text.
   */
  async #runEnded(watched: Watched, outcome: RunOutcome): Promise<void> {
    const failure = terminalFailure(outcome);
    if (failure === undefined) return;
    await this.#failSession(watched.sessionId, watched.conversationId, failure);
  }

  async #failSession(
    sessionId: string,
    conversationId: number | null,
    failure: string,
  ): Promise<void> {
    const changed = await failSession(this.#pool, sessionId, failure);
    if (!changed) return;
    log("session-failed", { session: sessionId, failure });
    // Withdraw whatever queued behind the failed run, so nothing more is sent to the provider.
    if (conversationId !== null) await this.#host.abort(conversationId);
  }

  /**
   * The session's conversation id, creating the conversation on first use. Serialised per session, so the
   * stream handler and the inbox loop cannot create two. A crash between creating the conversation and
   * storing its id leaves one empty, unreferenced conversation behind (documented limit).
   */
  async ensureConversation(session: SessionRow): Promise<number> {
    if (session.conversationId !== null) return session.conversationId;
    let creating = this.#creating.get(session.id);
    if (creating === undefined) {
      creating = this.#create(session.id).finally(() => this.#creating.delete(session.id));
      this.#creating.set(session.id, creating);
    }
    return creating;
  }

  async #create(sessionId: string): Promise<number> {
    const current = await getSession(this.#pool, sessionId);
    if (current?.conversationId != null) return current.conversationId;
    const conversationId = await this.#host.createConversation(
      current?.model ?? this.#options.defaultModel,
    );
    await this.#pool.query(
      "update inbox.sessions set conversation_id = $1 where id = $2 and conversation_id is null",
      [conversationId, sessionId],
    );
    log("conversation-created", { session: sessionId, conversation: conversationId });
    return conversationId;
  }

  /** Applies one inbox event. Resolves when it is durably handed over; throws PermanentError if it never can be. */
  async apply(event: InboxEvent, session: SessionRow): Promise<void> {
    if (session.status === "deleted") throw new PermanentError("session is deleted");
    switch (event.kind) {
      case "message":
      case "steer": {
        const text = event.payload.text;
        if (typeof text !== "string" || text === "") throw new PermanentError("event has no text");
        if (session.status === "failed") throw new PermanentError("session has failed");
        const conversationId = await this.ensureConversation(session);
        await this.#withinBudget(session, conversationId);
        // Before the first turn: OneCLI agent, token and clone. A session without a repo skips all of it.
        if (session.repo !== null) await this.#prepareRepo(session, conversationId);
        const requestId = event.id;
        const faultArmed =
          this.#options.testFaults && event.payload.testFault === "exit-after-submit";
        const alreadyAdmitted =
          faultArmed && (await this.#host.hasSubmission(conversationId, requestId));
        await this.#host.submitInput(conversationId, {
          text,
          requestId,
          steer: event.kind === "steer",
        });
        this.#watcher.add({ sessionId: session.id, conversationId, requestId });
        if (faultArmed && !alreadyAdmitted) {
          // After the durable hand-over, before the row says so: exactly the window test 4 needs.
          // Synchronous write: stdout to a pipe is async and process.exit would drop the line.
          writeSync(
            1,
            `${JSON.stringify({ event: "test-fault", fault: "exit-after-submit", id: event.id })}\n`,
          );
          process.exit(137);
        }
        return;
      }
      case "cancel": {
        if (session.conversationId !== null) await this.#host.abort(session.conversationId);
        return;
      }
      case "delete": {
        await this.#delete(session);
        return;
      }
    }
  }

  /**
   * Provisions the repo session's GitHub access and makes sure its clone exists. What no retry can fix ends the input
   * for good (and, for a lost workspace or refused access, the session): the agent must not run a turn in a workspace
   * that is not the one the user asked for. Anything else throws as is, so the inbox retries it.
   */
  async #prepareRepo(session: SessionRow, conversationId: number): Promise<void> {
    const repos = this.#options.repos;
    if (repos === undefined) throw new PermanentError("repository workspaces are not configured");
    try {
      await repos.prepare(session, await this.#host.workspaceEnv(conversationId));
    } catch (error) {
      if (error instanceof WorkspaceLostError) {
        await this.#failSession(session.id, conversationId, error.message);
        throw new PermanentError(error.message);
      }
      if (error instanceof GithubDeniedError) {
        const failure =
          "GitHub refused access to the repository: is the GitHub App installed on it?";
        await this.#failSession(session.id, conversationId, failure);
        throw new PermanentError(failure);
      }
      if (error instanceof RepoUnavailableError) throw new PermanentError(error.message);
      throw error;
    }
  }

  /**
   * The per-session turn budget, checked before every input: a session that used all its turns fails for good, and
   * otherwise the conversation's `maxTurns` is set to what is left, so a single long run cannot overshoot it.
   * Turns are model responses, counted from the stored transcript, so a restart does not reset the count.
   */
  async #withinBudget(session: SessionRow, conversationId: number): Promise<void> {
    const used = await this.#host.turnsUsed(conversationId);
    const left = this.#options.turnBudget - used;
    if (left <= 0) {
      const failure = terminalFailure({ reason: "turn_limit" });
      await this.#failSession(session.id, conversationId, failure ?? "turn budget exhausted");
      throw new PermanentError("turn budget exhausted");
    }
    await this.#host.limitTurns(conversationId, left);
  }

  /**
   * Stop the session, delete the SandboxClaim and PVC, mark the session deleted. The conversation's stored state
   * stays: the Postgres adapter can only delete it in a maintenance window (docs/session-api.md).
   */
  async #delete(session: SessionRow): Promise<void> {
    log("session-delete-start", { session: session.id });
    // Record what the session holds before anything is revoked, then revoke its OneCLI agent first: from that moment
    // its proxy token is dead, whatever happens to the claim after. A plain session has no OneCLI objects.
    await writeTombstone(this.#pool, session);
    await this.#options.repos?.teardown(session);
    const conversationId = session.conversationId;
    if (conversationId !== null) {
      await this.#host.abort(conversationId);
      this.streams.closeSession(session.id, "deleted");
      await this.#host.destroySandbox(conversationId);
    }
    await this.#pool.query(
      "update inbox.sessions set status = 'deleted', last_activity_at = clock_timestamp() where id = $1",
      [session.id],
    );
    await completeTombstone(this.#pool, session.id);
    log("session-deleted", { session: session.id });
  }
}
