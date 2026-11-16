import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createRegistry, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { Storage, ToolRegistration } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import { loadConfig } from "../src/config.ts";
import { Host } from "../src/host.ts";
import { McpTools } from "../src/mcp.ts";
import type { McpServerSpec, McpTimings, McpTransportFactory } from "../src/mcp.ts";
import { FakeMcp } from "./fake-mcp.ts";

const SPEC: McpServerSpec = {
  name: "demo",
  url: "https://mcp.example.com/mcp",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 300,
  maxOutputBytes: 24_576,
  onecliSecret: null,
};
const TIMINGS: McpTimings = {
  discoveryTimeoutMs: 200,
  retryMinMs: 10,
  retryMaxMs: 40,
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

describe("McpTools", () => {
  const started: McpTools[] = [];
  afterEach(async () => {
    for (const tools of started.splice(0)) await tools.close();
  });

  function open(fake: FakeMcp, spec: Partial<McpServerSpec> = {}, timings: McpTimings = TIMINGS) {
    const registry = createRegistry();
    const tools = new McpTools(registry, fake.transport, timings);
    started.push(tools);
    tools.apply([{ ...SPEC, ...spec }]);
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
    expect(echo?.outputLimits?.maxBytes).toBe(24_576);
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
    const { tools } = open(fake, { timeoutMs: 60 });
    await expect(run(await ready(tools), {})).rejects.toThrow(/timed out/i);
  });

  it("stops a call when the conversation aborts it, and tells the server", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () => new Promise(() => undefined);
    const { tools } = open(fake, { timeoutMs: 10_000 });
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

  it("shares one connect among concurrent calls after a drop, and close() closes it", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const { tools } = open(fake);
    const tool = await ready(tools);
    expect(fake.open.size).toBe(1);
    fake.drop();
    expect(fake.open.size).toBe(0);
    const connects = fake.connects;
    await Promise.all(Array.from({ length: 5 }, () => run(tool, {})));
    expect(fake.connects).toBe(connects + 1);
    expect(fake.open.size).toBe(1);
    await tools.close();
    expect(fake.open.size).toBe(0);
  });

  it("does not pile up abort listeners over discovery retries", async () => {
    const fake = new FakeMcp();
    fake.down = true;
    const added = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const removed = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    try {
      const { tools } = open(fake);
      await until(() => fake.connects >= 6, "retries");
      await tools.close();
      const aborts = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === "abort");
      // Every listener added for a backoff is removed again; none outlives its timer.
      expect(aborts(removed).length).toBeGreaterThanOrEqual(aborts(added).length - 3);
    } finally {
      added.mockRestore();
      removed.mockRestore();
    }
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

  it("does nothing for an empty catalog or one with only disabled servers", () => {
    const registry = createRegistry();
    const tools = new McpTools(registry, new FakeMcp().transport, TIMINGS);
    tools.start();
    tools.apply([]);
    tools.apply([{ ...SPEC, enabled: false }]);
    expect(registry.snapshot().installed()).toEqual([]);
  });
});

/** A catalog the test edits: what `McpCatalogCache` is to the host (current catalog plus change notifications). */
class FakeCatalog {
  servers: McpServerSpec[] = [];
  readonly #listeners = new Set<(servers: readonly McpServerSpec[]) => void>();
  get(): readonly McpServerSpec[] {
    return this.servers;
  }
  subscribe(listener: (servers: readonly McpServerSpec[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  set(servers: McpServerSpec[]): void {
    this.servers = servers;
    for (const listener of this.#listeners) listener(servers);
  }
}

function logged(
  write: MockInstance<typeof process.stdout.write>,
  event: string,
): Record<string, unknown>[] {
  return write.mock.calls
    .map(([line]) => {
      try {
        return JSON.parse(String(line)) as Record<string, unknown>;
      } catch {
        return {};
      }
    })
    .filter((entry) => entry.event === event);
}

describe("McpTools follows the catalog", () => {
  const started: McpTools[] = [];
  let write: MockInstance<typeof process.stdout.write>;
  beforeEach(() => {
    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const tools of started.splice(0)) await tools.close();
    vi.restoreAllMocks();
  });

  function open(transport: McpTransportFactory) {
    const registry = createRegistry();
    const tools = new McpTools(registry, transport, TIMINGS);
    started.push(tools);
    tools.start();
    return { registry, tools };
  }
  const installed = (registry: ReturnType<typeof createRegistry>) =>
    registry
      .snapshot()
      .installed()
      .map((e) => e.name);
  const toolNames = (tools: McpTools) =>
    tools.servers.flatMap((s) => s.extension.tools?.map((t) => t.name) ?? []);

  it("installs a server added at runtime, and uninstalls it when it is removed or disabled", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const { registry, tools } = open(fake.transport);
    expect(installed(registry)).toEqual([]);
    tools.apply([SPEC]);
    expect(installed(registry)).toEqual(["mcp-demo"]);
    await until(() => toolNames(tools).length > 0, "discovery");
    expect(
      registry
        .snapshot()
        .tools()
        .map((t) => t.tool.name),
    ).toEqual(["mcp__demo__echo"]);

    tools.apply([{ ...SPEC, enabled: false }]);
    expect(installed(registry)).toEqual([]);
    await until(() => fake.open.size === 0, "the client to close");

    tools.apply([SPEC]);
    expect(installed(registry)).toEqual(["mcp-demo"]);
    await until(() => toolNames(tools).length > 0, "discovery again");
    tools.apply([]);
    expect(installed(registry)).toEqual([]);
  });

  it("keeps a server whose row did not change: same client, no new connection", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const { tools } = open(fake.transport);
    tools.apply([SPEC]);
    await until(() => toolNames(tools).length > 0, "discovery");
    const [before] = tools.servers;
    const connects = fake.connects;
    const other: McpServerSpec = { ...SPEC, name: "other" };
    tools.apply([SPEC, other]);
    expect(tools.servers[0]).toBe(before);
    expect(fake.connects).toBe(connects + 1); // only the new server connected
  });

  it("replaces a server whose url changed with a new client, and closes the old one", async () => {
    const one = new FakeMcp();
    const two = new FakeMcp();
    one.tools = [ECHO];
    two.tools = [ECHO];
    const { tools } = open((spec) => (spec.url.includes("one") ? one : two).transport());
    tools.apply([{ ...SPEC, url: "https://one.example.com/mcp" }]);
    await until(() => toolNames(tools).length > 0, "discovery");
    expect(one.open.size).toBe(1);
    tools.apply([{ ...SPEC, url: "https://two.example.com/mcp" }]);
    await until(() => two.open.size === 1 && one.open.size === 0, "the switch");
    await until(() => toolNames(tools).length > 0, "discovery on the new url");
    expect(tools.servers).toHaveLength(1);
    expect(tools.servers[0]?.spec.url).toBe("https://two.example.com/mcp");
  });

  it("lets a call that already runs finish while its server is removed, then closes the client", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    let finish: (() => void) | undefined;
    fake.onCall = () =>
      new Promise((resolve) => {
        finish = () => resolve({ content: [{ type: "text", text: "late answer" }] });
      });
    const { registry, tools } = open(fake.transport);
    tools.apply([SPEC]);
    await until(() => toolNames(tools).length > 0, "discovery");
    const tool = tools.servers[0]?.extension.tools?.[0];
    if (tool === undefined) throw new Error("no tool");
    const running = tool.execute({}, {} as never, context);
    await until(() => fake.calls.length === 1, "the call to arrive");

    tools.apply([]);
    expect(installed(registry)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The call is still on the wire: the client stays open until it settles.
    expect(fake.open.size).toBe(1);
    // A call that starts after the removal (a conversation that still held the tool) fails at once.
    await expect(tool.execute({}, {} as never, context)).rejects.toThrow(/no longer available/);
    expect(fake.calls).toHaveLength(1);

    finish?.();
    expect(await running).toMatchObject({ output: [{ type: "text", text: "late answer" }] });
    await until(() => fake.open.size === 0, "the client to close after the call");
  });

  it("logs mcp-schema-changed when a tool's input schema differs from the version it replaces, and only then", async () => {
    const fake = new FakeMcp();
    fake.tools = [
      ECHO,
      {
        name: "same",
        inputSchema: { type: "object", properties: { a: { type: "string" }, b: {} } },
      },
    ];
    const { tools } = open(fake.transport);
    tools.apply([SPEC]);
    await until(() => toolNames(tools).length === 2, "discovery");
    expect(logged(write, "mcp-schema-changed")).toEqual([]);

    // `same` only reorders its keys; `echo` gains a property.
    fake.tools = [
      {
        ...ECHO,
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, n: { type: "number" } },
        },
      },
      {
        name: "same",
        inputSchema: { properties: { b: {}, a: { type: "string" } }, type: "object" },
      },
    ];
    tools.apply([{ ...SPEC, timeoutMs: 400 }]);
    await until(() => logged(write, "mcp-tools-ready").length === 2, "the second discovery");
    expect(logged(write, "mcp-schema-changed")).toMatchObject([{ server: "demo", tool: "echo" }]);
  });

  it("removing a server that never connected stops its retries", async () => {
    const fake = new FakeMcp();
    fake.down = true;
    const { tools } = open(fake.transport);
    tools.apply([SPEC]);
    await until(() => fake.connects >= 2, "retries");
    tools.apply([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const connects = fake.connects;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fake.connects).toBe(connects);
  });

  it("applies catalogs before start without connecting, and connects at start", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const registry = createRegistry();
    const tools = new McpTools(registry, fake.transport, TIMINGS);
    started.push(tools);
    tools.apply([SPEC]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.connects).toBe(0);
    tools.start();
    await until(() => toolNames(tools).length > 0, "discovery");
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

  /** No MCP in the environment: the catalog is the only source of servers. */
  function config() {
    return loadConfig({
      PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
      PI_API_TOKENS: "alice:0123456789abcdef0123",
    });
  }

  async function openHost(
    fake: FakeMcp,
    catalog: FakeCatalog | undefined,
    storage: Storage = new MemoryStorage(),
    execInFlight = vi.fn(() => Promise.resolve()),
  ): Promise<Host> {
    const host = await Host.open(
      storage,
      config(),
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      { execInFlight },
      [],
      {
        ...(catalog === undefined ? {} : { catalog }),
        mcpTransport: fake.transport,
        mcpTimings: TIMINGS,
      },
    );
    hosts.push(host);
    return host;
  }

  const MODEL = { provider: "scripted", model: "scripted-1" } as const;
  const CODING = ["read", "write", "edit", "bash"];

  async function runScript(host: Host, id: number, steps: object[], requestId: string) {
    await host.submitInput(id, {
      text: JSON.stringify({ steps, final: "finished" }),
      requestId,
      steer: false,
    });
    await until(async () => (await host.status(id))?.state === "done", "the script to finish");
    return (await host.status(id))?.results ?? [];
  }

  it("an empty catalog (or none): no tool_search, no MCP extension, the offered tools are exactly the coding tools", async () => {
    const fake = new FakeMcp();
    for (const catalog of [undefined, new FakeCatalog()]) {
      const host = await openHost(fake, catalog);
      const id = await host.createConversation(MODEL);
      expect(await host.toolsOf(id)).toEqual({ offered: CODING, deferred: [] });
    }
    expect(fake.connects).toBe(0);
  });

  it("a server that is down does not block open; the call settles tool_unavailable; recovery installs the tools", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = (_n, args) =>
      Promise.resolve({ content: [{ type: "text", text: `echo ${String(args.text)}` }] });
    fake.down = true;
    const catalog = new FakeCatalog();
    catalog.servers = [SPEC];
    const execInFlight = vi.fn(() => Promise.resolve());
    const host = await openHost(fake, catalog, new MemoryStorage(), execInFlight);
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

  it("a server added at runtime reaches only conversations created after it; none restarts", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const catalog = new FakeCatalog();
    const host = await openHost(fake, catalog);
    const before = await host.createConversation(MODEL);
    catalog.set([SPEC]);
    const after = await host.createConversation(MODEL);
    await until(async () => (await host.toolsOf(after)).deferred.length > 0, "tools");
    expect((await host.toolsOf(after)).offered).toContain("tool_search");
    expect(await host.toolsOf(before)).toEqual({ offered: CODING, deferred: [] });
  });

  it("disabling or removing a server makes the next call settle tool_unavailable in a conversation that had it, without a restart", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.onCall = () => Promise.resolve({ content: [{ type: "text", text: "pong" }] });
    const catalog = new FakeCatalog();
    catalog.servers = [SPEC];
    const host = await openHost(fake, catalog);
    const id = await host.createConversation(MODEL);
    await until(async () => (await host.toolsOf(id)).deferred.includes("mcp__demo__echo"), "tools");
    const step = (requestId: string) =>
      runScript(
        host,
        id,
        [
          { tool: "tool_search", args: { query: "echo" } },
          { tool: "mcp__demo__echo", args: {} },
        ],
        requestId,
      );
    expect((await step("on")).at(-1)).toEqual({ isError: false, text: "pong" });

    catalog.set([{ ...SPEC, enabled: false }]);
    const off = (await step("off")).at(-1);
    expect(off?.isError).toBe(true);
    expect(off?.text).toMatch(/not available/);
    expect(fake.calls).toHaveLength(1);

    // Back on: the stored extension name selects the new installation of the same name.
    catalog.set([SPEC]);
    await until(async () => {
      const { offered, deferred } = await host.toolsOf(id);
      return [...offered, ...deferred].includes("mcp__demo__echo");
    }, "tools");
    expect((await step("again")).at(-1)).toEqual({ isError: false, text: "pong" });
  });

  it("a conversation created before any MCP server existed never gains MCP, across a restart with servers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-mcp-store-"));
    dirs.push(dir);
    const off = await openHost(
      new FakeMcp(),
      new FakeCatalog(),
      await openNodeJsonlStorage(dir, context),
    );
    const old = await off.createConversation(MODEL);
    await off.close();
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const catalog = new FakeCatalog();
    catalog.servers = [SPEC];
    const on = await openHost(fake, catalog, await openNodeJsonlStorage(dir, context));
    await until(
      async () => (await on.toolsOf(await on.createConversation(MODEL))).deferred.length > 0,
      "tools",
    );
    expect((await on.toolsOf(old)).offered).not.toContain("tool_search");
    expect((await on.toolsOf(old)).deferred).toEqual([]);
  });

  it("starts without the gateway token when the catalog names a server: its tools stay unavailable", async () => {
    // No mcpTransport seam: the real gateway transport fails every request without ONECLI_AGENT_TOKEN.
    const catalog = new FakeCatalog();
    catalog.servers = [SPEC];
    const host = await Host.open(
      new MemoryStorage(),
      config(),
      (error) => {
        throw error;
      },
      () => Promise.resolve("session"),
      {},
      [],
      { catalog, mcpTimings: TIMINGS },
    );
    hosts.push(host);
    const id = await host.createConversation(MODEL);
    expect((await host.toolsOf(id)).deferred).toEqual([]);
  });
});
