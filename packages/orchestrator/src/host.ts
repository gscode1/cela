import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import type {
  Conversation,
  ConversationId,
  ConversationWatch,
  ConversationWindow,
  Cursor,
  Storage,
} from "@earendil-works/pi-durable";
import type { ModelChoice } from "@pi-durable-k8s/session-core";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { OrchestratorConfig } from "./config.js";
import { errorMessage, log } from "./log.js";
import type { Script } from "./model.js";
import { buildModels } from "./providers.js";
import { claimNameFor, Sandboxes, WORKSPACE } from "./sandboxes.js";
import type { SandboxHooks, SessionKeyOf } from "./sandboxes.js";
import type { SubmissionState } from "./watcher.js";
import type { WorkspaceEnv } from "./workspace.js";

export interface SessionEvent {
  role: Message["role"];
  /** Assistant text, tool output, or the user's script. */
  text: string;
  /** Tool calls the assistant made, as `name(args)`. */
  calls?: string[];
  /** Tool results only. */
  isError?: boolean;
}

export interface SessionStatus {
  id: number;
  claim: string;
  state: "running" | "done";
  events: number;
  /** Text of every tool result so far, in order. */
  results: { text: string; isError: boolean }[];
  answer?: string;
}

function contentText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      return block.type === "toolCall" ? "" : `[${block.type}]`;
    })
    .join("");
}

export function toEvent(message: Message): SessionEvent {
  const event: SessionEvent = { role: message.role, text: contentText(message.content) };
  if (message.role === "assistant") {
    const calls = message.content.flatMap((block) =>
      block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : [],
    );
    if (calls.length > 0) event.calls = calls;
  }
  if (message.role === "toolResult") event.isError = message.isError;
  return event;
}

/** The Pi Durable host: one Harness over the Postgres storage, one conversation per session. */
export class Host {
  readonly #harness: Harness;
  readonly #sandboxes: Sandboxes;
  readonly #storage: Storage;

  private constructor(harness: Harness, sandboxes: Sandboxes, storage: Storage) {
    this.#harness = harness;
    this.#sandboxes = sandboxes;
    this.#storage = storage;
  }

  /**
   * Opens the Harness over an owned storage and resumes whatever the last process left running.
   * `onFailed` fires when the Harness ends on a storage error, e.g. the database connection died.
   */
  static async open(
    storage: Storage,
    config: OrchestratorConfig,
    onFailed: (error: unknown) => void,
    sessionKeyOf: SessionKeyOf,
    hooks: SandboxHooks = {},
    recycleAtStart: readonly number[] = [],
  ): Promise<Host> {
    const models = await buildModels(config);
    const registry = createRegistry();
    registry.install(createCodingTools());
    const sandboxes = new Sandboxes(config, sessionKeyOf, hooks);
    // Before resume(): a continuing run must not run its next command in a Pod that still holds the leftovers of
    // the command the previous process was killed in.
    sandboxes.recycleAtStart(recycleAtStart);

    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        // Lazy: the SandboxClaim is created at the first tool call, not at the first model request.
        env: ({ conversationId }) => Promise.resolve(sandboxes.lazyEnv(Number(conversationId))),
        onReport: (report) => {
          log("report", { kind: report.kind, message: errorMessage(report.error) });
        },
      },
      context,
    );
    void harness.closed.then((end) => {
      if (end.kind === "failed") onFailed(end.error);
    });
    // No new input needed: open recovers nothing by itself, resume() continues unfinished runs.
    harness.resume();
    return new Host(harness, sandboxes, storage);
  }

  /** Creates the conversation and its sandbox claim, then submits the script as the first input. */
  async startSession(script: Script): Promise<{ id: number; claim: string }> {
    const conversation = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: WORKSPACE },
      },
      context,
    );
    const id = Number(conversation.id);
    await this.#sandboxes.ensure(id);
    await conversation.submit(
      { type: "input", content: JSON.stringify(script), requestId: `start-${String(id)}` },
      context,
    );
    log("session-started", { id, claim: claimNameFor(id) });
    return { id, claim: claimNameFor(id) };
  }

  /** A further input to an existing session; the model follows the newest script. False if unknown. */
  async sendInput(id: number, script: Script): Promise<boolean> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) return false;
    await conversation.submit({ type: "input", content: JSON.stringify(script) }, context);
    return true;
  }

  async events(id: number): Promise<SessionEvent[] | undefined> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) return undefined;
    const view = await conversation.context(context);
    // Stored entries, not view.messages: the view adds a placeholder result for a call still running.
    return view.entries.flatMap((entry) => entry.model ?? []).map(toEvent);
  }

  async status(id: number): Promise<SessionStatus | undefined> {
    const events = await this.events(id);
    if (events === undefined) return undefined;
    const last = events.at(-1);
    const results = events
      .filter((e) => e.role === "toolResult")
      .map((e) => ({ text: e.text, isError: e.isError === true }));
    const answered = last?.role === "assistant" && last.calls === undefined;
    return {
      id,
      claim: claimNameFor(id),
      state: answered ? "done" : "running",
      events: events.length,
      results,
      ...(answered ? { answer: last.text } : {}),
    };
  }

  /**
   * Creates an empty conversation for a session, running on `model`. No sandbox: that is created lazily, at the
   * first tool call, by the `env` callback of the Harness.
   *
   * Pi Durable stores the model in the conversation's `pi.agent` document, in the creating commit. It survives
   * restarts, so it is set once here and not on every turn; only the provider must be installed again at each start.
   */
  async createConversation(model: ModelChoice): Promise<number> {
    const conversation = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: model.provider, modelId: model.model },
          ...(model.reasoning === undefined ? {} : { thinkingLevel: model.reasoning }),
          cwd: WORKSPACE,
        },
      },
      context,
    );
    return Number(conversation.id);
  }

  /** The model a conversation runs on, as Pi Durable stored it. */
  async modelOf(id: number): Promise<ModelChoice | undefined> {
    const agent = await (await this.#conversation(id)).agent(context);
    return agent.model === undefined
      ? undefined
      : { provider: agent.model.provider, model: agent.model.modelId };
  }

  /** The reasoning effort a conversation runs with, as Pi Durable resolved it (`off` when none was stored). */
  async thinkingOf(id: number): Promise<string> {
    return (await (await this.#conversation(id)).agent(context)).thinkingLevel;
  }

  /** Model turns (assistant responses) in the conversation's transcript so far. */
  async turnsUsed(id: number): Promise<number> {
    const conversation = await this.#conversation(id);
    let turns = 0;
    let cursor: Cursor | undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, context);
      turns += page.items.filter((entry) => entry.kind === "pi.assistant").length;
      cursor = page.next;
    } while (cursor !== undefined);
    return turns;
  }

  /** Caps the tool rounds of any run of this conversation, so one run cannot overshoot the session's turn budget. */
  async limitTurns(id: number, maxTurns: number): Promise<void> {
    await (await this.#conversation(id)).configure({ maxTurns }, context);
  }

  /** The stored state of a submission, for the run watcher. */
  async submissionState(id: number, requestId: string): Promise<SubmissionState | undefined> {
    return this.#storage.submissionByRequest(id as ConversationId, requestId, context);
  }

  /**
   * Durably admits one inbox event. `requestId` is the inbox row id, so a resubmission after a crash returns the
   * original submission instead of adding a second turn. A message queues behind a running turn (follow-up); a
   * steer joins the running turn after its current tool round, and starts a turn when the session is idle.
   */
  async submitInput(
    id: number,
    input: { text: string; requestId: string; steer: boolean },
  ): Promise<void> {
    const conversation = await this.#conversation(id);
    await conversation.submit(
      {
        type: "input",
        content: input.text,
        requestId: input.requestId,
        whenBusy: input.steer ? "steer" : "followUp",
      },
      context,
    );
  }

  async hasSubmission(id: number, requestId: string): Promise<boolean> {
    // A read on the Storage: the Harness has no lookup by request id. Only the test-fault gate uses it.
    const record = await this.#storage.submissionByRequest(
      id as ConversationId,
      requestId,
      context,
    );
    return record !== undefined;
  }

  /** Withdraws queued inputs, aborts the running turn and resolves once the conversation is idle. */
  async abort(id: number): Promise<void> {
    await (await this.#conversation(id)).abort(context);
  }

  /** The conversation and a watch of its structural view (a window over the transcript plus live state). */
  async watch(
    id: number,
    window?: ConversationWindow,
  ): Promise<{ conversation: Conversation; watch: ConversationWatch } | undefined> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) return undefined;
    return { conversation, watch: await conversation.watch(context, window) };
  }

  /**
   * The session's sandbox env, opening it (claim, bridge) if needed. Only repo sessions call this directly, to clone
   * before the first turn; every other session opens its sandbox lazily at the first tool call.
   */
  async workspaceEnv(id: number): Promise<WorkspaceEnv> {
    return (await this.#sandboxes.ensure(id)).env;
  }

  /** Stops the session's bridge and deletes its SandboxClaim and PVC. */
  async destroySandbox(id: number): Promise<void> {
    await this.#sandboxes.destroy(id);
  }

  /** The orphan sweep's delete of a claim and its PVC: the session deletion's teardown, for a claim with no live session. */
  async destroyOrphanSandbox(claimName: string, sessionLabel: string): Promise<void> {
    await this.#sandboxes.destroyOrphan(claimName, sessionLabel);
  }

  async #conversation(id: number): Promise<Conversation> {
    const conversation = await this.#harness.conversation(id as ConversationId, context);
    if (conversation === undefined) throw new Error(`conversation ${String(id)} does not exist`);
    return conversation;
  }

  /** Waits for in-flight work to settle and closes storage; bridges stop, claims stay. */
  async close(): Promise<void> {
    await this.#harness.close(context);
    await this.#sandboxes.closeAll();
  }
}
