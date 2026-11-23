import { createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { McpFetch } from "@earendil-works/pi-mcp";
import type { SessionRow } from "@cela/session-core";
import { afterEach, describe, expect, it } from "vitest";
import { McpAccess, McpNotGrantedError } from "../src/mcp-access.ts";
import { McpTools } from "../src/mcp.ts";
import type { McpServerSpec, McpTimings } from "../src/mcp.ts";
import { agentIdentifier, mcpAgentIdentifier } from "../src/onecli-names.ts";
import { OneCliAdmin } from "../src/onecli-admin.ts";
import { Redacted } from "../src/onecli.ts";
import type { GatewayFetch } from "../src/onecli.ts";
import { FakeMcp } from "./fake-mcp.ts";
import { FakeOneCli } from "./fake-onecli.ts";

const A = "11111111-2222-4333-8444-555555555555";
const B = "aaaaaaaa-2222-4333-8444-555555555555";
const C = "cccccccc-2222-4333-8444-555555555555";

const DOCS: McpServerSpec = {
  name: "docs",
  url: "https://mcp.docs.example.com/mcp",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 300,
  maxOutputBytes: 24_576,
  onecliSecret: "docs-key",
};
const OPEN: McpServerSpec = {
  ...DOCS,
  name: "open",
  url: "https://mcp.open.example.com/",
  onecliSecret: null,
};

const session = (id: string, conversationId: number, mcpServers: string[] | null): SessionRow => ({
  id,
  owner: "alice",
  ownerSubject: "static:alice",
  status: "active",
  shard: 0,
  conversationId,
  model: null,
  failure: null,
  repo: null,
  onecli: null,
  workspaceReadyAt: null,
  profile: mcpServers === null ? null : { name: "p", version: 1, snapshot: { mcpServers } },
  usage: null,
  sandboxSize: null,
  networkMode: "proxied",
  sandboxFlavour: "default",
  sandboxRuntime: null,
  liveViewToken: null,
  createdAt: new Date(),
  lastActivityAt: new Date(),
});

interface Made {
  token: string;
  closed: boolean;
}

function setUp(sessions: SessionRow[], catalog: McpServerSpec[] = [DOCS, OPEN]) {
  const fake = new FakeOneCli();
  // The operator's secret for the server, made in OneCLI before the catalog names it.
  fake.secrets.set("sec-docs", {
    id: "sec-docs",
    name: "docs-key",
    value: "dummy-docs-secret",
    hostPattern: "mcp.docs.example.com",
    injectionConfig: {},
  });
  const onecli = new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), fake.fetch, {
    timeoutMs: 1000,
    retries: 0,
    backoffMs: 1,
    maxBackoffMs: 1,
  });
  const made: Made[] = [];
  const current = { catalog };
  const access = new McpAccess({
    onecli,
    catalog: () => current.catalog,
    sessionOf: (conversationId) =>
      Promise.resolve(sessions.find((s) => s.conversationId === conversationId)),
    gateway: "http://gateway:10255",
    caFile: "/nonexistent",
    noProxy: [],
    makeFetch: (token) => {
      const entry: Made = { token: token.reveal(), closed: false };
      made.push(entry);
      const fetch = (() => Promise.resolve(new Response(entry.token))) as unknown as GatewayFetch;
      fetch.close = () => {
        entry.closed = true;
        return Promise.resolve();
      };
      return Promise.resolve(fetch);
    },
  });
  return { fake, access, made, current };
}

const tokenOf = async (fetch: McpFetch): Promise<string> =>
  (await fetch("https://mcp.docs.example.com/mcp", {})).text();

describe("McpAccess: a session's MCP identity", () => {
  it("gives each session its own agent whose only grant is the credentialed secret its profile names", async () => {
    const sessions = [session(A, 1, ["docs"]), session(B, 2, ["docs", "open"])];
    const { fake, access } = setUp(sessions);
    const fa = await access.forConversation(1, DOCS);
    const fb = await access.forConversation(2, DOCS);
    const agentA = [...fake.agents.values()].find((a) => a.identifier === mcpAgentIdentifier(A));
    const agentB = [...fake.agents.values()].find((a) => a.identifier === mcpAgentIdentifier(B));
    expect(agentA).toBeDefined();
    expect(agentB).toBeDefined();
    // Exactly the one secret: the LLM keys OneCLI grants to a new agent are gone, and so is the repo's connection.
    for (const agent of [agentA, agentB]) {
      const held = fake.grants.get(agent?.id ?? "");
      expect([...(held?.secrets ?? [])]).toEqual(["sec-docs"]);
      expect([...(held?.connections ?? [])]).toEqual([]);
    }
    // Two sessions, two tokens: a request of one is never made with the other's.
    expect(await tokenOf(fa)).toBe(agentA?.accessToken);
    expect(await tokenOf(fb)).toBe(agentB?.accessToken);
    expect(agentA?.accessToken).not.toBe(agentB?.accessToken);
  });

  it.each([
    ["browser flavour", { sandboxFlavour: "browser" }],
    ["desktop flavour", { sandboxFlavour: "desktop" }],
    ["direct network mode", { networkMode: "direct" }],
  ])(
    "grants a %s session nothing, even when the catalog now credentials a server it names",
    async (_label, extra) => {
      const web = session(A, 1, ["docs"]);
      web.profile = { name: "p", version: 1, snapshot: { mcpServers: ["docs"], ...extra } };
      const { access, fake } = setUp([web]);
      expect(access.credentialedFor(web)).toEqual([]);
      await access.provision(web);
      await expect(access.forConversation(1, DOCS)).rejects.toBeInstanceOf(McpNotGrantedError);
      expect(fake.agents.size).toBe(0);
    },
  );

  it("gives a session whose profile does not name the server no agent and no way to ask for a grant", async () => {
    const sessions = [session(A, 1, ["open"]), session(B, 2, []), session(C, 3, null)];
    const { fake, access } = setUp(sessions);
    for (const conversation of [1, 2, 3]) {
      await expect(access.forConversation(conversation, DOCS)).rejects.toThrow(McpNotGrantedError);
    }
    // Nothing was created in OneCLI for any of them.
    expect(fake.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
    // A conversation the inbox does not know has no identity either.
    await expect(access.forConversation(99, DOCS)).rejects.toThrow(/session is gone/);
  });

  it("does not grant a server the catalog disabled or no longer credentials, even if the profile names it", async () => {
    const sessions = [session(A, 1, ["docs"])];
    const { access, current } = setUp(sessions);
    current.catalog = [{ ...DOCS, enabled: false }];
    await expect(access.forConversation(1, DOCS)).rejects.toThrow(/not a credentialed server/);
    current.catalog = [{ ...DOCS, onecliSecret: null }];
    await expect(access.forConversation(1, DOCS)).rejects.toThrow(/not a credentialed server/);
  });

  it("refuses a name prefix whose MCP agent name OneCLI would reject (50 characters) when it is built, not with a 400", () => {
    const sessions = [session(A, 1, ["docs"])];
    const { fake } = setUp(sessions);
    expect(
      () =>
        new McpAccess({
          onecli: new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), fake.fetch),
          catalog: () => [DOCS],
          sessionOf: () => Promise.resolve(sessions[0]),
          gateway: "http://g",
          caFile: "/x",
          noProxy: [],
          namePrefix: "pi-session-extra-",
        }),
    ).toThrow(/PI_ONECLI_NAME_PREFIX.*12 characters/);
    expect(mcpAgentIdentifier(A).length).toBeLessThanOrEqual(50);
  });

  it("refuses a secret that does not exist or is for another host, and fails closed without the admin key", async () => {
    const sessions = [session(A, 1, ["docs"])];
    const { fake, access, current } = setUp(sessions);
    current.catalog = [{ ...DOCS, onecliSecret: "no-such-secret" }];
    await expect(
      access.forConversation(1, { ...DOCS, onecliSecret: "no-such-secret" }),
    ).rejects.toThrow(/does not exist/);
    const secret = fake.secrets.get("sec-docs");
    if (secret !== undefined) secret.hostPattern = "other.example.com";
    current.catalog = [DOCS];
    await expect(access.forConversation(1, DOCS)).rejects.toThrow(/is for other.example.com/);
    expect([...fake.agents.values()].filter((a) => a.identifier === mcpAgentIdentifier(A))).toEqual(
      [],
    );

    const bare = new McpAccess({
      onecli: undefined,
      catalog: () => [DOCS],
      sessionOf: () => Promise.resolve(sessions[0]),
      gateway: "http://g",
      caFile: "/x",
      noProxy: [],
    });
    await expect(bare.forConversation(1, DOCS)).rejects.toThrow(/ONECLI_API_KEY/);
  });

  it("revokes with the session: the agent is deleted, its fetch closed and a later request fails", async () => {
    const sessions = [session(A, 1, ["docs"]), session(B, 2, ["docs"])];
    const { fake, access, made } = setUp(sessions);
    const fa = await access.forConversation(1, DOCS);
    await access.forConversation(2, DOCS);
    await access.teardown(sessions[0] as SessionRow);
    expect([...fake.agents.values()].map((a) => a.identifier)).toEqual([mcpAgentIdentifier(B)]);
    expect(made.find((m) => m.closed)).toBeDefined();
    await expect(tokenOf(fa)).rejects.toThrow(McpNotGrantedError);
    // Idempotent, and the other session is untouched.
    await access.teardown(sessions[0] as SessionRow);
    expect(await tokenOf(await access.forConversation(2, DOCS))).toMatch(/^aoc_/);
  });

  it("provisions before the first turn, and only for a profile that names a credentialed server", async () => {
    const sessions = [session(A, 1, ["docs"]), session(B, 2, ["open"]), session(C, 3, null)];
    const { fake, access } = setUp(sessions);
    for (const s of sessions) await access.provision(s);
    expect([...fake.agents.values()].map((a) => a.identifier)).toEqual([mcpAgentIdentifier(A)]);
    // Again: nothing new is created, and the call finds the agent it made.
    await access.provision(sessions[0] as SessionRow);
    expect(fake.calls.filter((c) => c === "POST /v1/agents")).toHaveLength(1);
  });

  it("makes no OneCLI call for a session whose profile names no MCP server", async () => {
    const plain = session(C, 3, ["not-a-server"].slice(1));
    const { fake, access } = setUp([plain]);
    await access.teardown(plain);
    expect(fake.calls).toEqual([]);
  });

  it("revokes by name when there is no session row (the orphan sweep)", async () => {
    const sessions = [session(A, 1, ["docs"])];
    const { fake, access } = setUp(sessions);
    await access.forConversation(1, DOCS);
    const fresh = new McpAccess({
      onecli: new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), fake.fetch),
      catalog: () => [DOCS],
      sessionOf: () => Promise.resolve(undefined),
      gateway: "http://g",
      caFile: "/x",
      noProxy: [],
    });
    await fresh.revokeSession(A);
    expect([...fake.agents.values()]).toEqual([]);
  });

  it("re-narrows when the profile's credentialed set changes and never leaves another session's secret on the agent", async () => {
    const sessions = [session(A, 1, ["docs", "second"])];
    const second: McpServerSpec = {
      ...DOCS,
      name: "second",
      url: "https://mcp.second.example.com/",
      onecliSecret: "second-key",
    };
    const { fake, access, current } = setUp(sessions, [DOCS]);
    fake.secrets.set("sec-second", {
      id: "sec-second",
      name: "second-key",
      value: "dummy",
      hostPattern: "mcp.second.example.com",
      injectionConfig: {},
    });
    await access.forConversation(1, DOCS);
    const agent = [...fake.agents.values()].find((a) => a.identifier === mcpAgentIdentifier(A));
    expect([...(fake.grants.get(agent?.id ?? "")?.secrets ?? [])]).toEqual(["sec-docs"]);
    current.catalog = [DOCS, second];
    await access.forConversation(1, second);
    expect([...(fake.grants.get(agent?.id ?? "")?.secrets ?? [])].sort()).toEqual([
      "sec-docs",
      "sec-second",
    ]);
    // Still one agent for the session, and none carries the repo agent's identifier.
    expect([...fake.agents.values()].filter((a) => a.identifier === agentIdentifier(A))).toEqual(
      [],
    );
  });

  it("uses a discovery agent per credentialed server and removes it when the server leaves the catalog", async () => {
    const { fake, access } = setUp([]);
    const d = await access.discovery(DOCS);
    const agent = [...fake.agents.values()].find((a) => a.identifier === "pi-session-d-docs");
    expect(await tokenOf(d)).toBe(agent?.accessToken);
    expect([...(fake.grants.get(agent?.id ?? "")?.secrets ?? [])]).toEqual(["sec-docs"]);
    await access.reconcileDiscovery([DOCS]);
    expect(fake.agents.size).toBe(1);
    await access.reconcileDiscovery([{ ...DOCS, onecliSecret: null }]);
    expect(fake.agents.size).toBe(0);
    await expect(tokenOf(d)).rejects.toThrow(McpNotGrantedError);
  });
});

describe("McpTools with an identity", () => {
  const TIMINGS: McpTimings = { discoveryTimeoutMs: 300, retryMinMs: 10, retryMaxMs: 40 };
  const started: McpTools[] = [];
  afterEach(async () => {
    for (const tools of started.splice(0)) await tools.close();
  });

  const ECHO = { name: "echo", description: "e", inputSchema: { type: "object", properties: {} } };

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("timed out");
  }

  it("lists tools with the discovery identity and carries each conversation's calls on its own fetch", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const used: { fetch: McpFetch | undefined }[] = [];
    const fetches = new Map<string, McpFetch>();
    const label = (name: string): McpFetch => {
      const f: McpFetch = () => Promise.resolve(new Response(name));
      fetches.set(name, f);
      return f;
    };
    const discoveryFetch = label("discovery");
    const conv = new Map<number, McpFetch>([
      [1, label("session-A")],
      [2, label("session-B")],
    ]);
    const identity = {
      discovery: () => Promise.resolve(discoveryFetch),
      forConversation: (c: number) => {
        const f = conv.get(c);
        return f === undefined
          ? Promise.reject(new McpNotGrantedError("no grant"))
          : Promise.resolve(f);
      },
    };
    const registry = createRegistry();
    const tools = new McpTools(
      registry,
      (_spec, fetch) => {
        used.push({ fetch });
        return fake.transport();
      },
      TIMINGS,
      identity,
    );
    started.push(tools);
    tools.apply([DOCS]);
    tools.start();
    await until(() => (tools.servers[0]?.extension.tools?.length ?? 0) > 0);
    // Discovery used the discovery identity, never a session's.
    expect(used.map((u) => u.fetch)).toEqual([discoveryFetch]);

    const tool = tools.servers[0]?.extension.tools?.[0];
    if (tool === undefined) throw new Error("no tool");
    const call = (conversationId: number) => tool.execute({}, { conversationId } as never, context);
    await call(1);
    await call(2);
    await call(1);
    // One connection per conversation: A's calls on A's fetch, B's on B's, and A's second call reuses A's.
    expect(used.map((u) => u.fetch)).toEqual([discoveryFetch, conv.get(1), conv.get(2)]);
    // A conversation with no grant never reaches the server.
    const before = fake.calls.length;
    await expect(call(3)).rejects.toThrow(/no grant/);
    expect(fake.calls).toHaveLength(before);
  });

  it("never reaches a credentialed server on the orchestrator's own token when there is no identity", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const used: unknown[] = [];
    const tools = new McpTools(
      createRegistry(),
      (_spec, fetch) => {
        used.push(fetch);
        return fake.transport();
      },
      TIMINGS,
    );
    started.push(tools);
    tools.apply([DOCS]);
    tools.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(used).toEqual([]);
    expect(tools.servers[0]?.extension.tools ?? []).toHaveLength(0);
  });

  it("keeps a server without a secret on the shared fetch: one connection for every conversation", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    const used: unknown[] = [];
    const tools = new McpTools(
      createRegistry(),
      (_spec, fetch) => {
        used.push(fetch);
        return fake.transport();
      },
      TIMINGS,
      {
        discovery: () => Promise.reject(new Error("no")),
        forConversation: () => Promise.reject(new Error("no")),
      },
    );
    started.push(tools);
    tools.apply([OPEN]);
    tools.start();
    await until(() => (tools.servers[0]?.extension.tools?.length ?? 0) > 0);
    const tool = tools.servers[0]?.extension.tools?.[0];
    if (tool === undefined) throw new Error("no tool");
    await tool.execute({}, { conversationId: 1 } as never, context);
    await tool.execute({}, { conversationId: 2 } as never, context);
    expect(used).toEqual([undefined]);
  });

  it("nudge cuts the wait between discovery attempts", async () => {
    const fake = new FakeMcp();
    fake.tools = [ECHO];
    fake.down = true;
    const slow: McpTimings = { discoveryTimeoutMs: 100, retryMinMs: 60_000, retryMaxMs: 60_000 };
    const tools = new McpTools(createRegistry(), fake.transport, slow);
    started.push(tools);
    tools.apply([OPEN]);
    tools.start();
    await new Promise((r) => setTimeout(r, 80));
    fake.down = false;
    tools.nudge();
    await until(() => (tools.servers[0]?.extension.tools?.length ?? 0) > 0);
  });
});
