import { randomUUID } from "node:crypto";
import type { EventKind, InboxEvent } from "@cela/session-core";

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

/**
 * The id of `GET /sessions/{id}/events/{eventId}`: the decimal row id ingest returned for the post. Anything else, or a
 * number past bigint, is undefined (a 404, like an id of another session), so it never reaches the query as an error.
 */
export function parseEventId(raw: string): string | undefined {
  return /^[1-9][0-9]{0,17}$/.test(raw) ? raw : undefined;
}

/**
 * The body of `GET /sessions/{id}/events/{eventId}` (ADR 0058). The stored `error` is left out: it is the orchestrator's
 * own message and can name internals; `status: failed` says enough. The payload (the text) is the caller's own.
 */
export function eventView(event: InboxEvent): Record<string, unknown> {
  const outcome = event.outcome;
  return {
    eventId: event.id,
    kind: event.kind,
    status: event.status,
    createdAt: event.createdAt.toISOString(),
    ...(event.submittedAt === null ? {} : { submittedAt: event.submittedAt.toISOString() }),
    ...(outcome === undefined
      ? {}
      : {
          outcome: {
            state: outcome.state,
            ...(outcome.state === "unanswered" ? { reason: outcome.reason } : {}),
            settledAt: outcome.settledAt.toISOString(),
          },
        }),
  };
}
