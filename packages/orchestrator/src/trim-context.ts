import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { errorMessage, log } from "./log.js";
import { contextTrimOf, validateProfileDefinition } from "@cela/session-core";
import type { ContextTrim, SessionRow } from "@cela/session-core";

/**
 * Keeps dead weight out of the model's requests (docs/decisions/0067-trim-context.md): screenshots and large tool
 * outputs that are several turns old are replaced by a short stub in the copy of the history sent to the provider. The
 * stored transcript, the events and what a user sees are never touched (`beforeRequest` results are for that request
 * only). How much is trimmed is a mode per session (the profile's `contextTrim`, ADR 0067): `images` leaves out old
 * screenshots, `full` also large old text results, `off` nothing. Trimming is a context-window tool, not a cost tool:
 * it is gated on the prompt size (see `boundaryOf`).
 */

export interface TrimContextOptions {
  /** Images of this many tool results (the latest ones that hold images, among the eligible messages) stay. */
  readonly imageKeep: number;
  /** A tool result whose text is longer than this many characters can be elided. */
  readonly textMaxChars: number;
  /** The newest assistant turns are never touched. */
  readonly turnsKept: number;
  /** Nothing is trimmed until the last request's prompt has at least this many tokens. */
  readonly minPrompt: number;
  /** ... and the tokens a trim would remove are at least this fraction of that prompt (0 < x <= 1). */
  readonly minRatio: number;
  /** How much of an elided text stays, from its start. */
  readonly textHeadChars: number;
}

/** The constants of the rules, in one place. */
export const TRIM_CONTEXT_DEFAULTS: TrimContextOptions = {
  imageKeep: 2,
  textMaxChars: 4_000,
  turnsKept: 3,
  minPrompt: 100_000,
  minRatio: 0.5,
  textHeadChars: 600,
};

/** How removed content is turned into tokens, for the gate's "would remove" estimate. */
export const TOKEN_ESTIMATE = { charsPerToken: 4, imageTokens: 1_000 } as const;

const IMAGE_STUB_PREFIX = "[image elided to save context: ";
const FALLBACK_IMAGE_NAME = "earlier screenshot";

const imageStub = (name: string): TextContent => ({
  type: "text",
  text: `${IMAGE_STUB_PREFIX}${name}; your note after it says what it showed; read it again if needed]`,
});

const isStub = (part: TextContent | ImageContent): boolean =>
  part.type === "text" && part.text.startsWith(IMAGE_STUB_PREFIX);

const hasImage = (message: ToolResultMessage): boolean =>
  message.content.some((part) => part.type === "image");

/** The path a tool call read, from the arguments of the call a result answers; undefined when it has none. */
function pathOf(messages: readonly Message[], result: ToolResultMessage): string | undefined {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type !== "toolCall" || part.id !== result.toolCallId) continue;
      const value = part.arguments.path ?? part.arguments.file_path;
      return typeof value === "string" && value !== "" ? value : undefined;
    }
  }
  return undefined;
}

/** Tokens of a message's tool-result content by the estimate (text chars / 4, a fixed cost per image). */
function estimatedTokens(message: Message): number {
  if (message.role !== "toolResult") return 0;
  let tokens = 0;
  for (const part of message.content) {
    tokens +=
      part.type === "image"
        ? TOKEN_ESTIMATE.imageTokens
        : part.text.length / TOKEN_ESTIMATE.charsPerToken;
  }
  return tokens;
}

/** The prompt of the request that produced an assistant message, from the provider's own usage; undefined if absent. */
function promptTokens(message: Message): number | undefined {
  if (message.role !== "assistant") return undefined;
  const usage = message.usage as Partial<AssistantMessage["usage"]> | undefined;
  if (usage === undefined) return undefined;
  const total = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return Number.isFinite(total) && total > 0 ? total : undefined;
}

/** Estimated tokens `end` removes: what the messages before it weigh now, minus what the trimmed copy weighs. */
function removedBy(
  messages: readonly Message[],
  end: number,
  mode: ContextTrim,
  options: TrimContextOptions,
): number {
  if (end === 0) return 0;
  const trimmed = applyTrim(messages, end, mode, options);
  let removed = 0;
  for (let index = 0; index < end; index++) {
    const before = messages[index];
    const after = trimmed[index];
    if (before !== undefined && after !== undefined && before !== after)
      removed += estimatedTokens(before) - estimatedTokens(after);
  }
  return removed;
}

/**
 * How many leading messages may change: the trim boundary, a pure function of `messages` (and the constants). It is
 * derived by replaying the conversation, oldest request to newest. The request that carries `k` assistant messages has
 * the usage of the newest of them (the last request's prompt, exact from the provider) and may trim the results of all
 * but the newest `turnsKept` of those turns. At each such request the boundary jumps to that point when
 *   - the last prompt is at least `minPrompt` tokens, and
 *   - what the jump removes (on top of what the boundary already removed) is at least `minRatio` of that prompt.
 * Otherwise it stays. Replaying a prefix of the history gives the same boundary for that prefix, so between two jumps
 * the trimmed part is the same bytes request after request (prompt cache), and a request whose boundary has moved is
 * the one request that rewrites the prefix. After a jump the recorded prompts are the trimmed size, so the gate
 * re-arms only when the prompt has grown back above `minPrompt` with enough to remove again. Why a gate and no
 * schedule: docs/decisions/0067-trim-context.md (a rewrite costs about as much as a full prompt and rarely pays).
 */
function boundaryOf(
  messages: readonly Message[],
  mode: ContextTrim,
  options: TrimContextOptions,
): number {
  const assistants: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant") assistants.push(index);
  });
  let boundary = 0;
  let removed = 0;
  for (let count = 1; count <= assistants.length; count++) {
    const newest = assistants[count - 1];
    const last = newest === undefined ? undefined : messages[newest];
    const prompt = last === undefined ? undefined : promptTokens(last);
    if (prompt === undefined || prompt < options.minPrompt) continue;
    // Everything before the oldest of the newest `turnsKept` assistant turns (their results are theirs).
    const candidate = assistants[count - options.turnsKept] ?? 0;
    if (candidate <= boundary) continue;
    const total = removedBy(messages, candidate, mode, options);
    if (total - removed >= options.minRatio * prompt) {
      boundary = candidate;
      removed = total;
    }
  }
  return boundary;
}

function elideText(text: string, options: TrimContextOptions): string | undefined {
  if (text.length <= options.textMaxChars) return undefined;
  const elided = text.length - options.textHeadChars;
  const result = `${text.slice(0, options.textHeadChars)}\n[... ${String(elided)} chars elided to save context; rerun the command or re-read the file if needed]`;
  // Never grow a result, and never elide one again that is already elided.
  return result.length < text.length ? result : undefined;
}

function trimResult(
  messages: readonly Message[],
  message: ToolResultMessage,
  dropImages: boolean,
  trimText: boolean,
  options: TrimContextOptions,
): ToolResultMessage {
  const texts = message.content.filter(
    (part): part is TextContent => part.type === "text" && !isStub(part),
  );
  const joined = texts.map((part) => part.text).join("");
  const elided = trimText ? elideText(joined, options) : undefined;
  if (elided === undefined && !dropImages) return message;
  let textDone = elided === undefined;
  const name = dropImages ? (pathOf(messages, message) ?? FALLBACK_IMAGE_NAME) : "";
  const content: (TextContent | ImageContent)[] = [];
  for (const part of message.content) {
    if (part.type === "image") {
      content.push(dropImages ? imageStub(name) : part);
    } else if (isStub(part) || elided === undefined) {
      content.push(part);
    } else if (!textDone) {
      textDone = true;
      content.push({ ...part, text: elided });
    }
  }
  return { ...message, content };
}

/** The messages with the tool results before `end` trimmed. */
function applyTrim(
  messages: readonly Message[],
  end: number,
  mode: ContextTrim,
  options: TrimContextOptions,
): readonly Message[] {
  const withImages: number[] = [];
  for (let index = 0; index < end; index++) {
    const message = messages[index];
    if (message?.role === "toolResult" && hasImage(message)) withImages.push(index);
  }
  const kept = new Set(options.imageKeep === 0 ? [] : withImages.slice(-options.imageKeep));
  return messages.map((message, index) => {
    if (index >= end || message.role !== "toolResult") return message;
    return trimResult(
      messages,
      message,
      hasImage(message) && !kept.has(index),
      mode === "full",
      options,
    );
  });
}

/**
 * The messages of a request without the weight of old tool results. A pure function of `messages` and `options`: no
 * clock, no randomness, so the same input gives the same bytes, and trimming trimmed messages changes nothing. Only
 * tool results before `boundaryOf` change; system, user and assistant messages (tool call arguments included) never do.
 * The images that stay are those of the last `imageKeep` image-holding results before the boundary, so what is kept
 * does not change while the boundary stays. Below the gate the same array comes back.
 */
export function trimMessages(
  messages: readonly Message[],
  mode: ContextTrim,
  options: TrimContextOptions = TRIM_CONTEXT_DEFAULTS,
): readonly Message[] {
  if (mode === "off") return messages;
  const end = boundaryOf(messages, mode, options);
  if (end === 0) return messages;
  const result = applyTrim(messages, end, mode, options);
  return result.some((message, index) => message !== messages[index]) ? result : messages;
}

/** The mode of a conversation's session; throws when it cannot be told (then that request is sent whole). */
export type ContextTrimOf = (conversationId: number) => Promise<ContextTrim>;

/**
 * The mode of a session: its profile snapshot's `contextTrim`, else `images`. A session without a profile, or with a
 * snapshot that no longer validates, has `images`.
 */
export function sessionContextTrim(session: Pick<SessionRow, "profile"> | undefined): ContextTrim {
  if (session === undefined) return contextTrimOf(undefined);
  const snapshot =
    session.profile === null ? undefined : validateProfileDefinition(session.profile.snapshot);
  return contextTrimOf(typeof snapshot === "string" ? undefined : snapshot);
}

/** Without a lookup (tests, control sessions) every conversation has the default mode. */
const DEFAULT_MODE: ContextTrimOf = () => Promise.resolve(sessionContextTrim(undefined));

/**
 * The mode is read once per conversation and kept: a session's profile snapshot and flavour are fixed when it is
 * created, and a mode that changed between requests would rewrite the prefix the provider caches.
 */
export function createTrimContextExtension(
  options: TrimContextOptions = TRIM_CONTEXT_DEFAULTS,
  modeOf: ContextTrimOf = DEFAULT_MODE,
): Extension {
  const modes = new Map<number, ContextTrim>();
  const modeFor = async (conversationId: number): Promise<ContextTrim | undefined> => {
    const known = modes.get(conversationId);
    if (known !== undefined) return known;
    try {
      const mode = await modeOf(conversationId);
      modes.set(conversationId, mode);
      return mode;
    } catch (error) {
      // A request must not fail for an optimisation; the next request asks again.
      log("trim-context-mode-failed", {
        conversation: conversationId,
        message: errorMessage(error),
      });
      return undefined;
    }
  };
  return defineExtension({
    name: "trim-context",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api) => {
          const mode = await modeFor(Number(api.conversationId));
          if (mode === undefined) return undefined;
          const trimmed = trimMessages(messages, mode, options);
          return trimmed === messages ? undefined : { messages: trimmed };
        },
      }),
    ],
  });
}
