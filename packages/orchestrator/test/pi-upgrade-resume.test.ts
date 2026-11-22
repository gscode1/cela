import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";

// Storage that Pi Durable 1.5.2 wrote and was killed in the middle of a tool call (ADR 0053). See the fixture README.
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi-1.5.2-mid-tool");
const CONVERSATION = 2;

const config = loadConfig({
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
});

const hosts: Host[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("upgrade from Pi Durable 1.5.2", () => {
  it("has the fixture a 1.5.2 Harness wrote (tool v3, generation v2)", async () => {
    const tool = await readFile(join(FIXTURE, "task-13.jsonl"), "utf8");
    const generation = await readFile(join(FIXTURE, "task-10.jsonl"), "utf8");
    expect(tool).toContain('"kind":"pi.tool","version":3');
    expect(generation).toContain('"kind":"pi.generation","version":2');
  });

  it("resumes a run killed mid-tool-call, settles it, and keeps taking input", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dir = await mkdtemp(join(tmpdir(), "pi-upgrade-"));
    dirs.push(dir);
    await cp(FIXTURE, dir, { recursive: true });

    let runs = 0;
    const hold = defineTool<object>({
      name: "hold",
      description: "returns at once",
      parameters: { type: "object", properties: {} },
      execute: () => {
        runs += 1;
        return Promise.resolve({ output: [{ type: "text", text: "ok" }] });
      },
    });
    const host = await Host.open(
      await openNodeJsonlStorage(dir, context),
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      {},
      [],
      { codingExtension: defineExtension({ name: "coding", tools: [hold] }) },
    );
    hosts.push(host);

    // Nothing is submitted here: the open tool task and the unsettled input r1 are the 1.5.2 state.
    expect(await host.settlement(CONVERSATION, "r1")).toEqual({ status: "done" });
    // The tool was running with replay "unsafe" when the process died, so it is not run again: the run goes on from
    // an `interrupted` tool result, as after any crash in a tool, and the model answers.
    expect(runs).toBe(0);
    expect(await host.modelOf(CONVERSATION)).toEqual({ provider: "scripted", model: "scripted-1" });

    // The upgraded Harness keeps taking input on the same conversation.
    await host.submitInput(CONVERSATION, { text: "again", requestId: "r2", steer: false });
    expect(await host.settlement(CONVERSATION, "r2")).toEqual({ status: "done" });

    await host.close();
    const log = await readFile(join(dir, "main.jsonl"), "utf8");
    expect(log).toContain('"code":"interrupted"');
    // Tasks the new Harness wrote are the new versions; the old ones were only read.
    expect(log).toContain('"kind":"pi.tool","version":4');
    expect(log).toContain('"kind":"pi.generation","version":3');
  }, 15_000);
});
