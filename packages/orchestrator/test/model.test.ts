import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { parseScript, scriptedReply } from "../src/model.ts";

const script = {
  steps: [{ bash: "echo one" }, { bash: "echo two", timeout: 9 }],
  final: "all done",
};

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 };
}

function result(id: string): Message {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  };
}

async function reply(messages: Message[]) {
  return scriptedReply(
    { messages } as unknown as TranscriptContext,
    undefined,
    {} as never,
    {} as never,
  );
}

describe("scripted model", () => {
  it("calls the first step on a fresh transcript", async () => {
    const message = await reply([user(JSON.stringify(script))]);
    expect(message.content).toMatchObject([
      { type: "toolCall", name: "bash", arguments: { command: "echo one" } },
    ]);
  });

  it("continues from the stored transcript, which is all a restarted process has", async () => {
    const message = await reply([user(JSON.stringify(script)), result("a")]);
    expect(message.content).toMatchObject([
      { type: "toolCall", name: "bash", arguments: { command: "echo two", timeout: 9 } },
    ]);
  });

  it("repeats the same call id when a request is retried", async () => {
    const messages = [user(JSON.stringify(script))];
    const first = await reply(messages);
    const second = await reply(messages);
    expect(first.content).toEqual(second.content);
  });

  it("calls a named tool with its arguments for a tool step", async () => {
    const tools = { steps: [{ tool: "tool_search", args: { query: "wiki" } }] };
    const message = await reply([user(JSON.stringify(tools))]);
    expect(message.content).toMatchObject([
      { type: "toolCall", name: "tool_search", arguments: { query: "wiki" } },
    ]);
  });

  it("answers once every step has a result, even an interrupted one", async () => {
    const message = await reply([user(JSON.stringify(script)), result("a"), result("b")]);
    expect(message.content).toMatchObject([{ type: "text", text: "all done" }]);
  });

  it("answers plain chat text with an echo, so message order shows in the answers", async () => {
    const message = await reply([user("hello there")]);
    expect(message.content).toMatchObject([{ type: "text", text: "echo: hello there" }]);
  });

  it("follows the latest user message, not the first", async () => {
    const second = { steps: [{ bash: "echo later" }] };
    const message = await reply([
      user(JSON.stringify(script)),
      result("a"),
      user(JSON.stringify(second)),
    ]);
    expect(message.content).toMatchObject([
      { type: "toolCall", arguments: { command: "echo later" } },
    ]);
  });
});

describe("parseScript", () => {
  it("rejects scripts without bash steps", () => {
    expect(() => parseScript("{}")).toThrow(/steps/);
    expect(() => parseScript('{"steps":[{"cmd":"x"}]}')).toThrow(/bash/);
    expect(() => parseScript('{"steps":[{"tool":"t"}]}')).toThrow(/args/);
  });
});
