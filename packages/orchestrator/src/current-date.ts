import type { Message } from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";

/**
 * Shows the agent the date each user message was sent (docs/decisions/0057-current-date.md). Without it the model takes
 * "now" to be near its training cutoff. The date is added per request and never stored: the transcript keeps the
 * user's own text, and the instructions stay free of anything that changes over time (ADR 0049).
 */

const TAG = "current_date";
const BLOCK = /^<current_date>\d{4}-\d{2}-\d{2} \(UTC\)<\/current_date>$/;

/** The text block put in front of a user message sent at `timestamp` (ms since the epoch). */
export function dateBlock(timestamp: number): string {
  return `<${TAG}>${new Date(timestamp).toISOString().slice(0, 10)} (UTC)</${TAG}>`;
}

/** True for a block `dateBlock` made, so a reader of user text (the faux model) can leave it out. */
export function isDateBlock(text: string): boolean {
  return BLOCK.test(text);
}

/**
 * Each user message with the date it was sent in front, as a separate text block. The date comes from the message's
 * stored timestamp, never from the clock, so every request of a conversation sends the same bytes for the same
 * message and the provider's prompt cache holds. A message without a usable timestamp is left as it is.
 */
export function stampDates(messages: readonly Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "user" || !Number.isFinite(message.timestamp) || message.timestamp <= 0)
      return message;
    const block = { type: "text" as const, text: dateBlock(message.timestamp) };
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    return { ...message, content: [block, ...content] };
  });
}

export function createCurrentDateExtension(): Extension {
  return defineExtension({
    name: "current-date",
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => ({ messages: stampDates(messages) }),
      }),
    ],
  });
}
