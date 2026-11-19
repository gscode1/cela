import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { mcpToolParts } from "@/lib/playground";
import type { LiveState, TranscriptItem } from "@/lib/playground";
import { cn } from "@/lib/utils";

/** A result up to this size shows inline; a longer one sits behind a summary so a big tool output does not bury the chat. */
const INLINE_LIMIT = 600;
const INLINE_LINES = 12;
/** What the page renders of one text at most: the browser stays responsive on a runaway tool output. */
const RENDER_LIMIT = 100_000;

function clip(text: string): string {
  return text.length <= RENDER_LIMIT
    ? text
    : `${text.slice(0, RENDER_LIMIT)}\n\n[… ${String(text.length - RENDER_LIMIT)} more characters not shown]`;
}

const lineCount = (text: string): number => text.split("\n").length;

/** Text is rendered as text, never as HTML: a model or a tool can return anything. */
function Pre({ children, className }: { children: string; className?: string | undefined }) {
  return (
    <pre
      className={cn(
        "max-h-96 overflow-auto rounded-md bg-muted px-3 py-2 text-xs break-words whitespace-pre-wrap",
        className,
      )}
    >
      {clip(children)}
    </pre>
  );
}

function ToolCall({ item }: { item: Extract<TranscriptItem, { type: "tool" }> }) {
  const mcp = mcpToolParts(item.name);
  const { result } = item;
  const long =
    result !== undefined &&
    (result.text.length > INLINE_LIMIT || lineCount(result.text) > INLINE_LINES);
  return (
    <div
      data-testid="tool-call"
      data-tool={item.name}
      className={cn(
        "flex flex-col gap-2 rounded-md border px-3 py-2 text-sm",
        result?.isError === true && "border-destructive/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {mcp !== undefined && <Badge variant="outline">MCP {mcp.server}</Badge>}
        <code className="font-medium break-all">{mcp?.tool ?? item.name}</code>
        {mcp !== undefined && (
          <span className="text-xs text-muted-foreground break-all">{item.name}</span>
        )}
        {result === undefined ? (
          <Badge variant="warning">running</Badge>
        ) : result.isError ? (
          <Badge variant="destructive">error</Badge>
        ) : (
          <Badge>ok</Badge>
        )}
      </div>
      {item.args !== "" && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Arguments</summary>
          <Pre className="mt-1">{item.args}</Pre>
        </details>
      )}
      {result !== undefined &&
        (long ? (
          <details open={result.isError}>
            <summary className="cursor-pointer text-xs text-muted-foreground">
              {result.isError ? "Error" : "Result"} ({String(result.text.length)} characters)
            </summary>
            <Pre className="mt-1">{result.text}</Pre>
          </details>
        ) : (
          <Pre className={result.isError ? "text-destructive" : undefined}>
            {result.text === "" ? "(empty result)" : result.text}
          </Pre>
        ))}
    </div>
  );
}

function Bubble({
  who,
  text,
  testId,
  pending,
}: {
  who: "You" | "Agent";
  text: string;
  testId: string;
  pending?: boolean;
}) {
  return (
    <div
      data-testid={testId}
      className={cn(
        "flex max-w-[85%] flex-col gap-1 rounded-lg px-3 py-2 text-sm",
        who === "You" ? "self-end bg-primary text-primary-foreground" : "self-start bg-muted",
        pending === true && "opacity-70",
      )}
    >
      <span className="text-xs opacity-70">{who}</span>
      <span className="break-words whitespace-pre-wrap">{text}</span>
    </div>
  );
}

/**
 * The conversation as the stream reported it: what the user sent, what the agent said and every tool call with its
 * result, in order. The answer being written (`live.partial`) shows dimmed until it is committed as an entry.
 */
export function Transcript({
  items,
  live,
}: {
  items: readonly TranscriptItem[];
  live: LiveState | undefined;
}) {
  const end = useRef<HTMLDivElement>(null);
  const partial = live?.partial;
  useEffect(() => {
    const node = end.current;
    if (node !== null && typeof node.scrollIntoView === "function")
      node.scrollIntoView({ block: "nearest" });
  }, [items.length, partial]);
  return (
    <div
      role="log"
      aria-label="Transcript"
      className="flex max-h-[60vh] min-h-48 flex-col gap-3 overflow-y-auto rounded-md border p-3"
    >
      {items.length === 0 && partial === undefined && (
        <p className="text-sm text-muted-foreground">
          No messages yet. The first one starts the sandbox, so its answer can take a while.
        </p>
      )}
      {items.map((item) => {
        switch (item.type) {
          case "user":
            return <Bubble key={item.key} who="You" text={item.text} testId="msg-user" />;
          case "assistant":
            return <Bubble key={item.key} who="Agent" text={item.text} testId="msg-assistant" />;
          case "tool":
            return <ToolCall key={item.key} item={item} />;
          case "other":
            return (
              <div key={item.key} className="text-xs text-muted-foreground">
                <span className="font-medium">{item.role}</span>
                <Pre className="mt-1">{item.text}</Pre>
              </div>
            );
        }
      })}
      {partial !== undefined && <Bubble who="Agent" text={partial} testId="msg-partial" pending />}
      <div ref={end} />
    </div>
  );
}
