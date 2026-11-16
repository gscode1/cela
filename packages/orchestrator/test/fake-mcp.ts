import { McpSessionExpiredError } from "@earendil-works/pi-mcp";
import type { CallToolResult, JsonRpcMessage, McpTransport, Tool } from "@earendil-works/pi-mcp";
import { InMemoryTransport } from "@earendil-works/pi-mcp/testing";

/** The client end: fails where the fake says the network or the session does. */
class Wire extends InMemoryTransport {
  readonly #fake: FakeMcp;
  constructor(fake: FakeMcp) {
    super();
    this.#fake = fake;
  }
  override async start(): Promise<void> {
    if (this.#fake.down) throw new TypeError("fetch failed");
    await super.start();
  }
  override async send(message: JsonRpcMessage): Promise<void> {
    if ("method" in message && message.method === "tools/call" && this.#fake.expireNextCall) {
      this.#fake.expireNextCall = false;
      throw new McpSessionExpiredError();
    }
    return super.send(message);
  }
}

/** A scriptable in-process MCP server behind the in-memory transport of pi-mcp. */
export class FakeMcp {
  tools: Tool[] = [];
  /** Handles `tools/call`; may never settle, to model a hung server. */
  onCall: (name: string, args: Record<string, unknown>) => Promise<CallToolResult> = () =>
    Promise.resolve({ content: [{ type: "text", text: "ok" }] });
  /** While true the server is unreachable: connecting fails, as when the gateway cannot reach it. */
  down = false;
  /** The next `tools/call` on a connection fails the way an expired Mcp-Session-Id does (HTTP 404). */
  expireNextCall = false;
  connects = 0;
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly cancelled: string[] = [];

  /** The `McpTransportFactory` to pass to `McpTools` or `Host.open`. */
  readonly transport = (): McpTransport => {
    this.connects += 1;
    const wire = new Wire(this);
    // `peer` is the server end; `wire` is the client end, with the faults.
    const peer = new InMemoryTransport();
    wire.connectPeer(peer);
    peer.connectPeer(wire);
    void peer.start();
    peer.onMessage((message) => void this.#serve(peer, message));
    return wire;
  };

  async #serve(server: InMemoryTransport, message: JsonRpcMessage): Promise<void> {
    if (!("method" in message) || !("id" in message)) {
      if ("method" in message && message.method === "notifications/cancelled") {
        const params = message.params as { requestId?: unknown } | undefined;
        this.cancelled.push(String(params?.requestId));
      }
      return;
    }
    const reply = (result: unknown) => server.send({ jsonrpc: "2.0", id: message.id, result });
    const params = (message.params ?? {}) as Record<string, unknown>;
    switch (message.method) {
      case "initialize":
        await reply({
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        });
        return;
      case "tools/list":
        await reply({ tools: this.tools });
        return;
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        this.calls.push({ name, args });
        await reply(await this.onCall(name, args));
        return;
      }
      default:
        await reply({});
    }
  }
}
