import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  ToolResultEntry,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { Host } from "../src/host.ts";
import { loadConfig } from "../src/config.ts";
import {
  createTrimContextExtension,
  sessionContextTrim,
  TRIM_CONTEXT_DEFAULTS,
  trimMessages,
} from "../src/trim-context.ts";

const O = TRIM_CONTEXT_DEFAULTS;
const BIG = "x".repeat(10_000);
const IMG = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

function assistant(id: string, args: Record<string, string> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: args }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: {} as AssistantMessage["usage"],
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function result(
  id: string,
  content: ToolResultMessage["content"],
  isError = false,
): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "read", content, isError, timestamp: 1 };
}

/** `turns` turns of: assistant call, tool result with `make(i)` as content. */
function history(turns: number, make: (i: number) => ToolResultMessage["content"]): Message[] {
  const messages: Message[] = [user("task")];
  for (let i = 0; i < turns; i++) {
    messages.push(assistant(`c${String(i)}`, { path: `/shots/${String(i)}.png` }));
    messages.push(result(`c${String(i)}`, make(i)));
  }
  return messages;
}

const textOf = (message: Message | undefined): string =>
  message?.role === "toolResult"
    ? message.content.map((part) => (part.type === "text" ? part.text : "[img]")).join("|")
    : "";
const resultAt = (messages: readonly Message[], turn: number): Message | undefined =>
  messages.find((m) => m.role === "toolResult" && m.toolCallId === `c${String(turn)}`);
const imageCount = (messages: readonly Message[]): number =>
  messages.filter((m) => m.role === "toolResult" && m.content.some((p) => p.type === "image"))
    .length;

describe("trim-context rules (docs/decisions/0067-trim-context.md)", () => {
  it(
    "elides images of old tool results and keeps the last two, naming the path",
    { timeout: 5_000 },
    () => {
      // 30 turns, an image in each: eligible are the results of turns 0..20 (step 24 less the newest 3 turns -> 24).
      const messages = history(30, () => [IMG]);
      const out = trimMessages(messages, "full", O);
      expect(textOf(resultAt(out, 0))).toBe(
        "[image elided to save context: /shots/0.png; your note after it says what it showed; read it again if needed]",
      );
      // The last two image results of the eligible part (turns 0..22) stay, as do the newest seven turns.
      expect(imageCount(out)).toBe(2 + 7);
      expect(textOf(resultAt(out, 21))).toBe("[img]");
      expect(textOf(resultAt(out, 22))).toBe("[img]");
      expect(textOf(resultAt(out, 20))).toContain("elided");
      expect(textOf(resultAt(out, 29))).toBe("[img]");
    },
  );

  it("names an earlier screenshot when the call has no path", { timeout: 5_000 }, () => {
    const messages = history(30, () => [IMG]).map((m) =>
      m.role === "assistant" ? assistant((m.content[0] as { id: string }).id) : m,
    );
    expect(textOf(resultAt(trimMessages(messages, "full", O), 0))).toBe(
      "[image elided to save context: earlier screenshot; your note after it says what it showed; read it again if needed]",
    );
  });

  it(
    "elides a large text result older than the kept turns to its first 600 characters",
    { timeout: 5_000 },
    () => {
      const messages = history(30, (i) => [{ type: "text", text: `${String(i)}${BIG}` }]);
      const out = trimMessages(messages, "full", O);
      const old = textOf(resultAt(out, 0));
      expect(old.startsWith(`0${"x".repeat(599)}\n[... 9401 chars elided to save context;`)).toBe(
        true,
      );
      expect(old).toContain("rerun the command or re-read the file if needed]");
      expect(textOf(resultAt(out, 29))).toBe(`29${BIG}`);
      expect(textOf(resultAt(out, 27))).toBe(`27${BIG}`);
    },
  );

  it(
    "never touches system, user or assistant messages, short results, errors under the limit or the newest turns",
    { timeout: 5_000 },
    () => {
      const messages = history(40, (i) =>
        i % 2 === 0 ? [{ type: "text", text: "short" }] : [{ type: "text", text: BIG }],
      );
      messages.unshift({ role: "system", content: BIG } as unknown as Message);
      messages.splice(2, 1, { ...assistant("c0", { path: BIG }) });
      messages.push(result("c40", [{ type: "text", text: "boom" }], true));
      const out = trimMessages(messages, "full", O);
      expect(out[0]).toBe(messages[0]);
      expect(out[1]).toBe(messages[1]);
      for (const [index, message] of messages.entries()) {
        if (message.role !== "toolResult") expect(out[index]).toBe(message);
      }
      expect(textOf(resultAt(out, 2))).toBe("short");
      expect(textOf(out.at(-1))).toBe("boom");
      // The newest three turns (c37..c39) and the error stay whole.
      expect(textOf(resultAt(out, 39))).toBe(BIG);
      expect(textOf(resultAt(out, 37))).toBe(BIG);
    },
  );

  it(
    "keeps the order and the text of a result that holds both an image and a long text",
    { timeout: 5_000 },
    () => {
      const messages = history(30, () => [{ type: "text", text: BIG }, IMG]);
      const first = trimMessages(messages, "full", O)[2];
      expect(first?.role === "toolResult" && first.content.map((p) => p.type)).toEqual([
        "text",
        "text",
      ]);
    },
  );

  it("changes nothing in a short history, and returns the same array", { timeout: 5_000 }, () => {
    const messages = history(10, () => [IMG, { type: "text", text: BIG }]);
    expect(trimMessages(messages, "full", O)).toBe(messages);
  });

  it("is a deterministic function of its input", { timeout: 5_000 }, () => {
    const messages = history(33, (i) => (i % 2 ? [IMG] : [{ type: "text", text: BIG }]));
    expect(JSON.stringify(trimMessages(messages, "full", O))).toBe(
      JSON.stringify(trimMessages(messages, "full", O)),
    );
  });

  it("is idempotent: trimming trimmed messages changes nothing", { timeout: 5_000 }, () => {
    const messages = history(40, (i) =>
      i % 2 ? [IMG, { type: "text", text: "a".repeat(3_950) }] : [{ type: "text", text: BIG }],
    );
    const once = trimMessages(messages, "full", O);
    expect(once).not.toBe(messages);
    expect(JSON.stringify(trimMessages(once, "full", O))).toBe(JSON.stringify(once));
  });

  it("does not change the input messages", { timeout: 5_000 }, () => {
    const messages = history(30, () => [IMG, { type: "text", text: BIG }]);
    const before = JSON.stringify(messages);
    trimMessages(messages, "full", O);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it(
    "advances the boundary in steps, so the trimmed prefix is byte-identical between steps (prompt cache)",
    { timeout: 10_000 },
    () => {
      const make = (i: number): ToolResultMessage["content"] =>
        i % 3 === 0 ? [IMG] : [{ type: "text", text: `${String(i)}${BIG}` }];
      const full = history(80, make);
      // Messages are [user, (call, result) x n]: n turns are the first 1 + 2n messages.
      // For every history length n of a step, the messages before the step's boundary are the same bytes.
      for (const start of [11, 19, 27, 35]) {
        const ends = new Set<string>();
        for (let n = start; n < start + O.stepTurns; n++) {
          const turnsOld = Math.floor((n - O.turnsKept) / O.stepTurns) * O.stepTurns;
          ends.add(
            JSON.stringify(
              trimMessages(full.slice(0, 1 + 2 * n), "full", O).slice(0, 1 + 2 * turnsOld),
            ),
          );
        }
        expect(ends.size, `step starting at ${String(start)}`).toBe(1);
      }
      // And the boundary does move from one step to the next.
      const a = JSON.stringify(trimMessages(full.slice(0, 1 + 2 * 18), "full", O));
      const b = JSON.stringify(trimMessages(full.slice(0, 1 + 2 * 19), "full", O));
      expect(b).not.toBe(a);
    },
  );

  it("elides only images in images mode, and nothing in off mode", { timeout: 5_000 }, () => {
    const messages = history(30, (i) =>
      i % 2 === 0 ? [IMG] : [{ type: "text", text: `${String(i)}${BIG}` }],
    );
    const images = trimMessages(messages, "images", O);
    expect(textOf(resultAt(images, 0))).toContain("image elided");
    expect(textOf(resultAt(images, 1))).toBe(`1${BIG}`);
    expect(trimMessages(messages, "off", O)).toBe(messages);
  });

  it("honours other constants", { timeout: 5_000 }, () => {
    const messages = history(6, () => [IMG]);
    const out = trimMessages(messages, "full", { ...O, turnsKept: 1, stepTurns: 1, imageKeep: 1 });
    // Eligible: results of turns 0..3; the last of them (3) keeps its image; turns 4 and 5 are not eligible.
    expect(imageCount(out)).toBe(3);
    expect(textOf(resultAt(out, 3))).toBe("[img]");
    expect(textOf(resultAt(out, 2))).toContain("elided");
  });
});

describe("trim-context extension in a harness", () => {
  it(
    "sends the trimmed copy to the model and leaves the stored transcript whole",
    { timeout: 20_000 },
    async () => {
      const shot = defineTool<object>({
        name: "shot",
        description: "returns a big text",
        parameters: { type: "object", properties: {} },
        execute: () => Promise.resolve({ output: [{ type: "text", text: BIG }] }),
      });
      const faux = fauxProvider({ provider: "faux" });
      const seen: Message[][] = [];
      const reply = (final: boolean) => (request: { messages: readonly Message[] }) => {
        seen.push([...request.messages]);
        return final
          ? fauxAssistantMessage(fauxText("done"))
          : fauxAssistantMessage(fauxToolCall("shot", {}), { stopReason: "toolUse" });
      };
      faux.setResponses([reply(false), reply(false), reply(false), reply(false), reply(true)]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const tools = defineExtension({ name: "coding", tools: [shot] });
      const trim = createTrimContextExtension(
        { ...O, turnsKept: 1, stepTurns: 1, textMaxChars: 1_000 },
        () => Promise.resolve("full"),
      );
      registry.install(tools);
      registry.install(trim);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry, settings: { extensions: [tools, trim] } },
        context,
      );
      try {
        const root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        });
        const submission = await root.submit({ type: "input", content: "go" }, context);
        expect((await submission.wait(context)).status).toBe("done");

        // The last request saw the old results elided ...
        const last = seen.at(-1) ?? [];
        const results = last.filter((m) => m.role === "toolResult");
        expect(results).toHaveLength(4);
        expect(textOf(results[0])).toContain("chars elided to save context");
        expect(textOf(results[3])).toBe(BIG);
        // ... and the stored transcript holds every one in full.
        const view = await root.context(context);
        const stored = view.entries
          .filter((entry) => ToolResultEntry.is(entry))
          .flatMap((entry) => entry.model ?? []);
        expect(stored).toHaveLength(4);
        for (const message of stored) expect(textOf(message)).toBe(BIG);
      } finally {
        await harness.close(context);
      }
    },
  );
});

describe("trim-context configuration", () => {
  const env = {
    PI_ORCH_NAMESPACE: "test-ns",
    PI_ORCH_WARMPOOL: "test-pool",
    PI_ONECLI_GATEWAY: "http://gateway:10255",
    PI_ONECLI_API: "http://gateway-api:10256",
    PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
    PI_API_TOKENS: "alice:0123456789abcdef0123",
  };

  it("is on by default with the documented constants", { timeout: 5_000 }, () => {
    expect(loadConfig(env).trimContext).toEqual({ enabled: true, options: TRIM_CONTEXT_DEFAULTS });
    expect(TRIM_CONTEXT_DEFAULTS).toEqual({
      imageKeep: 2,
      textMaxChars: 4_000,
      turnsKept: 3,
      stepTurns: 8,
      textHeadChars: 600,
    });
  });

  it("is turned off by PI_TRIM_CONTEXT=0 and refuses other values", { timeout: 5_000 }, () => {
    expect(loadConfig({ ...env, PI_TRIM_CONTEXT: "0" }).trimContext.enabled).toBe(false);
    expect(loadConfig({ ...env, PI_TRIM_CONTEXT: "1" }).trimContext.enabled).toBe(true);
    expect(() => loadConfig({ ...env, PI_TRIM_CONTEXT: "off" })).toThrow(/PI_TRIM_CONTEXT/);
  });

  it("overrides each constant and refuses bad ones", { timeout: 5_000 }, () => {
    const config = loadConfig({
      ...env,
      PI_TRIM_CONTEXT_IMAGES: "4",
      PI_TRIM_CONTEXT_TEXT_CHARS: "8000",
      PI_TRIM_CONTEXT_TURNS: "5",
      PI_TRIM_CONTEXT_STEP: "16",
    });
    expect(config.trimContext.options).toMatchObject({
      imageKeep: 4,
      textMaxChars: 8_000,
      turnsKept: 5,
      stepTurns: 16,
    });
    for (const [name, bad] of [
      ["PI_TRIM_CONTEXT_IMAGES", "-1"],
      ["PI_TRIM_CONTEXT_TEXT_CHARS", "500"],
      ["PI_TRIM_CONTEXT_TURNS", "0"],
      ["PI_TRIM_CONTEXT_STEP", "1.5"],
    ] as const) {
      expect(() => loadConfig({ ...env, [name]: bad }), name).toThrow(new RegExp(name));
    }
  });
});

describe("the mode of a session", () => {
  const profile = (snapshot: unknown) => ({ name: "p", version: 1, snapshot });

  it("comes from the profile snapshot, else from the flavour", { timeout: 5_000 }, () => {
    // A coding (default flavour) profile that sets nothing gets images only.
    expect(sessionContextTrim({ profile: profile({}), sandboxFlavour: "default" })).toBe("images");
    expect(sessionContextTrim({ profile: null, sandboxFlavour: "default" })).toBe("images");
    expect(sessionContextTrim(undefined)).toBe("images");
    expect(sessionContextTrim({ profile: profile({}), sandboxFlavour: "browser" })).toBe("full");
    expect(sessionContextTrim({ profile: profile({}), sandboxFlavour: "desktop" })).toBe("full");
    expect(
      sessionContextTrim({ profile: profile({ contextTrim: "off" }), sandboxFlavour: "desktop" }),
    ).toBe("off");
    expect(
      sessionContextTrim({ profile: profile({ contextTrim: "full" }), sandboxFlavour: "default" }),
    ).toBe("full");
    // A snapshot that does not validate falls back to the flavour's default.
    expect(
      sessionContextTrim({ profile: profile({ contextTrim: "x" }), sandboxFlavour: "desktop" }),
    ).toBe("full");
  });

  it(
    "is asked once per conversation, and a failed lookup sends that request whole",
    { timeout: 20_000 },
    async () => {
      const shot = defineTool<object>({
        name: "shot",
        description: "returns a big text",
        parameters: { type: "object", properties: {} },
        execute: () => Promise.resolve({ output: [{ type: "text", text: BIG }] }),
      });
      const faux = fauxProvider({ provider: "faux" });
      const seen: Message[][] = [];
      const reply = (final: boolean) => (request: { messages: readonly Message[] }) => {
        seen.push([...request.messages]);
        return final
          ? fauxAssistantMessage(fauxText("done"))
          : fauxAssistantMessage(fauxToolCall("shot", {}), { stopReason: "toolUse" });
      };
      faux.setResponses([reply(false), reply(false), reply(false), reply(true)]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const tools = defineExtension({ name: "coding", tools: [shot] });
      let asked = 0;
      const trim = createTrimContextExtension(
        { ...O, turnsKept: 1, stepTurns: 1, textMaxChars: 1_000 },
        () => {
          asked += 1;
          // The first request cannot tell; later ones say `full`.
          return asked === 1 ? Promise.reject(new Error("db down")) : Promise.resolve("full");
        },
      );
      registry.install(tools);
      registry.install(trim);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry, settings: { extensions: [tools, trim] } },
        context,
      );
      try {
        const root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        });
        const submission = await root.submit({ type: "input", content: "go" }, context);
        expect((await submission.wait(context)).status).toBe("done");
        expect(asked).toBe(2);
        const results = (seen.at(-1) ?? []).filter((m) => m.role === "toolResult");
        expect(textOf(results[0])).toContain("chars elided to save context");
      } finally {
        await harness.close(context);
      }
    },
  );
});

describe("trim-context in the host", () => {
  const base = {
    PI_ORCH_NAMESPACE: "test-ns",
    PI_ORCH_WARMPOOL: "test-pool",
    PI_ONECLI_GATEWAY: "http://gateway:10255",
    PI_ONECLI_API: "http://gateway-api:10256",
    PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
    PI_API_TOKENS: "alice:0123456789abcdef0123",
  };

  async function extensionsOf(env: Record<string, string>): Promise<string[]> {
    const host = await Host.open(
      new MemoryStorage(),
      loadConfig({ ...base, ...env }),
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
    );
    try {
      return host.capabilities().extensions;
    } finally {
      await host.close();
    }
  }

  it(
    "is installed by default and left out with PI_TRIM_CONTEXT=0",
    { timeout: 20_000 },
    async () => {
      expect(await extensionsOf({})).toContain("trim-context");
      expect(await extensionsOf({ PI_TRIM_CONTEXT: "0" })).not.toContain("trim-context");
    },
  );
});
