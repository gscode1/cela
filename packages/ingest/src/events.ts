import { randomUUID } from "node:crypto";
import type { EventKind } from "@cela/session-core";

const MAX_TEXT = 64 * 1024;
const MAX_SOURCE_EVENT_ID = 200;

// Postgres text and jsonb reject NUL, and jsonb also rejects the `\udXXX` escape JSON.stringify emits for a lone
// surrogate. Both would surface as a 500 at insert time, so refuse them up front with a 400.
const UNSTORABLE = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const UNSTORABLE_MESSAGE = "must not contain NUL or unpaired surrogate characters";

export interface ParsedEvent {
  kind: Exclude<EventKind, "delete">;
  payload: { text?: string };
  sourceEventId: string;
}

/** Validates the body of POST /sessions/{id}/events. Returns an error string for the 400 response. */
export function parseEventBody(body: Record<string, unknown>): ParsedEvent | string {
  const { kind, text, sourceEventId } = body;
  if (kind === "delete") return "use DELETE /sessions/{id} to delete a session";
  if (kind !== "message" && kind !== "steer" && kind !== "cancel") {
    return "kind must be message, steer or cancel";
  }
  if (kind !== "cancel") {
    if (typeof text !== "string" || text.trim() === "") return `${kind} needs a non-empty text`;
    if (text.length > MAX_TEXT) return `text is longer than ${String(MAX_TEXT)} characters`;
    if (UNSTORABLE.test(text)) return `text ${UNSTORABLE_MESSAGE}`;
  } else if (text !== undefined) {
    return "cancel takes no text";
  }
  if (sourceEventId !== undefined) {
    if (
      typeof sourceEventId !== "string" ||
      sourceEventId === "" ||
      sourceEventId.length > MAX_SOURCE_EVENT_ID
    ) {
      return `sourceEventId must be a string of 1 to ${String(MAX_SOURCE_EVENT_ID)} characters`;
    }
    if (UNSTORABLE.test(sourceEventId)) return `sourceEventId ${UNSTORABLE_MESSAGE}`;
  }
  return {
    kind,
    payload: typeof text === "string" ? { text } : {},
    // Without a client-supplied id every post is its own event: there is nothing to deduplicate on.
    sourceEventId: typeof sourceEventId === "string" ? sourceEventId : `auto-${randomUUID()}`,
  };
}
