import type { FetchLike } from "./github-app.js";
import { Redacted } from "./onecli.js";

/**
 * Client for the OneCLI v2 management API (`gateway.example:10256`, `Authorization: Bearer oc_...`), used only to
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

/** The request did not complete (connection error or timeout): nothing is known about whether it was applied. */
export class OneCliTransportError extends Error {}

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

/**
 * One org rule of the gateway's host list (`/v1/org/policy/rules`, docs/onecli-host-rules.md), reduced to what the host-rule
 * reconciler needs. The gateway applies the rules in `priority` order (creation order, not settable): the first match
 * wins, so an allow created after a `block *` never takes effect.
 */
export interface OneCliHostRule {
  id: string;
  name: string;
  action: "allow" | "block";
  priority: number;
  enabled: boolean;
  description: string;
  /** The host patterns of the rule's network targets that carry no path or method; `null` when it has any other kind of target. */
  hostPatterns: string[] | null;
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

/** Bounds on one management API call; see docs/decisions/0005-migrations-without-ddl-locks.md. */
export interface OneCliCallPolicy {
  /** Each attempt is aborted after this long. */
  timeoutMs: number;
  /** Tries after the first one. 0 disables the retry. */
  retries: number;
  /** Wait before the first retry; doubles per retry, capped at `maxBackoffMs`. */
  backoffMs: number;
  maxBackoffMs: number;
  /** Only tests replace this. */
  sleep?: (ms: number) => Promise<void>;
}

export const DEFAULT_CALL_POLICY: OneCliCallPolicy = {
  timeoutMs: 15_000,
  retries: 3,
  backoffMs: 500,
  maxBackoffMs: 5_000,
};

export class OneCliAdmin {
  readonly #base: string;
  readonly #key: Redacted;
  readonly #fetch: FetchLike;
  readonly #policy: OneCliCallPolicy;

  constructor(
    baseUrl: string,
    apiKey: Redacted,
    fetchImpl: FetchLike,
    policy: OneCliCallPolicy = DEFAULT_CALL_POLICY,
  ) {
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#key = apiKey;
    this.#fetch = fetchImpl;
    this.#policy = policy;
  }

  /**
   * One call with a per-attempt timeout and bounded backoff. A network error, a timeout and a 5xx are retried; a 4xx
   * (and a 2xx the caller does not accept) never is, because asking again cannot change the answer. A POST is never
   * retried here: whatever fails after it was sent may hide an applied create (a gateway timing out after OneCLI
   * committed), so `#createReconciled` decides what to do, by looking the object up again.
   */
  async #call(
    method: string,
    path: string,
    body?: unknown,
    accept: readonly number[] = [200, 201, 204],
  ): Promise<{ status: number; body: unknown }> {
    const { retries, backoffMs, maxBackoffMs } = this.#policy;
    const sleep = this.#policy.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#attempt(method, path, body, accept);
      } catch (error) {
        if (attempt >= retries || !this.#retryable(method, error)) throw error;
        await sleep(Math.min(maxBackoffMs, backoffMs * 2 ** attempt));
      }
    }
  }

  #retryable(method: string, error: unknown): boolean {
    if (method === "POST") return false;
    if (error instanceof OneCliError) return error.status >= 500;
    // Only transport failures reach here: a malformed body is a plain Error from parsing, not worth asking again.
    return error instanceof OneCliTransportError;
  }

  /**
   * Whether the next round's lookup may change the outcome: a POST that may have been applied (anything but a 4xx,
   * which OneCLI answers before it writes), or a 409, which says the name is taken. A 409 also comes right after the
   * object of that name was deleted (a parked agent being recreated, ADR 0069); the lookup then finds nothing and the
   * POST is tried again after the backoff.
   */
  #ambiguous(error: unknown): boolean {
    if (error instanceof OneCliError) return error.status >= 500 || error.status === 409;
    return error instanceof OneCliTransportError;
  }

  /**
   * Find-or-create with the retry policy applied to the whole step, never to the raw POST. Each round first looks
   * the object up by name; only if it is absent does it POST. A POST that fails in an ambiguous way (5xx, timeout,
   * network) is followed, after the backoff, by the next round's lookup, which finds the object if OneCLI applied the
   * create and so never creates it twice. A definite refusal (4xx) and the last round's failure are thrown.
   */
  async #createReconciled<T>(
    find: () => Promise<T | undefined>,
    create: () => Promise<void>,
  ): Promise<T> {
    const { retries, backoffMs, maxBackoffMs } = this.#policy;
    const sleep = this.#policy.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      const existing = await find();
      if (existing !== undefined) return existing;
      try {
        await create();
      } catch (error) {
        if (attempt >= retries || !this.#ambiguous(error)) throw error;
        await sleep(Math.min(maxBackoffMs, backoffMs * 2 ** attempt));
        continue;
      }
      const created = await find();
      if (created === undefined) throw new Error("OneCLI accepted the create but does not list it");
      return created;
    }
  }

  async #attempt(
    method: string,
    path: string,
    body: unknown,
    accept: readonly number[],
  ): Promise<{ status: number; body: unknown }> {
    const shown = path.replace(/[0-9a-f-]{20,}/g, ":id");
    const timeout = AbortSignal.timeout(this.#policy.timeoutMs);
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.#key.reveal()}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: timeout,
      });
    } catch (error) {
      // Never the cause's text: it may carry the URL, and nothing here needs more than the path.
      throw new OneCliTransportError(
        timeout.aborted
          ? `OneCLI ${method} ${shown} timed out after ${String(this.#policy.timeoutMs)} ms`
          : `OneCLI ${method} ${shown} failed: ${error instanceof Error ? error.name : "network error"}`,
      );
    }
    if (!accept.includes(response.status)) {
      throw new OneCliError(
        `OneCLI ${method} ${shown} answered HTTP ${String(response.status)}`,
        response.status,
      );
    }
    if (response.status === 204) return { status: 204, body: undefined };
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new OneCliTransportError(`OneCLI ${method} ${shown} broke off while answering`);
    }
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

  /**
   * The agent with this identifier, created if absent. The create answer has no token (v2.20 recheck), so the agent
   * is read back with `listAgents`. Reconciles by identifier rather than retrying the POST (see `#createReconciled`).
   */
  async ensureAgent(identifier: string): Promise<{ agent: OneCliAgent; created: boolean }> {
    let created = false;
    const agent = await this.#createReconciled(
      async () => (await this.listAgents()).find((a) => a.identifier === identifier),
      async () => {
        created = true;
        await this.#call("POST", "/v1/agents", { name: identifier, identifier });
      },
    );
    return { agent, created };
  }

  /** Deleting an agent makes its token fail at once (spike Q5). Already gone is fine. */
  async deleteAgent(id: string): Promise<void> {
    await this.#call("DELETE", `/v1/agents/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  }

  /** `hostPattern` is only set when the API gives one (the typed and generic secrets do, spike Q7). */
  async listSecrets(): Promise<{ id: string; name: string; hostPattern?: string }[]> {
    const { body } = await this.#call("GET", "/v1/secrets");
    return listOf(body, ["secrets", "data"], "the secret list").map((entry) => {
      const record = asRecord(entry, "a secret");
      return {
        id: idOf(entry, "a secret"),
        name: typeof record.name === "string" ? record.name : "",
        ...(typeof record.hostPattern === "string" && record.hostPattern !== ""
          ? { hostPattern: record.hostPattern }
          : {}),
      };
    });
  }

  /**
   * Creates the secret unless one of that name exists, and returns its id. Reconciles by name rather than retrying the
   * POST. A secret found here (a lost create that was applied) already holds the value just posted.
   */
  async ensureSecret(input: SecretInput): Promise<string> {
    const found = await this.#createReconciled(
      async () => (await this.listSecrets()).find((s) => s.name === input.name),
      async () => {
        await this.#createSecret(input);
      },
    );
    return found.id;
  }

  /** UNVERIFIED on v2: the field names of a generic secret (`injectionConfig`) are those of v1.45. */
  async #createSecret(input: SecretInput): Promise<string> {
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

  /** The org host rules, in priority order. A rule in a shape this client does not know is listed with `hostPatterns: null`. */
  async listHostRules(): Promise<OneCliHostRule[]> {
    const { body } = await this.#call("GET", "/v1/org/policy/rules");
    return listOf(body, ["rules", "data"], "the host rule list")
      .map((entry): OneCliHostRule => {
        const record = asRecord(entry, "a host rule");
        const targets = Array.isArray(record.targets) ? (record.targets as unknown[]) : [];
        const patterns: string[] = [];
        let simple = targets.length > 0;
        for (const target of targets) {
          const t = typeof target === "object" && target !== null ? (target as Json) : {};
          if (
            t.kind === "network" &&
            typeof t.hostPattern === "string" &&
            (t.pathPattern ?? null) === null &&
            (t.method ?? null) === null
          ) {
            patterns.push(t.hostPattern);
          } else simple = false;
        }
        return {
          id: idOf(entry, "a host rule"),
          name: typeof record.name === "string" ? record.name : "",
          action: record.action === "block" ? "block" : "allow",
          priority: typeof record.priority === "number" ? record.priority : Number.MAX_SAFE_INTEGER,
          enabled: record.enabled !== false,
          description: typeof record.description === "string" ? record.description : "",
          hostPatterns: simple ? patterns : null,
        };
      })
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Creates a host rule (one network target). Not retried: a create that failed in an ambiguous way may have been applied,
   * and the reconciler's next pass lists the rules again and sees it.
   */
  async createHostRule(input: {
    name: string;
    action: "allow" | "block";
    hostPattern: string;
    description?: string;
  }): Promise<void> {
    await this.#call("POST", "/v1/org/policy/rules", {
      name: input.name,
      action: input.action,
      ...(input.description === undefined ? {} : { description: input.description }),
      targets: [{ kind: "network", hostPattern: input.hostPattern }],
    });
  }

  async deleteHostRule(id: string): Promise<void> {
    await this.#call(
      "DELETE",
      `/v1/org/policy/rules/${encodeURIComponent(id)}`,
      undefined,
      [200, 204, 404],
    );
  }
}
