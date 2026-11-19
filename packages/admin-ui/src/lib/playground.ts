import type { McpServerRef } from "@/lib/api/profiles";

/** One message of a stream `entry` (docs/session-api.md, Streaming). */
export interface WireMessage {
  role: string;
  text: string;
  /** Tool calls of an assistant message, each as `name(json arguments)`. */
  calls?: string[];
  isError?: boolean;
}

export interface WireEntry {
  id: number;
  kind: string;
  messages: WireMessage[];
}

/** The `live` event: the run in progress. */
export interface LiveState {
  running: boolean;
  queued: number;
  partial?: string;
  tools?: { callId: string; name: string; status: string }[];
  runFailure?: string;
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

export type TranscriptItem =
  | { type: "user"; key: string; text: string }
  | { type: "assistant"; key: string; text: string }
  | {
      type: "tool";
      key: string;
      name: string;
      /** Pretty-printed when the arguments are JSON, as received otherwise. */
      args: string;
      result: ToolResult | undefined;
    }
  /** A role the console has no view for; shown as plain text rather than dropped. */
  | { type: "other"; key: string; role: string; text: string };

export interface Transcript {
  items: TranscriptItem[];
  /** The newest entry applied: an entry at or below it is a replay and is ignored. */
  lastEntryId: number;
}

export const EMPTY_TRANSCRIPT: Transcript = { items: [], lastEntryId: 0 };

/** `read({"path":"a"})` -> name and the raw argument text. A text without parentheses is all name. */
export function parseCall(call: string): { name: string; args: string } {
  const open = call.indexOf("(");
  if (open < 0 || !call.endsWith(")")) return { name: call, args: "" };
  const raw = call.slice(open + 1, -1);
  let args = raw;
  try {
    args = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    // Not JSON (the server always sends JSON, but a text is still worth showing as it is).
  }
  return { name: call.slice(0, open), args };
}

/** `mcp__<server>__<tool>` as the host names the tools of an MCP server; undefined for any other tool. */
export function mcpToolParts(name: string): { server: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { server: match[1], tool: match[2] };
}

/**
 * Applies one committed entry to the transcript. The stream carries no call ids on results, so a `toolResult` answers
 * the oldest call that has none yet: the host runs and records a turn's calls in order.
 */
export function applyEntry(transcript: Transcript, entry: WireEntry): Transcript {
  if (entry.id <= transcript.lastEntryId) return transcript;
  const items = [...transcript.items];
  entry.messages.forEach((message, index) => {
    const key = `${String(entry.id)}.${String(index)}`;
    if (message.role === "user") items.push({ type: "user", key, text: message.text });
    else if (message.role === "assistant") {
      if (message.text !== "") items.push({ type: "assistant", key, text: message.text });
      (message.calls ?? []).forEach((call, callIndex) => {
        const { name, args } = parseCall(call);
        items.push({
          type: "tool",
          key: `${key}.${String(callIndex)}`,
          name,
          args,
          result: undefined,
        });
      });
    } else if (message.role === "toolResult") {
      const waiting = items.findIndex((item) => item.type === "tool" && item.result === undefined);
      const result: ToolResult = { text: message.text, isError: message.isError === true };
      const target = waiting < 0 ? undefined : items[waiting];
      if (target?.type === "tool") items[waiting] = { ...target, result };
      else items.push({ type: "other", key, role: "toolResult", text: message.text });
    } else items.push({ type: "other", key, role: message.role, text: message.text });
  });
  return { items, lastEntryId: entry.id };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses the data of an `entry` event; undefined when it is not the documented shape (it is then skipped). */
export function parseEntry(data: string, id: string | undefined): WireEntry | undefined {
  const value = parseJson(data);
  if (!isObject(value) || !Array.isArray(value.messages)) return undefined;
  const messages: WireMessage[] = [];
  for (const raw of value.messages as unknown[]) {
    if (!isObject(raw) || typeof raw.role !== "string") return undefined;
    const message: WireMessage = {
      role: raw.role,
      text: typeof raw.text === "string" ? raw.text : "",
    };
    if (Array.isArray(raw.calls)) message.calls = raw.calls.filter((c) => typeof c === "string");
    if (typeof raw.isError === "boolean") message.isError = raw.isError;
    messages.push(message);
  }
  const entryId = typeof value.id === "number" ? value.id : Number(id);
  if (!Number.isSafeInteger(entryId)) return undefined;
  return { id: entryId, kind: typeof value.kind === "string" ? value.kind : "", messages };
}

export function parseLive(data: string): LiveState | undefined {
  const value = parseJson(data);
  if (!isObject(value) || typeof value.running !== "boolean") return undefined;
  const live: LiveState = {
    running: value.running,
    queued: typeof value.queued === "number" ? value.queued : 0,
  };
  if (typeof value.partial === "string") live.partial = value.partial;
  if (typeof value.runFailure === "string") live.runFailure = value.runFailure;
  if (Array.isArray(value.tools))
    live.tools = (value.tools as unknown[]).flatMap((tool) =>
      isObject(tool) && typeof tool.name === "string"
        ? [
            {
              callId: typeof tool.callId === "string" ? tool.callId : "",
              name: tool.name,
              status: typeof tool.status === "string" ? tool.status : "",
            },
          ]
        : [],
    );
  return live;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The profile a "Try in playground" link opens: the first profile open to new sessions that names the server. */
export function profileForMcp(
  profiles: readonly { name: string; enabledForNew: boolean; mcpServers: readonly string[] }[],
  server: string,
): string | undefined {
  return profiles.find((p) => p.enabledForNew && p.mcpServers.includes(server))?.name;
}

/** The MCP servers of a profile that the catalog marks disabled: their tools will not reach the session. */
export function disabledMcpOf(
  profileServers: readonly string[],
  catalog: readonly McpServerRef[],
): string[] {
  return profileServers.filter((name) => catalog.some((s) => s.name === name && !s.enabled));
}

/** A session the playground started in this browser; the session API has no list, so the console keeps ids. */
export interface StoredSession {
  id: string;
  profile: string;
  startedAt: string;
}

const STORE_KEY = "playground-sessions";

/** Browser storage can be missing or throw (private windows, blocked site data); the page works without it. */
export function loadStoredSessions(): StoredSession[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is StoredSession =>
        isObject(v) &&
        typeof v.id === "string" &&
        typeof v.profile === "string" &&
        typeof v.startedAt === "string",
    );
  } catch {
    return [];
  }
}

export function saveStoredSessions(sessions: readonly StoredSession[]): void {
  try {
    if (sessions.length === 0) localStorage.removeItem(STORE_KEY);
    else localStorage.setItem(STORE_KEY, JSON.stringify(sessions));
  } catch {
    // Without storage the list of open sessions is just empty after a reload.
  }
}
