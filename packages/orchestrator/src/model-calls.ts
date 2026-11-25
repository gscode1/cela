import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook, LiveDoc } from "@earendil-works/pi-durable";
import type { Extension, LiveRun, Storage, SubmissionId } from "@earendil-works/pi-durable";
import { errorMessage, log } from "./log.js";

/**
 * Per-call model usage (issue #497, docs/metrics.md): one `model-call` log line per provider response, and the usage
 * that goes with an assistant message on the session stream. Pi Durable sums usage into `pi.usage` per conversation;
 * the prompt-cache behaviour of single requests (how much of the prefix was read from the cache) is only visible here.
 * Numbers and enums only: never message text, tool arguments, error messages or URLs.
 */

/** What the stream shows of an assistant message's usage: tokens and the total cost in USD. */
export interface CallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Undefined for a message without usage (a legacy entry); missing numbers read as 0. */
export function callUsage(usage: Partial<Usage> | undefined): CallUsage | undefined {
  if (typeof usage !== "object") return undefined;
  return {
    input: count(usage.input),
    output: count(usage.output),
    cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite),
    cost: count(usage.cost?.total),
  };
}

/** Where a call belongs. `session`, `turn` and `seq` are absent when they could not be told. */
export interface CallContext {
  session?: string;
  conversation: number;
  /** The inbox event id of the run's newest input, which is also its Pi Durable `requestId` (as in `turn-timing`). */
  turn?: string;
  /** The call's number in its run, from 1: the run's tool rounds so far plus one. A retried attempt repeats it. */
  seq?: number;
  /** The trim boundary moved at this request, so the cached prefix was rewritten (ADR 0067). */
  trimMoved: boolean;
}

/** The fields of a `model-call` line. Built field by field so nothing of the message's content can slip in. */
export function modelCallFields(
  message: AssistantMessage,
  context: CallContext,
): Record<string, unknown> {
  const usage = callUsage(message.usage) ?? callUsage({});
  return {
    ...(context.session === undefined ? {} : { session: context.session }),
    conversation: context.conversation,
    ...(context.turn === undefined ? {} : { turn: context.turn }),
    ...(context.seq === undefined ? {} : { seq: context.seq }),
    model: message.model,
    provider: message.provider,
    ...usage,
    stopReason: message.stopReason,
    ...(typeof message.durationMs === "number" && Number.isFinite(message.durationMs)
      ? { ms: Math.round(message.durationMs) }
      : {}),
    trimMoved: context.trimMoved,
  };
}

/** Lookups the line needs that the hook does not have. */
export interface ModelCallSources {
  /** The session id of a conversation (`Host.open`'s `sessionKeyOf`). */
  sessionOf: (conversationId: number) => Promise<string>;
  storage: Pick<Storage, "submission">;
}

/** Entries kept per cache; a cache over its size is emptied (they are only lookups saved). */
const MAX_CACHED = 1000;

function remember<K, V>(cache: Map<K, V>, key: K, value: V): V {
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, value);
  return value;
}

/**
 * Owns the `model-calls` extension. Its `afterResponse` hook runs once per terminal provider response, live, before
 * Pi Durable commits it: a restarted orchestrator does not run it again for messages already stored, and a request that
 * is sent again after a crash is a new paid call, so it gets its own line. Compaction requests are not generation
 * requests and are not logged. A lookup that fails leaves its field out; the line and the request never fail for it.
 */
export class ModelCalls {
  readonly #sources: ModelCallSources;
  /** Generation task id -> whether its latest request moved the trim boundary, from `trim-context`. */
  readonly #moved = new Map<string, boolean>();
  readonly #sessions = new Map<number, string>();
  readonly #turns = new Map<string, string | undefined>();
  readonly extension: Extension;

  constructor(sources: ModelCallSources) {
    this.#sources = sources;
    this.extension = defineExtension({
      name: "model-calls",
      hooks: [
        hook(GenerationTask, {
          afterResponse: async (message, api, context) => {
            const conversation = Number(api.conversationId);
            const trimMoved = this.#takeMoved(String(api.taskId));
            let run: LiveRun | undefined;
            try {
              run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
            } catch (error) {
              log("model-call-lookup-failed", { conversation, message: errorMessage(error) });
            }
            const newest = run?.inputs.at(-1);
            const [session, turn] = await Promise.all([
              this.#sessionOf(conversation),
              newest === undefined ? undefined : this.#turnOf(newest, context),
            ]);
            const fields = modelCallFields(message, {
              ...(session === undefined ? {} : { session }),
              conversation,
              ...(turn === undefined ? {} : { turn }),
              ...(run === undefined ? {} : { seq: run.turns + 1 }),
              trimMoved,
            });
            log("model-call", fields);
          },
        }),
      ],
    });
  }

  /** `trim-context` reports each request's boundary here (its `beforeRequest`). */
  trimmed(taskId: string, moved: boolean): void {
    remember(this.#moved, taskId, moved);
  }

  #takeMoved(taskId: string): boolean {
    const moved = this.#moved.get(taskId) ?? false;
    this.#moved.delete(taskId);
    return moved;
  }

  async #sessionOf(conversation: number): Promise<string | undefined> {
    const known = this.#sessions.get(conversation);
    if (known !== undefined) return known;
    try {
      return remember(this.#sessions, conversation, await this.#sources.sessionOf(conversation));
    } catch (error) {
      log("model-call-lookup-failed", { conversation, message: errorMessage(error) });
      return undefined;
    }
  }

  async #turnOf(submission: SubmissionId, context: Context): Promise<string | undefined> {
    const key = String(submission);
    if (this.#turns.has(key)) return this.#turns.get(key);
    try {
      const record = await this.#sources.storage.submission(submission, context);
      return remember(this.#turns, key, record?.requestId);
    } catch (error) {
      log("model-call-lookup-failed", { submission: key, message: errorMessage(error) });
      return undefined;
    }
  }
}
