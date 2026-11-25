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
  trimRequest,
} from "../src/trim-context.ts";

const O = TRIM_CONTEXT_DEFAULTS;
const BIG = "x".repeat(10_000);
/** Rule tests open the gate wide: any prompt counts and little has to be removed. */
const OPEN = 10_000;
const R = { ...TRIM_CONTEXT_DEFAULTS, minPrompt: 1_000, minRatio: 0.01 };
const IMG = { type: "image" as const, data: "AAAA", mimeType: "image/png" };

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });

/** The usage of a request whose prompt had `prompt` tokens, of which `cached` came from the cache. */
const usageOf = (prompt: number, cached = 0): AssistantMessage["usage"] => ({
  input: prompt - cached,
  output: 10,
  cacheRead: cached,
  cacheWrite: 0,
  totalTokens: prompt + 10,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function assistant(id: string, args: Record<string, string> = {}, prompt = OPEN): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "read", arguments: args }],
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: usageOf(prompt),
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
function history(
  turns: number,
  make: (i: number) => ToolResultMessage["content"],
  prompt: (i: number) => number = () => OPEN,
): Message[] {
  const messages: Message[] = [user("task")];
  for (let i = 0; i < turns; i++) {
    messages.push(assistant(`c${String(i)}`, { path: `/shots/${String(i)}.png` }, prompt(i)));
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
      // 30 turns, an image in each: eligible are the results of turns 0..26 (all but the newest 3 turns).
      const messages = history(30, () => [IMG]);
      const out = trimMessages(messages, "full", R);
      expect(textOf(resultAt(out, 0))).toBe(
        "[image elided to save context: /shots/0.png; your note after it says what it showed; read it again if needed]",
      );
      // The last two image results of the eligible part (turns 25 and 26) stay, as do the newest three turns.
      expect(imageCount(out)).toBe(2 + 3);
      expect(textOf(resultAt(out, 25))).toBe("[img]");
      expect(textOf(resultAt(out, 26))).toBe("[img]");
      expect(textOf(resultAt(out, 24))).toContain("elided");
      expect(textOf(resultAt(out, 29))).toBe("[img]");
    },
  );

  it("names an earlier screenshot when the call has no path", { timeout: 5_000 }, () => {
    const messages = history(30, () => [IMG]).map((m) =>
      m.role === "assistant" ? assistant((m.content[0] as { id: string }).id) : m,
    );
    expect(textOf(resultAt(trimMessages(messages, "full", R), 0))).toBe(
      "[image elided to save context: earlier screenshot; your note after it says what it showed; read it again if needed]",
    );
  });

  it(
    "elides a large text result older than the kept turns to its first 600 characters",
    { timeout: 5_000 },
    () => {
      const messages = history(30, (i) => [{ type: "text", text: `${String(i)}${BIG}` }]);
      const out = trimMessages(messages, "full", R);
      const old = textOf(resultAt(out, 0));
      expect(old.startsWith(`0${"x".repeat(599)}\n[... 9401 chars elided to save context;`)).toBe(
        true,
      );
      expect(old).toContain("rerun the command or re-read the file if needed]");
      expect(textOf(resultAt(out, 29))).toBe(`29${BIG}`);
      expect(textOf(resultAt(out, 27))).toBe(`27${BIG}`);
      expect(textOf(resultAt(out, 26))).toContain("chars elided");
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
      const out = trimMessages(messages, "full", R);
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
      const first = trimMessages(messages, "full", R)[2];
      expect(first?.role === "toolResult" && first.content.map((p) => p.type)).toEqual([
        "text",
        "text",
      ]);
    },
  );

  it("is a deterministic function of its input", { timeout: 5_000 }, () => {
    const messages = history(33, (i) => (i % 2 ? [IMG] : [{ type: "text", text: BIG }]));
    expect(JSON.stringify(trimMessages(messages, "full", R))).toBe(
      JSON.stringify(trimMessages(messages, "full", R)),
    );
  });

  it("is idempotent: trimming trimmed messages changes nothing", { timeout: 5_000 }, () => {
    const messages = history(40, (i) =>
      i % 2 ? [IMG, { type: "text", text: "a".repeat(3_950) }] : [{ type: "text", text: BIG }],
    );
    const once = trimMessages(messages, "full", R);
    expect(once).not.toBe(messages);
    expect(JSON.stringify(trimMessages(once, "full", R))).toBe(JSON.stringify(once));
  });

  it("does not change the input messages", { timeout: 5_000 }, () => {
    const messages = history(30, () => [IMG, { type: "text", text: BIG }]);
    const before = JSON.stringify(messages);
    trimMessages(messages, "full", R);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("elides only images in images mode, and nothing in off mode", { timeout: 5_000 }, () => {
    const messages = history(30, (i) =>
      i % 2 === 0 ? [IMG] : [{ type: "text", text: `${String(i)}${BIG}` }],
    );
    const images = trimMessages(messages, "images", R);
    expect(textOf(resultAt(images, 0))).toContain("image elided");
    expect(textOf(resultAt(images, 1))).toBe(`1${BIG}`);
    expect(trimMessages(messages, "off", R)).toBe(messages);
  });

  it("honours other constants", { timeout: 5_000 }, () => {
    const messages = history(6, () => [IMG]);
    const out = trimMessages(messages, "full", { ...R, turnsKept: 1, imageKeep: 1 });
    // Eligible: results of turns 0..4; the last of them (4) keeps its image; turn 5 is not eligible.
    expect(imageCount(out)).toBe(2);
    expect(textOf(resultAt(out, 4))).toBe("[img]");
    expect(textOf(resultAt(out, 3))).toContain("elided");
  });

  it("is idempotent when a trimmed history is trimmed again", { timeout: 5_000 }, () => {
    const messages = history(20, () => [IMG]);
    const once = trimMessages(messages, "images", R);
    expect(trimMessages(once, "images", R)).toBe(once);
  });
});

/** A history built like a real run: each assistant message records the prompt of the request it answered. */
function liveRun(
  turns: number,
  make: (i: number) => ToolResultMessage["content"],
  options: typeof R,
  mode: "images" | "full",
): Message[][] {
  const tokens = (m: Message): number =>
    m.role === "toolResult"
      ? m.content.reduce((sum, p) => sum + (p.type === "image" ? 1_000 : p.text.length / 4), 0)
      : 0;
  const messages: Message[] = [user("task")];
  const requests: Message[][] = [];
  for (let i = 0; i < turns; i++) {
    const request = [...trimMessages(messages, mode, options)];
    requests.push(request);
    const prompt = 500 + Math.round(request.reduce((sum, m) => sum + tokens(m), 0));
    messages.push(assistant(`c${String(i)}`, { path: `/shots/${String(i)}.png` }, prompt));
    messages.push(result(`c${String(i)}`, make(i)));
  }
  return requests;
}

describe("the gate (docs/decisions/0067-trim-context.md)", () => {
  it("is closed below minPrompt: the same array, even with many images", { timeout: 5_000 }, () => {
    const messages = history(
      60,
      () => [IMG],
      () => O.minPrompt - 1,
    );
    expect(trimMessages(messages, "full", O)).toBe(messages);
    expect(trimMessages(messages, "images", O)).toBe(messages);
  });

  it(
    "is closed when what a trim removes is under minRatio of the prompt",
    { timeout: 5_000 },
    () => {
      const gate = { ...R, minPrompt: 1_000, minRatio: 0.5 };
      // 30 images: about 25 elidable = 25k tokens, against a prompt of 100k (needs 50k).
      const heavy = history(
        30,
        () => [IMG],
        () => 100_000,
      );
      expect(trimMessages(heavy, "images", gate)).toBe(heavy);
      // The same history with a prompt of 40k (needs 20k) opens it.
      const light = history(
        30,
        () => [IMG],
        () => 40_000,
      );
      expect(trimMessages(light, "images", gate)).not.toBe(light);
    },
  );

  it("opens once and trims everything eligible at that point", { timeout: 5_000 }, () => {
    const gate = { ...R, minPrompt: 20_000, minRatio: 0.5 };
    // The prompt is small until turn 20, then 24k: at the request after turn 20 the old results (turns 0..17)
    // hold 16 elidable images = 16k >= 12k. Later requests would remove about 1k more: under the ratio, no new jump.
    const messages = history(
      30,
      () => [IMG],
      (i) => (i < 20 ? 2_000 : 24_000),
    );
    const out = trimMessages(messages, "images", gate);
    for (let i = 0; i <= 15; i++)
      expect(textOf(resultAt(out, i)), `turn ${String(i)}`).toContain("elided");
    // Turns 16 and 17 keep their image (last two of the eligible), later turns are not eligible.
    expect(imageCount(out)).toBe(14);
    expect(textOf(resultAt(out, 17))).toBe("[img]");
    expect(textOf(resultAt(out, 18))).toBe("[img]");
  });

  it("reports a move only at the request whose boundary jumped", { timeout: 5_000 }, () => {
    const gate = { ...R, minPrompt: 20_000, minRatio: 0.5 };
    const messages = history(
      30,
      () => [IMG],
      (i) => (i < 20 ? 2_000 : 24_000),
    );
    // The request carrying `k` assistant messages: the user message and `k` (call, result) pairs.
    const request = (k: number): readonly Message[] => messages.slice(0, 1 + 2 * k);
    const moved = (k: number): boolean => trimRequest(request(k), "images", gate).moved;
    expect(moved(20)).toBe(false);
    expect(moved(21)).toBe(true); // the first request that sees the 24k prompt of turn 20
    expect(moved(22)).toBe(false); // same boundary: the trimmed prefix is the same bytes again
    expect(moved(30)).toBe(false);
    expect(trimRequest(request(21), "off", gate).moved).toBe(false);
    expect(trimRequest(request(21), "images", gate).messages).toEqual(
      trimMessages(request(21), "images", gate),
    );
  });

  it("sums input, cacheRead and cacheWrite as the prompt", { timeout: 5_000 }, () => {
    const gate = { ...R, minPrompt: 20_000, minRatio: 0.01 };
    const make = (cached: boolean): Message[] =>
      history(30, () => [IMG]).map((m) =>
        m.role === "assistant"
          ? {
              ...m,
              usage: cached ? { ...usageOf(30_000, 29_000), cacheWrite: 500 } : usageOf(1_000),
            }
          : m,
      );
    const open = make(true);
    expect(trimMessages(open, "images", gate)).not.toBe(open);
    const small = make(false);
    expect(trimMessages(small, "images", gate)).toBe(small);
  });

  it(
    "keeps the trimmed prefix byte-identical between trims and trims again only when the prompt has grown back",
    { timeout: 20_000 },
    () => {
      const gate = { ...R, minPrompt: 50_000, minRatio: 0.5 };
      const requests = liveRun(
        80,
        (i) => [{ type: "text", text: `${String(i)}${"y".repeat(40_000)}` }],
        gate,
        "full",
      );
      const trims: number[] = [];
      for (let n = 1; n < requests.length; n++) {
        const previous = requests[n - 1] ?? [];
        const next = requests[n] ?? [];
        const same = JSON.stringify(next.slice(0, previous.length)) === JSON.stringify(previous);
        if (!same) trims.push(n);
      }
      // Several trims over the run, never on two requests in a row (the prompt must grow back first).
      expect(trims.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < trims.length; i++)
        expect((trims[i] ?? 0) - (trims[i - 1] ?? 0)).toBeGreaterThan(1);
      // Before the first trim nothing was touched at all.
      const first = trims[0] ?? 0;
      for (let n = 0; n < first; n++)
        expect(requests[n]?.some((m) => textOf(m).includes("elided"))).toBe(false);
    },
  );

  it(
    "never trims a run shaped like the measured one with the defaults",
    { timeout: 10_000 },
    () => {
      // 30 requests, prompts 1.4k -> 21k, 13 screenshots and a few large text results.
      const make = (i: number): ToolResultMessage["content"] =>
        i % 2 === 0 && i < 26
          ? [IMG]
          : i % 7 === 3
            ? [{ type: "text", text: BIG }]
            : [{ type: "text", text: "ok" }];
      const prompt = (i: number): number => Math.round(1_400 + (i * (21_000 - 1_400)) / 29);
      const messages = history(30, make, prompt);
      expect(imageCount(messages)).toBe(13);
      for (let n = 1; n <= 30; n++) {
        const prefix = messages.slice(0, 1 + 2 * n);
        expect(trimMessages(prefix, "full", O)).toBe(prefix);
      }
    },
  );
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
      const trim = createTrimContextExtension({ ...R, turnsKept: 1, textMaxChars: 1_000 }, () =>
        Promise.resolve("full"),
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
      minPrompt: 100_000,
      minRatio: 0.5,
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
      PI_TRIM_CONTEXT_MIN_PROMPT: "50000",
      PI_TRIM_CONTEXT_MIN_RATIO: "0.25",
    });
    expect(config.trimContext.options).toMatchObject({
      imageKeep: 4,
      textMaxChars: 8_000,
      turnsKept: 5,
      minPrompt: 50_000,
      minRatio: 0.25,
    });
    for (const [name, bad] of [
      ["PI_TRIM_CONTEXT_IMAGES", "-1"],
      ["PI_TRIM_CONTEXT_TEXT_CHARS", "500"],
      ["PI_TRIM_CONTEXT_TURNS", "0"],
      ["PI_TRIM_CONTEXT_MIN_PROMPT", "999"],
      ["PI_TRIM_CONTEXT_MIN_PROMPT", "1.5"],
      ["PI_TRIM_CONTEXT_MIN_RATIO", "0"],
      ["PI_TRIM_CONTEXT_MIN_RATIO", "1.5"],
      ["PI_TRIM_CONTEXT_MIN_RATIO", "abc"],
    ] as const) {
      expect(() => loadConfig({ ...env, [name]: bad }), name).toThrow(new RegExp(name));
    }
  });
});

describe("the mode of a session", () => {
  const profile = (snapshot: unknown) => ({ name: "p", version: 1, snapshot });

  it("comes from the profile snapshot, else images for every flavour", { timeout: 5_000 }, () => {
    expect(sessionContextTrim({ profile: profile({}) })).toBe("images");
    expect(sessionContextTrim({ profile: null })).toBe("images");
    expect(sessionContextTrim(undefined)).toBe("images");
    expect(sessionContextTrim({ profile: profile({ contextTrim: "off" }) })).toBe("off");
    expect(sessionContextTrim({ profile: profile({ contextTrim: "full" }) })).toBe("full");
    // A snapshot that does not validate falls back to images.
    expect(sessionContextTrim({ profile: profile({ contextTrim: "x" }) })).toBe("images");
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
      const trim = createTrimContextExtension({ ...R, turnsKept: 1, textMaxChars: 1_000 }, () => {
        asked += 1;
        // The first request cannot tell; later ones say `full`.
        return asked === 1 ? Promise.reject(new Error("db down")) : Promise.resolve("full");
      });
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
