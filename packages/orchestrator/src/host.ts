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
import type { McpServerConfig, ModelChoice, ProfileDefinition } from "@pi-durable-k8s/session-core";
import { defineExtension } from "@earendil-works/pi-durable";
import type { AgentChange, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { createToolSearchExtension } from "@earendil-works/pi-durable/tool-search";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { OrchestratorConfig } from "./config.js";
import { errorMessage, log } from "./log.js";
import { joinInstructions } from "./repo-context.js";
import type { Script } from "./model.js";
import { httpTransportFactory, McpTools } from "./mcp.js";
import type { McpTimings, McpTransportFactory } from "./mcp.js";
import { buildGatewayFetch, buildModels } from "./providers.js";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { claimNameFor, Sandboxes, WORKSPACE } from "./sandboxes.js";
import type { SandboxHooks, SessionKeyOf } from "./sandboxes.js";
import type { TurnTimings } from "./timing.js";
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

/** Where the host reads the MCP catalog from: the `McpCatalogCache` (enabled and disabled servers). */
export interface McpCatalogSource {
  get(): readonly McpServerConfig[];
  subscribe(listener: (servers: readonly McpServerConfig[]) => void): () => void;
}

export interface HostOptions {
  /** The MCP catalog; without one no MCP server is installed and nothing about the offered tools changes. */
  catalog?: McpCatalogSource;
  /** Test seams of the remote MCP client; production passes nothing. */
  mcpTransport?: McpTransportFactory;
  mcpTimings?: McpTimings;
  /** Test seam: the coding extension to install (a later release with one more tool). Production passes nothing. */
  codingExtension?: Extension;
  /**
   * Profile definitions of the live conversations by id, read once before runs resume: the tool filters are recomputed
   * against the tools installed now (see `toolFilters`).
   */
  conversationProfiles?: () => Promise<ReadonlyMap<number, ProfileDefinition>>;
}

/**
 * The `tools` and `modelTools` of a profile as Pi stores them: `{ remove }` lists, so `tool_search` and the MCP tools
 * found later stay enabled (an array would enable exactly the names it holds). A remove list names the installed coding
 * tools the profile does not allow, so it is only right for the tools installed when it was computed: it is computed
 * again against the tools installed now before every input and when the host opens (`Host.applyProfileTools`), which
 * keeps the effective set equal to the snapshot's allowlist whatever a later release installs.
 */
function toolFilters(
  coding: readonly ToolRegistration[],
  definition: ProfileDefinition,
): Pick<AgentChange, "tools" | "modelTools"> {
  const without = (keep: readonly string[]) => ({
    remove: coding.filter((tool) => !keep.includes(tool.name)),
  });
  return {
    ...(definition.tools === undefined ? {} : { tools: without(definition.tools) }),
    ...(definition.modelTools === undefined ? {} : { modelTools: without(definition.modelTools) }),
  };
}

/**
 * The gateway `fetch`, built at the first MCP request: the catalog can gain a server while the orchestrator runs, and
 * a deployment without a token (no remote model provider) must still start. Without a token an MCP call fails, so the
 * server's tools stay `tool_unavailable` and the discovery log says why.
 */
function lazyGatewayFetch(config: OrchestratorConfig): McpFetch {
  let gateway: Promise<McpFetch> | undefined;
  return async (input, init) => {
    const token = config.onecli.token;
    if (token === undefined) {
      throw new Error(
        "ONECLI_AGENT_TOKEN is required for MCP servers: calls go through the gateway",
      );
    }
    gateway ??= buildGatewayFetch(config, token);
    return (await gateway)(input, init);
  };
}

/** The Pi Durable host: one Harness over the Postgres storage, one conversation per session. */
export class Host {
  readonly #harness: Harness;
  readonly #sandboxes: Sandboxes;
  readonly #storage: Storage;
  readonly #mcp: McpTools;
  readonly #toolSearch: Extension;
  readonly #coding: Extension;
  readonly #unsubscribe: () => void;

  private constructor(
    harness: Harness,
    sandboxes: Sandboxes,
    storage: Storage,
    mcp: McpTools,
    toolSearch: Extension,
    coding: Extension,
    unsubscribe: () => void,
  ) {
    this.#harness = harness;
    this.#sandboxes = sandboxes;
    this.#storage = storage;
    this.#mcp = mcp;
    this.#toolSearch = toolSearch;
    this.#coding = coding;
    this.#unsubscribe = unsubscribe;
  }

  /** What the orchestrator has installed, for ingest to check profile writes against (`publishCapabilities`). */
  capabilities(): { tools: string[]; extensions: string[] } {
    return {
      tools: (this.#coding.tools ?? []).map((tool) => tool.name),
      extensions: [this.#coding.name, this.#toolSearch.name],
    };
  }

  /**
   * The tools, instructions and extensions of a new conversation, from its session's profile snapshot (docs/decisions/
   * 0010-session-profiles.md). Pi stores names: `tools` and `modelTools` are given as `{ remove }` so the tools that
   * are not coding tools (`tool_search`, the MCP tools found later) stay enabled and offered, where an array would
   * enable exactly those named. The host default (pinned to `coding`) is edited, never replaced, so extensions the
   * profile does not name never reach the session. A profile with MCP servers adds `tool_search` and one `mcp-<name>`
   * extension per server, taken from the catalog's installed ones; a server that is missing or disabled now is stored by
   * name anyway (an empty stand-in), so its tools are `tool_unavailable` and appear if it is enabled later.
   */
  #agentFor(definition: ProfileDefinition, catalog?: string): AgentChange {
    const coding: readonly ToolRegistration[] = this.#coding.tools ?? [];
    for (const name of [...(definition.tools ?? []), ...(definition.modelTools ?? [])]) {
      if (!coding.some((tool) => tool.name === name)) {
        log("profile-tool-unresolved", { tool: name });
      }
    }
    const servers = definition.mcpServers ?? [];
    // The skill catalog follows the profile's own instructions; it is stored with the conversation like them.
    const instructions = joinInstructions([definition.instructions, catalog]);
    return {
      ...toolFilters(coding, definition),
      ...(instructions === undefined ? {} : { instructions }),
      ...(servers.length === 0
        ? {}
        : {
            extensions: {
              add: [
                this.#toolSearch,
                ...servers.map(
                  (name) =>
                    this.#mcp.extensionOf(name) ??
                    defineExtension({ name: `mcp-${name}`, tools: [] }),
                ),
              ],
            },
          }),
    };
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
    options: HostOptions = {},
  ): Promise<Host> {
    const models = await buildModels(config);
    const registry = createRegistry();
    const coding = options.codingExtension ?? createCodingTools();
    registry.install(coding);
    // Remote MCP (docs/decisions/0007-native-remote-mcp.md, 0009-mcp-catalog-in-postgres.md). Pi Durable selects EVERY
    // installed extension for a conversation whose `pi.agent` stores none (selectExtensions in pi-durable
    // harness/agent.js), so installing MCP extensions would hand MCP to every existing conversation at the next start.
    // The host default is therefore always pinned to `coding`, whatever the catalog holds, and only conversations
    // created from a profile with MCP servers add `tool_search` and those servers' extensions (`Host.#agentFor`).
    const mcpTransport = options.mcpTransport ?? httpTransportFactory(lazyGatewayFetch(config));
    const mcp = new McpTools(registry, mcpTransport, options.mcpTimings);
    const toolSearch = createToolSearchExtension();
    registry.install(toolSearch);
    let unsubscribe = () => {};
    if (options.catalog !== undefined) {
      mcp.apply(options.catalog.get());
      unsubscribe = options.catalog.subscribe((servers) => mcp.apply(servers));
    }
    const sandboxes = new Sandboxes(config, sessionKeyOf, hooks);
    // Before resume(): a continuing run must not run its next command in a Pod that still holds the leftovers of
    // the command the previous process was killed in.
    sandboxes.recycleAtStart(recycleAtStart);

    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: { extensions: [coding] },
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
    // Before resume(): a run that continues must not see a coding tool its profile does not allow, installed since
    // the conversation was created.
    for (const [id, definition] of (await options.conversationProfiles?.()) ?? []) {
      const filters = toolFilters(coding.tools ?? [], definition);
      if (filters.tools === undefined && filters.modelTools === undefined) continue;
      try {
        await (
          await harness.conversation(id as ConversationId, context)
        )?.configure(filters, context);
      } catch (error) {
        log("profile-tools-reapply-failed", { conversation: id, message: errorMessage(error) });
      }
    }
    // No new input needed: open recovers nothing by itself, resume() continues unfinished runs.
    harness.resume();
    // After resume: discovery runs in the background and never delays readiness; a server that is down only leaves
    // its tools unavailable until a retry succeeds.
    mcp.start();
    return new Host(harness, sandboxes, storage, mcp, toolSearch, coding, unsubscribe);
  }

  /** Creates the conversation and its sandbox claim, then submits the script as the first input. */
  async startSession(script: Script): Promise<{ id: number; claim: string }> {
    const conversation = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: "faux", modelId: "faux-1" },
          cwd: WORKSPACE,
        },
      },
      context,
    );
    const id = Number(conversation.id);
    try {
      await this.#sandboxes.ensure(id);
      await conversation.submit(
        { type: "input", content: JSON.stringify(script), requestId: `start-${String(id)}` },
        context,
      );
    } catch (error) {
      // The caller never learns `id` from a failure, and the sweep leaves `control-<n>` claims alone, so nobody else
      // would delete a claim that was already created.
      await this.#sandboxes.destroy(id).catch((cleanup: unknown) => {
        log("control-cleanup-failed", { id, message: errorMessage(cleanup) });
      });
      throw error;
    }
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
   * `definition` is the session's validated profile snapshot (`{}`: every coding tool, no instructions, no MCP).
   * `skillCatalog` is the text listing the snapshot's skills (`SkillLibrary.catalogFor`), added to the instructions.
   */
  async createConversation(
    model: ModelChoice,
    definition: ProfileDefinition = {},
    skillCatalog?: string,
  ): Promise<number> {
    const conversation = await this.#harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          model: { provider: model.provider, modelId: model.model },
          ...(model.reasoning === undefined ? {} : { thinkingLevel: model.reasoning }),
          cwd: WORKSPACE,
          ...this.#agentFor(definition, skillCatalog),
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

  /** Names of the tools the model is offered now, and of the deferred ones it can load with `tool_search`. */
  async toolsOf(id: number): Promise<{ offered: string[]; deferred: string[] }> {
    const agent = await (await this.#conversation(id)).agent(context);
    return {
      offered: agent.tools.map((tool) => tool.name),
      deferred: agent.deferred.map((tool) => tool.name),
    };
  }

  /** The profile's instructions as Pi resolved them for the conversation; undefined when it has none. */
  async instructionsOf(id: number): Promise<string | undefined> {
    return (await (await this.#conversation(id)).agent(context)).instructions;
  }

  /**
   * Replaces the conversation's instructions with `text` (undefined: none) when they differ from what is stored, and
   * says whether it wrote. Equal text writes nothing, so a rescan that finds the same repo content adds no entry.
   */
  async setInstructions(id: number, text: string | undefined): Promise<boolean> {
    const conversation = await this.#conversation(id);
    const current = (await conversation.agent(context)).instructions ?? undefined;
    if (current === text) return false;
    await conversation.configure({ instructions: text ?? null }, context);
    return true;
  }

  /** True while the session's sandbox env is open; never opens or resumes it (see `Sandboxes.isOpen`). */
  sandboxOpen(id: number): boolean {
    return this.#sandboxes.isOpen(id);
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

  /** Recomputes the profile's tool filters against the tools installed now (see `toolFilters`); a no-op without any. */
  async applyProfileTools(id: number, definition: ProfileDefinition): Promise<void> {
    const filters = toolFilters(this.#coding.tools ?? [], definition);
    if (filters.tools === undefined && filters.modelTools === undefined) return;
    await (await this.#conversation(id)).configure(filters, context);
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
   * It is the same tracked env the tools get: the raw env would hide a running clone from idle eviction and suspension
   * (a Pod deleted mid-clone) and would never be evicted itself.
   */
  /** Turn timing bookkeeping (docs/metrics.md); the session service starts each turn on it. */
  get timings(): TurnTimings {
    return this.#sandboxes.timings;
  }

  workspaceEnv(id: number): Promise<WorkspaceEnv> {
    return Promise.resolve(this.#sandboxes.lazyEnv(id));
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
    this.#unsubscribe();
    await this.#mcp.close();
    await this.#harness.close(context);
    await this.#sandboxes.closeAll();
  }
}
