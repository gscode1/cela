import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { McpTools, parseMcpServers } from "../src/mcp.ts";
import type { McpServerSpec, McpTimings } from "../src/mcp.ts";
import { FakeMcp } from "./fake-mcp.ts";

const SPEC: McpServerSpec = { name: "demo", url: "https://mcp.example.com/mcp" };
const TIMINGS: McpTimings = {
  discoveryTimeoutMs: 200,
  retryMinMs: 10,
  retryMaxMs: 40,
  callTimeoutMs: 300,
};
const ECHO = {
  name: "echo",
  description: "Echo the text back",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("PI_MCP_SERVERS", () => {
  it("is off when unset or empty", () => {
    expect(parseMcpServers(undefined)).toEqual([]);
    expect(parseMcpServers("")).toEqual([]);
    expect(parseMcpServers("[]")).toEqual([]);
  });

  it("parses name and https url", () => {
    expect(parseMcpServers(JSON.stringify([SPEC]))).toEqual([SPEC]);
  });

  it.each([
    ["not json", "{"],
    ["not an array", "{}"],
    ["http url", JSON.stringify([{ name: "a", url: "http://mcp.example.com/mcp" }])],
    ["no url", JSON.stringify([{ name: "a" }])],
    ["url with credentials", JSON.stringify([{ name: "a", url: "https://u:p@mcp.example.com/" }])],
    ["uppercase name", JSON.stringify([{ name: "Deep", url: SPEC.url }])],
    ["name with underscore", JSON.stringify([{ name: "a_b", url: SPEC.url }])],
    ["name over 32 characters", JSON.stringify([{ name: "a".repeat(33), url: SPEC.url }])],
    [
      "names sharing a namespace",
      JSON.stringify([
        { name: "a-b", url: SPEC.url },
        { name: "a-b", url: SPEC.url },
      ]),
    ],
  ])("rejects %s, so a typo never silently turns the feature off", (_label, raw) => {
    expect(() => parseMcpServers(raw)).toThrow(/PI_MCP_SERVERS/);
  });

  it("needs the gateway token: MCP calls never leave the cluster any other way", () => {
    const env = {
      PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
      PI_API_TOKENS: "alice:0123456789abcdef0123",
      PI_MCP_SERVERS: JSON.stringify([SPEC]),
    };
    expect(() => loadConfig(env)).toThrow(/ONECLI_AGENT_TOKEN is required for PI_MCP_SERVERS/);
    expect(
      loadConfig({ ...env, ONECLI_AGENT_TOKEN: "aoc_0123456789abcdef0123456789abcdef" }).mcpServers,
    ).toEqual([SPEC]);
  });
});

describe("McpTools", () => {
  const started: McpTools[] = [];
  afterEach(async () => {
    for (const tools of started.splice(0)) await tools.close();
  });

  function open(fake: FakeMcp, timings: McpTimings = TIMINGS) {
    const registry = createRegistry();
    const tools = new McpTools([SPEC], registry, fake.transport, timings);
    started.push(tools);
    tools.start();
    return { registry, tools };
  }

  async function ready(tools: McpTools): Promise<ToolRegistration> {
    await until(() => (tools.servers[0]?.extension.tools?.length ?? 0) > 0, "tool discovery");
    const tool = tools.servers[0]?.extension.tools?.[0];
    if (tool === undefined) throw new Error("no tool");
    return tool;
  }

  function run(tool: ToolRegistration, args: object, signal?: AbortSignal) {
    // The fake api is never read: an MCP call touches neither the sandbox nor the transcript.
    return tool.execute(
      args,
      {} as never,
      signal === undefined ? context : withAbortSignal(signal, context),
    );
  }

  it("maps an MCP tool to a deferred, replay-unsafe, output-limited Pi tool named mcp__<server>__<tool>", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO, { name: "no-schema", inputSchema: {} }];
    const { tools } = open(fake);
    await ready(tools);
    const [echo, bare] = tools.servers[0]?.extension.tools ?? [];
    expect(tools.servers[0]?.extension.name).toBe("mcp-demo");
    expect(echo).toMatchObject({
      name: "mcp__demo__echo",
      description: "Echo the text back",
      deferred: true,
      replay: "unsafe",
      parameters: ECHO.inputSchema,
    });
    expect(echo?.outputLimits?.maxBytes).toBeGreaterThan(0);
    // A schema without `type` or `properties` is normalised: providers reject it otherwise.
    expect(bare?.parameters).toEqual({ type: "object", properties: {} });
    expect(bare?.name).toBe("mcp__demo__no_schema");
  });

  it("calls the server's own tool name with the arguments and returns its text", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = (_name, args) =>
      Promise.resolve({ content: [{ type: "text", text: `you said ${String(args.text)}` }] });
    const { tools } = open(fake);
    const result = await run(await ready(tools), { text: "hi" });
    expect(fake.calls).toEqual([{ name: "echo", args: { text: "hi" } }]);
    expect(result).toMatchObject({
      output: [{ type: "text", text: "you said hi" }],
      isError: false,
    });
  });

  it("turns isError into an error result the model can read", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () =>
      Promise.resolve({ isError: true, content: [{ type: "text", text: "quota exceeded" }] });
    const { tools } = open(fake);
    expect(await run(await ready(tools), {})).toMatchObject({
      isError: true,
      output: [{ type: "text", text: "quota exceeded" }],
    });
  });

  it("cuts a huge result to a bounded text", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () => Promise.resolve({ content: [{ type: "text", text: "x".repeat(500_000) }] });
    const { tools } = open(fake);
    const tool = await ready(tools);
    const result = await run(tool, {});
    const text = (result.output ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    expect(text.length).toBeGreaterThan(1000);
    expect(text.length).toBeLessThan(tool.outputLimits?.maxBytes ?? 0);
  });

  it("fails a call that the server never answers, after the timeout", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () => new Promise(() => undefined);
    const { tools } = open(fake, { ...TIMINGS, callTimeoutMs: 60 });
    await expect(run(await ready(tools), {})).rejects.toThrow(/timed out/i);
  });

  it("stops a call when the conversation aborts it, and tells the server", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () => new Promise(() => undefined);
    const { tools } = open(fake, { ...TIMINGS, callTimeoutMs: 10_000 });
    const tool = await ready(tools);
    const controller = new AbortController();
    const running = run(tool, {}, controller.signal);
    await until(() => fake.calls.length === 1, "the call to arrive");
    controller.abort();
    await expect(running).rejects.toThrow();
    await until(() => fake.cancelled.length === 1, "the cancel notification");
  });

  it("connects again once when the server dropped the session, and does not loop", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const { tools } = open(fake);
    const tool = await ready(tools);
    const connects = fake.connects;
    fake.expireNextCall = true;
    expect(await run(tool, {})).toMatchObject({ isError: false });
    expect(fake.connects).toBe(connects + 1);
    expect(fake.calls).toHaveLength(1);
  });

  it("installs an empty extension at once, and its tools when a down server comes back", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.down = true;
    const { registry, tools } = open(fake);
    expect(
      registry
        .snapshot()
        .installed()
        .map((e) => e.name),
    ).toEqual(["mcp-demo"]);
    await until(() => fake.connects >= 3, "retries");
    expect(tools.servers[0]?.extension.tools).toHaveLength(0);
    fake.down = false;
    await ready(tools);
    // The registry holds the new extension, which is what a running Harness resolves tools from.
    expect(
      registry
        .snapshot()
        .installed()[0]
        ?.tools?.map((t) => t.name),
    ).toEqual(["mcp__demo__echo"]);
  });

  it("does nothing without servers", () => {
    const registry = createRegistry();
    const tools = new McpTools([], registry, new FakeMcp().transport);
    tools.start();
    expect(registry.snapshot().installed()).toEqual([]);
  });
});

describe("Host with MCP", () => {
  const dirs: string[] = [];
  const hosts: Host[] = [];
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function configWith(servers: McpServerSpec[]) {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-"));
    dirs.push(dir);
    const caFile = join(dir, "ca.pem");
    await writeFile(caFile, "not-used");
    return {
      dir,
      config: loadConfig({
        PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
        PI_API_TOKENS: "alice:0123456789abcdef0123",
        ...(servers.length === 0
          ? {}
          : {
              PI_MCP_SERVERS: JSON.stringify(servers),
              ONECLI_AGENT_TOKEN: "aoc_0123456789abcdef0123456789abcdef",
              PI_ONECLI_CA_FILE: caFile,
            }),
      }),
    };
  }

  async function openHost(
    config: Awaited<ReturnType<typeof configWith>>["config"],
    fake: FakeMcp,
    storage: Storage = new MemoryStorage(),
    execInFlight = vi.fn(() => Promise.resolve()),
  ): Promise<Host> {
    const host = await Host.open(
      storage,
      config,
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      { execInFlight },
      [],
      { mcpTransport: fake.transport, mcpTimings: TIMINGS },
    );
    hosts.push(host);
    return host;
  }

  const MODEL = { provider: "scripted", model: "scripted-1" } as const;

  async function runScript(host: Host, id: number, steps: object[], requestId: string) {
    await host.submitInput(id, {
      text: JSON.stringify({ steps, final: "finished" }),
      requestId,
      steer: false,
    });
    await until(async () => (await host.status(id))?.state === "done", "the script to finish");
    return (await host.status(id))?.results ?? [];
  }

  it("flag off: no tool_search, no MCP extension, the offered tools are exactly the coding tools", async () => {
    const { config } = await configWith([]);
    const fake = new FakeMcp();
    const host = await openHost(config, fake);
    const id = await host.createConversation(MODEL);
    expect(await host.toolsOf(id)).toEqual({
      offered: ["read", "write", "edit", "bash"],
      deferred: [],
    });
    expect(fake.connects).toBe(0);
  });

  it("flag on: a server that is down does not block open; the call settles tool_unavailable; recovery installs the tools", async () => {
    const { config } = await configWith([SPEC]);
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = (_n, args) =>
      Promise.resolve({ content: [{ type: "text", text: `echo ${String(args.text)}` }] });
    fake.down = true;
    const execInFlight = vi.fn(() => Promise.resolve());
    const host = await openHost(config, fake, new MemoryStorage(), execInFlight);
    const id = await host.createConversation(MODEL);
    const before = await host.toolsOf(id);
    expect(before.offered).toContain("tool_search");
    expect(before.deferred).toEqual([]);

    const down = await runScript(
      host,
      id,
      [{ tool: "mcp__demo__echo", args: { text: "x" } }],
      "down",
    );
    expect(down).toHaveLength(1);
    expect(down[0]?.isError).toBe(true);
    expect(down[0]?.text).toMatch(/not available/);

    fake.down = false;
    await until(async () => (await host.toolsOf(id)).deferred.includes("mcp__demo__echo"), "tools");
    const found = await runScript(
      host,
      id,
      [
        { tool: "tool_search", args: { query: "echo" } },
        { tool: "mcp__demo__echo", args: { text: "hello" } },
      ],
      "up",
    );
    // The script's steps are counted from the newest user message, so only the last two results are this run's.
    const [search, echo] = found.slice(-2);
    expect(search?.isError).toBe(false);
    expect(search?.text).toContain("mcp__demo__echo");
    expect(echo).toEqual({ isError: false, text: "echo hello" });
    // ADR 0003: an MCP call is not a sandbox command, so it never marks the sandbox as running one.
    expect(execInFlight).not.toHaveBeenCalled();
  });

  it("flag on: a conversation created before the flag does not gain MCP; a new one does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-store-"));
    dirs.push(dir);
    const off = await openHost(
      (await configWith([])).config,
      new FakeMcp(),
      await openNodeJsonlStorage(dir, context),
    );
    const old = await off.createConversation(MODEL);
    await off.close();
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const on = await openHost(
      (await configWith([SPEC])).config,
      fake,
      await openNodeJsonlStorage(dir, context),
    );
    await until(
      async () => (await on.toolsOf(await on.createConversation(MODEL))).deferred.length > 0,
      "tools",
    );
    expect((await on.toolsOf(old)).offered).not.toContain("tool_search");
    expect((await on.toolsOf(old)).deferred).toEqual([]);
  });
});
