import { useEffect, useReducer, useRef } from "react";
import { ApiError } from "@/lib/api";
import { readSessionStream } from "@/lib/api/sessions";
import { applyEntry, EMPTY_TRANSCRIPT, parseEntry, parseLive } from "@/lib/playground";
import type { LiveState, Transcript } from "@/lib/playground";

export type Connection =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  /** The session was deleted (or is not ours): no reconnect. */
  | "gone"
  /** The server refused the stream for a reason a retry will not fix. */
  | "failed";

export interface StreamState {
  transcript: Transcript;
  live: LiveState | undefined;
  connection: Connection;
  /** The last connection error, kept while reconnecting so it can be shown. */
  error: string | undefined;
}

type Action =
  | { type: "reset"; connection: Connection }
  | { type: "entry"; entry: Parameters<typeof applyEntry>[1] }
  | { type: "live"; live: LiveState }
  | { type: "connection"; connection: Connection; error?: string | undefined };

const initial: StreamState = {
  transcript: EMPTY_TRANSCRIPT,
  live: undefined,
  connection: "idle",
  error: undefined,
};

function reduce(state: StreamState, action: Action): StreamState {
  switch (action.type) {
    case "reset":
      return { ...initial, connection: action.connection };
    case "entry":
      return { ...state, transcript: applyEntry(state.transcript, action.entry) };
    case "live":
      return { ...state, live: action.live };
    case "connection":
      return {
        ...state,
        connection: action.connection,
        error: action.connection === "open" ? undefined : (action.error ?? state.error),
      };
  }
}

/** First wait before a reconnect; it doubles up to `MAX_BACKOFF_MS` and starts over once a stream opens. */
export const BASE_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 10_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Follows one session's stream with `fetch` (an `EventSource` cannot send the bearer token) and keeps it open: when the
 * connection drops or the server ends it (proxy, orchestrator restart), it reconnects with `Last-Event-ID` so no entry
 * is lost or doubled. It stops for good on `404`/`410` (session gone) and other 4xx answers.
 */
export function useSessionStream(token: string, sessionId: string | undefined): StreamState {
  const [state, dispatch] = useReducer(reduce, initial);
  // Read by the loop, never rendered: a ref keeps the cursor across reconnects without restarting the effect.
  const cursor = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (sessionId === undefined) {
      dispatch({ type: "reset", connection: "idle" });
      return undefined;
    }
    dispatch({ type: "reset", connection: "connecting" });
    cursor.current = undefined;
    const controller = new AbortController();
    const { signal } = controller;
    let backoff = BASE_BACKOFF_MS;
    // One object: the handlers below change it, which control-flow analysis cannot see on a plain `let`.
    const state: { ended: boolean } = { ended: false };

    // Functions, so the checks after an await are not narrowed by the loop condition.
    const aborted = (): boolean => signal.aborted;
    const finished = (): boolean => state.ended;

    const run = async (): Promise<void> => {
      while (!aborted() && !finished()) {
        try {
          await readSessionStream(token, sessionId, {
            signal,
            ...(cursor.current === undefined ? {} : { lastEventId: cursor.current }),
            onOpen: () => {
              backoff = BASE_BACKOFF_MS;
              dispatch({ type: "connection", connection: "open" });
            },
            onMessage: (message) => {
              if (message.event === "entry") {
                const entry = parseEntry(message.data, message.id);
                if (entry === undefined) return;
                if (message.id !== undefined) cursor.current = message.id;
                dispatch({ type: "entry", entry });
              } else if (message.event === "live") {
                const live = parseLive(message.data);
                if (live !== undefined) dispatch({ type: "live", live });
              } else if (message.event === "deleted") {
                state.ended = true;
                dispatch({ type: "connection", connection: "gone" });
              }
            },
          });
          if (finished()) return;
          dispatch({ type: "connection", connection: "reconnecting", error: "The stream ended." });
        } catch (error) {
          if (aborted()) return;
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            const gone = error.status === 404 || error.status === 410;
            dispatch({
              type: "connection",
              connection: gone ? "gone" : "failed",
              error: error.message,
            });
            return;
          }
          const text = error instanceof Error ? error.message : "The connection broke.";
          dispatch({ type: "connection", connection: "reconnecting", error: text });
        }
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    };
    void run();
    return () => {
      controller.abort();
    };
  }, [token, sessionId]);

  return state;
}
