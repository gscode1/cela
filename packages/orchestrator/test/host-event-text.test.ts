import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { toEvent } from "../src/host.ts";

describe("toEvent text", () => {
  it("leaves thinking blocks out of an assistant message's text", { timeout: 5_000 }, () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "let me consider" },
        { type: "text", text: "the answer" },
        { type: "toolCall", id: "c1", name: "bash", arguments: { cmd: "ls" } },
      ],
    } as unknown as Message;
    const event = toEvent(message);
    expect(event.text).toBe("the answer");
    expect(event.calls).toEqual(['bash({"cmd":"ls"})']);
  });
});
