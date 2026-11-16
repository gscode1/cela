import type { FetchLike } from "./github-app.js";
import { Redacted } from "./onecli.js";

/**
 * Client for the OneCLI v2 management API (`onecli.onecli:10256`, `Authorization: Bearer oc_...`), used only to
 * provision and revoke per-session agents. Paths and bodies come from `docs/research/onecli-spike.md` and
 * `onecli-v2-recheck.md`; every shape that was not seen live is marked UNVERIFIED and parsed defensively.
 * Error messages carry the status and path, never a response body: `GET /v1/agents` returns every agent token.
 */
export class OneCliError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export interface OneCliAgent {
  id: string;
  name: string;
  identifier: string;
  /** `aoc_...`, the password of the proxy URL. Only on `GET /v1/agents`, never on create. */
  accessToken: Redacted;
}

/** One thing an agent may use. `secret` is the only kind a session agent keeps. */
export interface OneCliGrant {
  kind: "secret" | "connection";
  id: string;
}

/** A per-session generic secret: one host, one injected header. */
export interface SecretInput {
  name: string;
  value: string;
  hostPattern: string;
  /** UNVERIFIED on v2 (v1.45 shape): header and format of the injection; `{value}` is replaced by `value`. */
  header: string;
  valueFormat: string;
}

type Json = Record<string, unknown>;

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`OneCLI answered ${what} in an unexpected shape`);
  }
  return value as Json;
}

/** `[...]`, or an object holding the list under one of `keys` (v2 list envelopes are UNVERIFIED). */
function listOf(value: unknown, keys: readonly string[], what: string): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value, what);
  for (const key of keys) {
    const inner = record[key];
    if (Array.isArray(inner)) return inner;
  }
  throw new Error(`OneCLI answered ${what} in an unexpected shape`);
}

function idOf(entry: unknown, what: string): string {
  if (typeof entry === "string" && entry !== "") return entry;
  const record = asRecord(entry, what);
  for (const key of ["id", "secretId", "connectionId", "appConnectionId"]) {
    const value = record[key];
    if (typeof value === "string" && value !== "") return value;
  }
  throw new Error(`OneCLI answered ${what} without an id`);
}

/**
 * Parses `GET /v1/agents/{id}/grants`. The shape is UNVERIFIED (v1.45 answered per kind), so both a flat list of
 * `{type|kind, id}` and an object with `secrets` / `connections` / `apps` lists are accepted. Anything else throws:
 * the caller treats an unreadable answer as "cannot prove the agent is narrow" and fails closed.
 */
export function parseGrants(value: unknown): OneCliGrant[] {
  const grants: OneCliGrant[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry, "a grant");
      const type =
        record.type ?? record.kind ?? (record.secretId === undefined ? undefined : "secret");
      if (type !== "secret" && type !== "secrets" && type !== "connection" && type !== "app") {
        throw new Error("OneCLI answered a grant of an unknown kind");
      }
      grants.push({
        kind: type === "secret" || type === "secrets" ? "secret" : "connection",
        id: idOf(entry, "a grant"),
      });
    }
    return grants;
  }
  const record = asRecord(value, "the grants");
  let known = false;
  for (const [key, kind] of [
    ["secrets", "secret"],
    ["connections", "connection"],
    ["apps", "connection"],
    ["appConnections", "connection"],
  ] as const) {
    const list = record[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) throw new Error("OneCLI answered the grants in an unexpected shape");
    known = true;
    for (const entry of list) grants.push({ kind, id: idOf(entry, "a grant") });
  }
  if (!known) throw new Error("OneCLI answered the grants in an unexpected shape");
  return grants;
}

export class OneCliAdmin {
  readonly #base: string;
  readonly #key: Redacted;
  readonly #fetch: FetchLike;

  constructor(baseUrl: string, apiKey: Redacted, fetchImpl: FetchLike) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#key = apiKey;
    this.#fetch = fetchImpl;
  }

  async #call(
    method: string,
    path: string,
    body?: unknown,
    accept: readonly number[] = [200, 201, 204],
  ): Promise<{ status: number; body: unknown }> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#key.reveal()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!accept.includes(response.status)) {
      throw new OneCliError(
        `OneCLI ${method} ${path.replace(/[0-9a-f-]{20,}/g, ":id")} answered HTTP ${String(response.status)}`,
        response.status,
      );
    }
    if (response.status === 204) return { status: 204, body: undefined };
    const text = await response.text();
    return {
      status: response.status,
      body: text === "" ? undefined : (JSON.parse(text) as unknown),
    };
  }

  async listAgents(): Promise<OneCliAgent[]> {
    const { body } = await this.#call("GET", "/v1/agents");
    return listOf(body, ["agents", "data"], "the agent list").map((entry) => {
      const record = asRecord(entry, "an agent");
      const token = record.accessToken;
      if (typeof record.id !== "string" || typeof token !== "string") {
        throw new Error("OneCLI answered an agent without id or accessToken");
      }
      return {
        id: record.id,
        name: typeof record.name === "string" ? record.name : "",
        identifier: typeof record.identifier === "string" ? record.identifier : "",
        accessToken: new Redacted(token),
      };
    });
  }

  /** The create answer has no token (v2.20 recheck); read it back with `listAgents`. */
  async createAgent(name: string, identifier: string): Promise<void> {
    await this.#call("POST", "/v1/agents", { name, identifier });
  }

  /** Deleting an agent makes its token fail at once (spike Q5). Already gone is fine. */
  async deleteAgent(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/agents/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  }

  async listSecrets(): Promise<{ id: string; name: string }[]> {
    const { body } = await this.#call("GET", "/v1/secrets");
    return listOf(body, ["secrets", "data"], "the secret list").map((entry) => {
      const record = asRecord(entry, "a secret");
      return {
        id: idOf(entry, "a secret"),
        name: typeof record.name === "string" ? record.name : "",
      };
    });
  }

  /** UNVERIFIED on v2: the field names of a generic secret (`injectionConfig`) are those of v1.45. */
  async createSecret(input: SecretInput): Promise<string> {
    const { body } = await this.#call("POST", "/v1/secrets", {
      name: input.name,
      type: "generic",
      value: input.value,
      hostPattern: input.hostPattern,
      injectionConfig: { headerName: input.header, valueFormat: input.valueFormat },
    });
    const record = asRecord(body, "the created secret");
    const inner =
      typeof record.data === "object" && record.data !== null ? (record.data as Json) : record;
    return idOf(inner, "the created secret");
  }

  /** Rotates a secret's value in place (spike Q4: `PATCH /v1/secrets/{id}`; UNVERIFIED on v2). */
  async updateSecretValue(id: string, value: string): Promise<void> {
    await this.#call("PATCH", `/v1/secrets/${encodeURIComponent(id)}`, { value });
  }

  async deleteSecret(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/secrets/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  }

  /** What the agent can use right now. See `parseGrants` for the UNVERIFIED shape. */
  async listGrants(agentId: string): Promise<OneCliGrant[]> {
    const { body } = await this.#call("GET", `/v1/agents/${encodeURIComponent(agentId)}/grants`);
    return parseGrants(body);
  }

  async grantSecret(agentId: string, secretId: string): Promise<void> {
    await this.#call(
      "PUT",
      `/v1/agents/${encodeURIComponent(agentId)}/grants/secrets/${encodeURIComponent(secretId)}`,
      undefined,
    );
  }

  /** The secret path is confirmed live (docs/model-credentials.md); the connection path is UNVERIFIED. */
  async revokeGrant(agentId: string, grant: OneCliGrant): Promise<void> {
    const kind = grant.kind === "secret" ? "secrets" : "connections";
    await this.#call(
      "DELETE",
      `/v1/agents/${encodeURIComponent(agentId)}/grants/${kind}/${encodeURIComponent(grant.id)}`,
      undefined,
      [200, 204, 404],
    );
  }
}
