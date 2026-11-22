import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Message, UserMessage } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, UserEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  createCurrentDateExtension,
  dateBlock,
  isDateBlock,
  stampDates,
} from "../src/current-date.ts";
import { scriptedReply } from "../src/model.ts";

const NOV_22 = Date.UTC(2026, 10, 22, 16, 46);
const NOV_23 = Date.UTC(2026, 10, 23, 0, 5);

const user = (content: UserMessage["content"], timestamp: number): UserMessage => ({
  role: "user",
  content,
  timestamp,
});

describe("the current date in every request (docs/decisions/0057-current-date.md)", () => {
  it(
    "puts the UTC date a message was sent in front of it, as its own block",
    { timeout: 5_000 },
    () => {
      const [stamped] = stampDates([user("hello", NOV_22)]);
      expect(stamped).toMatchObject({
        role: "user",
        content: [
          { type: "text", text: "<current_date>2026-11-22 (UTC)</current_date>" },
          { type: "text", text: "hello" },
        ],
      });
      expect(isDateBlock(dateBlock(NOV_23))).toBe(true);
      expect(isDateBlock("hello <current_date>2026-11-22 (UTC)</current_date>")).toBe(false);
    },
  );

  it(
    "depends only on the stored messages, so repeated requests send the same bytes",
    { timeout: 5_000 },
    () => {
      const messages = [
        user("first", NOV_22),
        { role: "assistant", content: [{ type: "text", text: "ok" }] } as unknown as Message,
        user([{ type: "text", text: "second" }], NOV_23),
      ];
      const once = JSON.stringify(stampDates(messages));
      expect(JSON.stringify(stampDates(messages))).toBe(once);
      expect(once).toContain("2026-11-22 (UTC)");
      expect(once).toContain("2026-11-23 (UTC)");
      // Only user messages; the input is not changed.
      expect(stampDates(messages)[1]).toBe(messages[1]);
      expect(messages[0]).toMatchObject({ content: "first" });
    },
  );

  it("leaves a message without a usable timestamp as it is", { timeout: 5_000 }, () => {
    const message = user("old", 0);
    expect(stampDates([message])[0]).toBe(message);
  });

  it("keeps a script readable to the scripted model", { timeout: 5_000 }, () => {
    const [stamped] = stampDates([user('{"steps":[],"final":"done"}', NOV_22)]);
    type Args = Parameters<typeof scriptedReply>;
    // The script reader uses only the messages.
    const reply = scriptedReply(
      { messages: [stamped as Message] } as Args[0],
      undefined,
      {} as Args[2],
      {} as Args[3],
    );
    expect(JSON.stringify(reply)).toContain('"done"');
  });

  it(
    "reaches the model through the harness without changing the stored transcript",
    { timeout: 10_000 },
    async () => {
      const seen: Message[][] = [];
      const faux = fauxProvider({ provider: "faux" });
      faux.setResponses([
        (request) => {
          seen.push([...request.messages]);
          return fauxAssistantMessage(fauxText("hi"));
        },
      ]);
      const models = createModels();
      models.setProvider(faux.provider);
      const registry = createRegistry();
      const currentDate = createCurrentDateExtension();
      registry.install(currentDate);
      const harness = await Harness.open(
        new MemoryStorage(),
        { models, registry, now: () => NOV_22, settings: { extensions: [currentDate] } },
        context,
      );
      try {
        const root = await harness.root(context, {
          agent: { model: { provider: "faux", modelId: "faux-1" } },
        });
        const submission = await root.submit({ type: "input", content: "hello" }, context);
        expect((await submission.wait(context)).status).toBe("done");

        const sent = seen[0]?.find((message) => message.role === "user");
        expect(sent?.content).toEqual([
          { type: "text", text: "<current_date>2026-11-22 (UTC)</current_date>" },
          { type: "text", text: "hello" },
        ]);
        const view = await root.context(context);
        const stored = view.entries
          .filter((entry) => UserEntry.is(entry))
          .flatMap((entry) => entry.model ?? []);
        expect(stored).toMatchObject([{ role: "user", content: "hello" }]);
      } finally {
        await harness.close(context);
      }
    },
  );
});
