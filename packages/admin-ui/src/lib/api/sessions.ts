import { adminJson, adminRequest } from "@/lib/api/raw";
import { SseParser } from "@/lib/sse";
import type { SseMessage } from "@/lib/sse";

/**
 * The session API (docs/session-api.md) as the playground uses it. The playground starts real sessions as the owner of
 * the console's token: they run in a sandbox and spend model tokens, like any client's.
 */
export interface CreateSessionBody {
  profile?: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  sandboxSize?: string;
}

export interface CreatedSession {
  sessionId: string;
  profile: { name: string; version: number };
  provider: string;
  model: string;
  reasoning?: string;
  sandboxSize?: string;
  networkMode?: string;
  sandboxFlavour?: string;
}

export type SessionStatus = "active" | "failed" | "deleting" | "deleted";

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  profile: { name: string; version: number };
  model: { provider: string; model: string; reasoning?: string };
  sandboxSize?: string;
  failure?: string;
  usage?: { totalTokens: number; cost: number };
}

const path = (id: string): string => `/sessions/${encodeURIComponent(id)}`;

export function createSession(token: string, body: CreateSessionBody): Promise<CreatedSession> {
  return adminJson<CreatedSession>(token, "/sessions", { method: "POST", body });
}

export function getSession(token: string, id: string, signal?: AbortSignal): Promise<SessionInfo> {
  return adminJson<SessionInfo>(token, path(id), signal ? { signal } : {});
}

/** `message` starts or queues a turn; `cancel` aborts the running one and withdraws what is queued behind it. */
export async function postSessionEvent(
  token: string,
  id: string,
  event: { kind: "message"; text: string } | { kind: "cancel" },
): Promise<void> {
  await adminRequest(token, `${path(id)}/events`, { method: "POST", body: event });
}

/** Idempotent: a session that is already deleting answers `202` again. */
export async function deleteSession(
  token: string,
  id: string,
  options: { keepalive?: boolean } = {},
): Promise<void> {
  await adminRequest(token, path(id), { method: "DELETE", ...options });
}

/**
 * Reads `GET /sessions/{id}/stream` until it ends, handing each event to `onMessage`. Resolves when the server closes
 * the stream (a reconnect is the caller's call); rejects with an `ApiError` for a non-2xx answer (`410` and `404` mean
 * the session is gone, `503` that the orchestrator is down) and with the network error when the connection breaks.
 * `lastEventId` goes in the standard header so entries resume after the last one seen.
 */
export async function readSessionStream(
  token: string,
  id: string,
  options: {
    lastEventId?: string;
    signal: AbortSignal;
    onOpen: () => void;
    onMessage: (message: SseMessage) => void;
  },
): Promise<void> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (options.lastEventId !== undefined) headers["last-event-id"] = options.lastEventId;
  const res = await adminRequest(token, `${path(id)}/stream`, { signal: options.signal, headers });
  options.onOpen();
  if (res.body === null) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  // An abort ends a pending read with an error under `fetch`; cancelling makes it end the same way whatever the source.
  const stop = (): void => void reader.cancel().catch(() => undefined);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const message of parser.push(decoder.decode(value, { stream: true })))
        options.onMessage(message);
    }
  } finally {
    options.signal.removeEventListener("abort", stop);
    // Releases the connection when the caller aborts or a message handler throws.
    await reader.cancel().catch(() => undefined);
  }
}
