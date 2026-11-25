import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Host, toEvent } from "../src/host.ts";
import { callUsage, modelCallFields } from "../src/model-calls.ts";
import { StreamRegistry } from "../src/sessions.ts";
import { serveStream } from "../src/stream.ts";

const SECRET = "SECRET-MARKER";

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: `thinking ${SECRET}` },
      { type: "text", text: `answer ${SECRET} https://example.com/${SECRET}` },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: `curl ${SECRET}` } },
    ],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-x",
    usage: {
      input: 1200,
      output: 80,
      cacheRead: 9000,
      cacheWrite: 300,
      totalTokens: 10_580,
      cost: { input: 0.0024, output: 0.0008, cacheRead: 0.0009, cacheWrite: 0, total: 0.0041 },
    },
    stopReason: "toolUse",
    errorMessage: `error ${SECRET}`,
    timestamp: 1_000,
    durationMs: 2345.6,
    ...overrides,
  };
}

describe("the model-call line (docs/metrics.md)", () => {
  it("has the documented fields, in order", { timeout: 5_000 }, () => {
    const fields = modelCallFields(assistant(), {
      session: "s1",
      conversation: 7,
      turn: "e1",
      seq: 3,
      trimMoved: false,
    });
    expect(fields).toEqual({
      session: "s1",
      conversation: 7,
      turn: "e1",
      seq: 3,
      model: "gpt-x",
      provider: "openai",
      input: 1200,
      output: 80,
      cacheRead: 9000,
      cacheWrite: 300,
      cost: 0.0041,
      stopReason: "toolUse",
      ms: 2346,
      trimMoved: false,
    });
  });

  it(
    "leaves out what it could not tell, and reads missing usage as zero",
    { timeout: 5_000 },
    () => {
      const message = assistant({ usage: undefined as unknown as AssistantMessage["usage"] });
      delete message.durationMs;
      const fields = modelCallFields(message, { conversation: 7, trimMoved: true });
      expect(Object.keys(fields)).toEqual([
        "conversation",
        "model",
        "provider",
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "cost",
        "stopReason",
        "trimMoved",
      ]);
      expect(fields).toMatchObject({ input: 0, cacheRead: 0, cost: 0, trimMoved: true });
    },
  );

  it(
    "never carries message text, thinking, tool arguments, error text or URLs",
    { timeout: 5_000 },
    () => {
      const line = JSON.stringify(
        modelCallFields(assistant({ stopReason: "error" }), {
          session: "s1",
          conversation: 7,
          turn: "e1",
          seq: 1,
          trimMoved: false,
        }),
      );
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("http");
      // Every value is a number, a boolean or one of the identifiers above: no room for content.
      for (const value of Object.values(JSON.parse(line) as Record<string, unknown>)) {
        expect(["number", "boolean", "string"]).toContain(typeof value);
      }
    },
  );
});

describe("usage on streamed messages", () => {
  it("is on assistant messages and nowhere else", { timeout: 5_000 }, () => {
    const event = toEvent(assistant());
    expect(event.usage).toEqual({
      input: 1200,
      output: 80,
      cacheRead: 9000,
      cacheWrite: 300,
      cost: 0.0041,
    });
    // The fields that were there before are unchanged.
    expect(event.role).toBe("assistant");
    expect(event.calls).toEqual([`bash(${JSON.stringify({ command: `curl ${SECRET}` })})`]);
    const user: Message = { role: "user", content: "hi", timestamp: 1 };
    expect(toEvent(user)).toEqual({ role: "user", text: "hi" });
    expect(callUsage(undefined)).toBeUndefined();
  });
});

describe("model calls through the host", () => {
  const config = loadConfig({
    PI_ORCH_NAMESPACE: "test-ns",
    PI_ORCH_WARMPOOL: "test-pool",
    PI_ONECLI_GATEWAY: "http://gateway:10255",
    PI_ONECLI_API: "http://gateway-api:10256",
    PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
    PI_API_TOKENS: "alice:0123456789abcdef0123",
  });
  const hosts: Host[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  });

  async function settle(host: Host, id: number, requestId: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const state = await host.submissionState(id, requestId);
      if (state?.status === "done" || state?.status === "unanswered") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("submission did not settle");
  }

  /** The `entry` events of a conversation's stream, read until `count` of them arrived. */
  async function streamEntries(
    host: Host,
    id: number,
    count: number,
  ): Promise<{ messages: Record<string, unknown>[] }[]> {
    const server = createServer((req, res) => {
      void serveStream(req, res, host, new StreamRegistry(), "session-a", id);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      return await new Promise((resolve, reject) => {
        const req = request({ port, host: "127.0.0.1", path: "/" }, (res) => {
          let buffer = "";
          const entries: { messages: Record<string, unknown>[] }[] = [];
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk;
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              if (!frame.includes("event: entry")) continue;
              const data = frame.split("\n").find((line) => line.startsWith("data: "));
              if (data !== undefined) entries.push(JSON.parse(data.slice(6)) as never);
            }
            if (entries.length >= count) {
              req.destroy();
              resolve(entries);
            }
          });
        });
        req.on("error", reject);
        req.end();
      });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it(
    "logs one line per call with its turn and number, and streams the usage",
    { timeout: 30_000 },
    async () => {
      const lines: Record<string, unknown>[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        for (const text of String(chunk).split("\n")) {
          if (text.includes('"event":"model-call"')) lines.push(JSON.parse(text) as never);
        }
        return true;
      });
      const host = await Host.open(
        new MemoryStorage(),
        config,
        (error) => {
          throw error;
        },
        () => Promise.resolve("session-a"),
      );
      hosts.push(host);
      const id = await host.createConversation({ provider: "scripted", model: "scripted-1" });
      // Turn 1: one tool call (to a tool that does not exist, so no sandbox is needed), then the answer.
      const script = JSON.stringify({
        steps: [{ tool: "no_such_tool", args: { secret: SECRET } }],
        final: `done ${SECRET}`,
      });
      await host.submitInput(id, { text: script, requestId: "turn-1", steer: false });
      await settle(host, id, "turn-1");
      // Turn 2: a plain message, answered by echo.
      await host.submitInput(id, { text: `again ${SECRET}`, requestId: "turn-2", steer: false });
      await settle(host, id, "turn-2");

      expect(lines.map((line) => [line.turn, line.seq, line.stopReason])).toEqual([
        ["turn-1", 1, "toolUse"],
        ["turn-1", 2, "stop"],
        ["turn-2", 1, "stop"],
      ]);
      for (const line of lines) {
        expect(line).toMatchObject({
          session: "session-a",
          conversation: id,
          model: "scripted-1",
          provider: "scripted",
          trimMoved: false,
        });
        expect(typeof line.cacheRead).toBe("number");
        expect(typeof line.ms).toBe("number");
        expect(JSON.stringify(line)).not.toContain(SECRET);
      }

      // user, call, result, answer, user, answer
      const entries = await streamEntries(host, id, 6);
      const assistants = entries
        .flatMap((entry) => entry.messages)
        .filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(3);
      assistants.forEach((message, index) => {
        const line = lines[index];
        expect(message.usage).toEqual({
          input: line?.input,
          output: line?.output,
          cacheRead: line?.cacheRead,
          cacheWrite: line?.cacheWrite,
          cost: line?.cost,
        });
      });
    },
  );
});
