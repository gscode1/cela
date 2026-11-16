import type { FetchLike } from "../src/github-app.ts";

interface Agent {
  id: string;
  name: string;
  identifier: string;
  accessToken: string;
}
interface Secret {
  id: string;
  name: string;
  value: string;
  hostPattern: string;
  injectionConfig: unknown;
}

/**
 * An in-memory OneCLI v2 management API, just enough for the provisioning code. Like the real one (seen live) it
 * grants every new agent the existing LLM secrets and a connection, so narrowing has something to remove.
 * `calls` is every request as `METHOD path`, in order.
 */
export class FakeOneCli {
  readonly agents = new Map<string, Agent>();
  readonly secrets = new Map<string, Secret>();
  readonly grants = new Map<string, { secrets: Set<string>; connections: Set<string> }>();
  readonly calls: string[] = [];
  readonly bodies: { call: string; body: unknown }[] = [];
  /** Answer the grant list in the other accepted shape. */
  flatGrants = false;
  /** Pretend deleting a grant does nothing, to prove the verification step fails closed. */
  ignoreRevokes = false;
  #seq = 0;

  constructor() {
    for (const name of ["Codex subscription", "OpenRouter"]) {
      const id = `llm-${name.split(" ")[0]?.toLowerCase() ?? "x"}-0000000000000000`;
      this.secrets.set(id, {
        id,
        name,
        value: "provider-secret",
        hostPattern: "x",
        injectionConfig: {},
      });
    }
  }

  readonly fetch: FetchLike = (url, init) => {
    const path = new URL(url).pathname;
    const call = `${init.method} ${path}`;
    this.calls.push(call);
    const body =
      init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    if (body !== undefined) this.bodies.push({ call, body });
    if (init.headers.authorization !== "Bearer oc_admin")
      return reply(401, { error: "unauthorized" });
    const parts = path.split("/").filter(Boolean); // v1, agents, <id>, grants, secrets, <sid>
    const [, kind, id, sub, subKind, subId] = parts;

    if (kind === "agents" && id === undefined) {
      if (init.method === "GET") return reply(200, [...this.agents.values()]);
      const created = this.#createAgent(String(body?.name), String(body?.identifier));
      return reply(201, { id: created.id, name: created.name, identifier: created.identifier });
    }
    if (kind === "agents" && id !== undefined && sub === undefined && init.method === "DELETE") {
      const had = this.agents.delete(id);
      this.grants.delete(id);
      return reply(had ? 204 : 404, undefined);
    }
    if (kind === "agents" && id !== undefined && sub === "grants") {
      const held = this.grants.get(id);
      if (held === undefined) return reply(404, { error: "no agent" });
      if (subKind === undefined) return reply(200, this.#listGrants(held));
      if (subId === undefined) return reply(404, undefined);
      if (init.method === "PUT") held.secrets.add(subId);
      if (init.method === "DELETE" && !this.ignoreRevokes) {
        held.secrets.delete(subId);
        held.connections.delete(subId);
      }
      return reply(204, undefined);
    }
    if (kind === "secrets" && id === undefined) {
      if (init.method === "GET")
        return reply(
          200,
          [...this.secrets.values()].map((s) => ({ id: s.id, name: s.name })),
        );
      const secretId = `sec-${String(++this.#seq).padStart(20, "0")}`;
      this.secrets.set(secretId, {
        id: secretId,
        name: String(body?.name),
        value: String(body?.value),
        hostPattern: String(body?.hostPattern),
        injectionConfig: body?.injectionConfig,
      });
      return reply(201, { id: secretId, name: body?.name });
    }
    if (kind === "secrets" && id !== undefined) {
      const secret = this.secrets.get(id);
      if (init.method === "DELETE") return reply(this.secrets.delete(id) ? 204 : 404, undefined);
      if (init.method === "PATCH" && secret !== undefined) {
        secret.value = String(body?.value);
        return reply(200, { id });
      }
    }
    return reply(404, { error: "not found" });
  };

  #createAgent(name: string, identifier: string): Agent {
    const id = `agent-${String(++this.#seq).padStart(20, "0")}`;
    const agent = {
      id,
      name,
      identifier,
      accessToken: `aoc_${String(this.#seq).padStart(64, "a")}`,
    };
    this.agents.set(id, agent);
    this.grants.set(id, {
      secrets: new Set([...this.secrets.keys()].filter((key) => key.startsWith("llm-"))),
      connections: new Set(["github-connection-0000000000"]),
    });
    return agent;
  }

  #listGrants(held: { secrets: Set<string>; connections: Set<string> }): unknown {
    if (this.flatGrants) {
      return [
        ...[...held.secrets].map((id) => ({ type: "secret", id })),
        ...[...held.connections].map((id) => ({ type: "connection", id })),
      ];
    }
    return {
      secrets: [...held.secrets].map((id) => ({ id })),
      connections: [...held.connections].map((id) => ({ id })),
    };
  }

  secretNamed(name: string): Secret | undefined {
    return [...this.secrets.values()].find((s) => s.name === name);
  }
}

function reply(status: number, body: unknown): ReturnType<FetchLike> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return Promise.resolve({
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  });
}
