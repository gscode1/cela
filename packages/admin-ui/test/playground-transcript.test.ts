import { describe, expect, it } from "vitest";
import {
  applyEntry,
  EMPTY_TRANSCRIPT,
  mcpToolParts,
  parseCall,
  parseEntry,
  parseLive,
  profileForMcp,
} from "@/lib/playground";
import type { WireEntry } from "@/lib/playground";

describe("parseCall", () => {
  it("splits the name from the arguments and pretty-prints JSON", () => {
    expect(parseCall('mcp__demo__echo({"text":"hi"})')).toEqual({
      name: "mcp__demo__echo",
      args: '{\n  "text": "hi"\n}',
    });
  });

  it("keeps arguments that are not JSON, and a text with no parentheses", () => {
    expect(parseCall("bash(ls -la)")).toEqual({ name: "bash", args: "ls -la" });
    expect(parseCall("odd")).toEqual({ name: "odd", args: "" });
  });
});

describe("mcpToolParts", () => {
  it("names the server and tool of an MCP tool, and nothing for the others", () => {
    expect(mcpToolParts("mcp__demo-server__list_items")).toEqual({
      server: "demo-server",
      tool: "list_items",
    });
    expect(mcpToolParts("bash")).toBeUndefined();
    expect(mcpToolParts("tool_search")).toBeUndefined();
  });
});

const entry = (id: number, messages: WireEntry["messages"]): WireEntry => ({
  id,
  kind: "message",
  messages,
});

describe("applyEntry", () => {
  it("pairs results with calls in order, and leaves a call without a result pending", () => {
    let t = applyEntry(EMPTY_TRANSCRIPT, entry(1, [{ role: "user", text: "go" }]));
    t = applyEntry(
      t,
      entry(2, [{ role: "assistant", text: "", calls: ['read({"path":"a"})', "bash(ls)"] }]),
    );
    t = applyEntry(t, entry(3, [{ role: "toolResult", text: "A", isError: false }]));
    const tools = t.items.flatMap((item) => (item.type === "tool" ? [item] : []));
    expect(tools.map((tool) => [tool.name, tool.result?.text])).toEqual([
      ["read", "A"],
      ["bash", undefined],
    ]);
    t = applyEntry(t, entry(4, [{ role: "toolResult", text: "boom", isError: true }]));
    expect(t.items.at(-1)).toMatchObject({ type: "tool", name: "bash", result: { isError: true } });
  });

  it("ignores an entry it has seen, so a replay after a reconnect adds nothing", () => {
    const first = applyEntry(EMPTY_TRANSCRIPT, entry(5, [{ role: "user", text: "a" }]));
    expect(applyEntry(first, entry(5, [{ role: "user", text: "a" }]))).toBe(first);
    expect(applyEntry(first, entry(4, [{ role: "user", text: "older" }]))).toBe(first);
  });

  it("keeps assistant text and calls of one message, and shows an unknown role as text", () => {
    const t = applyEntry(
      EMPTY_TRANSCRIPT,
      entry(1, [
        { role: "assistant", text: "checking", calls: ["x()"] },
        { role: "weird", text: "?" },
      ]),
    );
    expect(t.items.map((item) => item.type)).toEqual(["assistant", "tool", "other"]);
  });

  it("shows a result with no call as plain text rather than dropping it", () => {
    const t = applyEntry(EMPTY_TRANSCRIPT, entry(1, [{ role: "toolResult", text: "orphan" }]));
    expect(t.items).toEqual([{ type: "other", key: "1.0", role: "toolResult", text: "orphan" }]);
  });
});

describe("stream payloads", () => {
  it("parses an entry, taking the id from the data or else the SSE id", () => {
    expect(
      parseEntry('{"id":2,"kind":"x","messages":[{"role":"user","text":"hi"}]}', undefined),
    ).toEqual({ id: 2, kind: "x", messages: [{ role: "user", text: "hi" }] });
    expect(parseEntry('{"messages":[]}', "9")?.id).toBe(9);
  });

  it("skips what is not the documented shape", () => {
    expect(parseEntry("nope", "1")).toBeUndefined();
    expect(parseEntry('{"messages":[{"text":"no role"}]}', "1")).toBeUndefined();
    expect(parseEntry('{"messages":[]}', undefined)).toBeUndefined();
    expect(parseLive("[]")).toBeUndefined();
  });

  it("parses the live state", () => {
    expect(
      parseLive(
        '{"running":true,"queued":2,"partial":"he","tools":[{"callId":"c","name":"bash","status":"running"}],"runFailure":"aborted"}',
      ),
    ).toEqual({
      running: true,
      queued: 2,
      partial: "he",
      tools: [{ callId: "c", name: "bash", status: "running" }],
      runFailure: "aborted",
    });
  });
});

describe("profileForMcp", () => {
  const profiles = [
    { name: "coding", enabledForNew: true, mcpServers: [] },
    { name: "old", enabledForNew: false, mcpServers: ["demo"] },
    { name: "research", enabledForNew: true, mcpServers: ["demo"] },
  ];
  it("picks the first profile open to new sessions that names the server", () => {
    expect(profileForMcp(profiles, "demo")).toBe("research");
    expect(profileForMcp(profiles, "other")).toBeUndefined();
  });
});
