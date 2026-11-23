import type { ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
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
 * screenshots, `full` also large old text results, `off` nothing.
 */

export interface TrimContextOptions {
  /** Images of this many tool results (the latest ones that hold images, among the eligible messages) stay. */
  readonly imageKeep: number;
  /** A tool result whose text is longer than this many characters can be elided. */
  readonly textMaxChars: number;
  /** The newest assistant turns are never touched. */
  readonly turnsKept: number;
  /** The elision boundary moves in steps of this many assistant turns (prompt-cache friendliness). */
  readonly stepTurns: number;
  /** How much of an elided text stays, from its start. */
  readonly textHeadChars: number;
}

/** The constants of the rules, in one place. */
export const TRIM_CONTEXT_DEFAULTS: TrimContextOptions = {
  imageKeep: 2,
  textMaxChars: 4_000,
  turnsKept: 3,
  stepTurns: 8,
  textHeadChars: 600,
};

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

/**
 * How many leading messages may change. It depends on the count of assistant turns only, in steps of `stepTurns`, and
 * leaves the newest `turnsKept` turns out: between two steps the same messages are eligible, so the trimmed prefix is
 * the same bytes request after request and the provider's prompt cache holds.
 */
function eligibleEnd(messages: readonly Message[], options: TrimContextOptions): number {
  const assistants: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === "assistant") assistants.push(index);
  });
  const old = Math.max(0, assistants.length - options.turnsKept);
  const turns = Math.floor(old / options.stepTurns) * options.stepTurns;
  const last = turns === 0 ? undefined : assistants[turns - 1];
  return last === undefined ? 0 : last + 1;
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

/**
 * The messages of a request without the weight of old tool results. A pure function of `messages` and `options`: no
 * clock, no randomness, so the same input gives the same bytes, and trimming trimmed messages changes nothing. Only
 * tool results before `eligibleEnd` change; system, user and assistant messages (tool call arguments included) never do.
 * The images that stay are those of the last `imageKeep` image-holding results among the eligible ones, so what is kept
 * does not change while the boundary stays.
 */
export function trimMessages(
  messages: readonly Message[],
  mode: ContextTrim,
  options: TrimContextOptions = TRIM_CONTEXT_DEFAULTS,
): readonly Message[] {
  if (mode === "off") return messages;
  const end = eligibleEnd(messages, options);
  if (end === 0) return messages;
  const withImages: number[] = [];
  for (let index = 0; index < end; index++) {
    const message = messages[index];
    if (message?.role === "toolResult" && hasImage(message)) withImages.push(index);
  }
  const kept = new Set(options.imageKeep === 0 ? [] : withImages.slice(-options.imageKeep));
  const result = messages.map((message, index) => {
    if (index >= end || message.role !== "toolResult") return message;
    return trimResult(
      messages,
      message,
      hasImage(message) && !kept.has(index),
      mode === "full",
      options,
    );
  });
  return result.some((message, index) => message !== messages[index]) ? result : messages;
}

/** The mode of a conversation's session; throws when it cannot be told (then that request is sent whole). */
export type ContextTrimOf = (conversationId: number) => Promise<ContextTrim>;

/**
 * The mode of a session: its profile snapshot's `contextTrim`, else the default of its flavour (`full` for browser and
 * desktop, `images` for default). A session without a profile, or with a snapshot that no longer validates, has the
 * default of its flavour.
 */
export function sessionContextTrim(
  session: Pick<SessionRow, "profile" | "sandboxFlavour"> | undefined,
): ContextTrim {
  if (session === undefined) return contextTrimOf(undefined, "default");
  const snapshot =
    session.profile === null ? undefined : validateProfileDefinition(session.profile.snapshot);
  return contextTrimOf(typeof snapshot === "string" ? undefined : snapshot, session.sandboxFlavour);
}

/** Without a lookup (tests, control sessions) every conversation has the mode of the default flavour. */
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
