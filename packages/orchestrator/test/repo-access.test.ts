import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openBinding } from "@pi-durable-k8s/session-core";
import type { SessionRow } from "@pi-durable-k8s/session-core";
import { EgressPrincipals } from "../src/egress.ts";
import { FakeEgressDb } from "../../session-core/test/fake-egress-db.ts";
import type { FetchLike } from "../src/github-app.ts";
import { OneCliAdmin, parseGrants } from "../src/onecli-admin.ts";
import { Redacted } from "../src/onecli.ts";
import { agentIdentifier, RepoAccess, RepoUnavailableError } from "../src/repo-access.ts";
import { FakeOneCli } from "./fake-onecli.ts";

const SESSION = "11111111-2222-4333-8444-555555555555";
const NAME = agentIdentifier(SESSION);

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION,
  owner: "alice",
  ownerSubject: "static:alice",
  status: "active",
  shard: 0,
  conversationId: 7,
  model: null,
  failure: null,
  repo: { repo: "octo/hello" },
  onecli: null,
  workspaceReadyAt: null,
  profile: null,
  usage: null,
  sandboxSize: null,
  networkMode: "proxied",
  createdAt: new Date(),
  lastActivityAt: new Date(),
  ...over,
});

let dir: string;
let onecli: FakeOneCli;
let queries: { sql: string; params: unknown[] }[];
let minted: { repo: string; expires: string }[];
let clock: number;
let githubStatus: number;

const pool = {
  query: (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return Promise.resolve({ rows: [], rowCount: 1 });
  },
} as unknown as pg.Pool;

function githubApi(): FetchLike {
  return (_url, init) => {
    const body = JSON.parse(init.body ?? "{}") as { repositories: string[] };
    const expires = new Date(clock + 60 * 60 * 1000).toISOString();
    minted.push({ repo: body.repositories.join(","), expires });
    const answer = {
      token: `ghs_token_${String(minted.length)}`,
      expires_at: expires,
      repositories: [{ full_name: `octo/${body.repositories[0] ?? ""}` }],
    };
    return Promise.resolve({
      status: githubStatus,
      json: () => Promise.resolve(answer),
      text: () => Promise.resolve(JSON.stringify(answer)),
    });
  };
}

function access(
  over: {
    onecli?: OneCliAdmin | undefined;
    namePrefix?: string | undefined;
    repoAllowed?: (repo: string) => boolean;
    egress?: EgressPrincipals;
  } = {},
): RepoAccess {
  return new RepoAccess({
    pool,
    repoAllowed: over.repoAllowed ?? (() => true),
    onecli:
      "onecli" in over
        ? over.onecli
        : new OneCliAdmin("http://onecli:10256", new Redacted("oc_admin"), onecliFetch()),
    githubAppDir: dir,
    gateway: "http://onecli.onecli:10255",
    caFile: join(dir, "ca.pem"),
    fetch: githubApi(),
    namePrefix: over.namePrefix,
    egress: over.egress,
    now: () => clock,
  });
}
const onecliFetch = (): FetchLike => onecli.fetch;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "repo-access-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(join(dir, "app-id"), "123456");
  await writeFile(join(dir, "installation-id"), "7890123");
  await writeFile(join(dir, "private-key.pem"), privateKey);
  onecli = new FakeOneCli();
  queries = [];
  minted = [];
  clock = Date.UTC(2026, 10, 15, 12, 0, 0);
  githubStatus = 201;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("OneCLI provisioning and grant narrowing", () => {
  it("creates the agent and two per-session secrets, and leaves the agent holding only those", async () => {
    const repos = access();
    const env = await repos.shellEnv(session(), 7);

    const [agent] = [...onecli.agents.values()];
    expect(onecli.agents.size).toBe(1);
    expect(agent?.identifier).toBe(NAME);
    // Auto-granted LLM secrets and the connection are gone; only the two GitHub secrets stay.
    const held = onecli.grants.get(agent?.id ?? "");
    const mine = [...onecli.secrets.values()].filter((s) => s.name.startsWith(`${NAME}-`));
    expect(mine).toHaveLength(2);
    expect([...(held?.secrets ?? [])].sort()).toEqual(mine.map((s) => s.id).sort());
    expect(held?.connections.size).toBe(0);
    // The proxy URL carries this agent's token.
    expect(env?.HTTPS_PROXY).toBe(`http://x:${agent?.accessToken ?? ""}@onecli.onecli:10255`);
  });

  it("injects Basic x-access-token for github.com and Bearer for api.github.com, with the repo's token", async () => {
    await access().shellEnv(session(), 7);
    const git = onecli.secretNamed(`${NAME}-git`);
    const api = onecli.secretNamed(`${NAME}-api`);
    expect(git?.hostPattern).toBe("github.com");
    expect(git?.injectionConfig).toEqual({
      headerName: "Authorization",
      valueFormat: "Basic {value}",
    });
    expect(Buffer.from(git?.value ?? "", "base64").toString()).toBe("x-access-token:ghs_token_1");
    expect(api?.hostPattern).toBe("api.github.com");
    expect(api?.injectionConfig).toEqual({
      headerName: "Authorization",
      valueFormat: "Bearer {value}",
    });
    expect(api?.value).toBe("ghs_token_1");
    // No pathPattern: path rules can be bypassed (v2 recheck); the token's own scope is the boundary.
    expect(
      onecli.bodies
        .filter((b) => b.call === "POST /v1/secrets")
        .every((b) => !("pathPattern" in (b.body as object))),
    ).toBe(true);
  });

  it("mints for exactly the session's repository and stores only ids in Postgres", async () => {
    await access().shellEnv(session(), 7);
    expect(minted).toEqual([{ repo: "hello", expires: "2026-11-15T13:00:00.000Z" }]);
    const stored = queries.find((q) => q.sql.includes("onecli_agent_id"));
    expect(stored?.params[0]).toBe(SESSION);
    expect(JSON.stringify(stored?.params)).not.toMatch(/ghs_|aoc_/);
  });

  it("accepts the other grant list shape too", async () => {
    onecli.flatGrants = true;
    await access().shellEnv(session(), 7);
    expect(onecli.grants.get([...onecli.agents.keys()][0] ?? "")?.connections.size).toBe(0);
  });

  it("fails closed and deletes the agent when a grant cannot be removed", async () => {
    onecli.ignoreRevokes = true;
    await expect(access().shellEnv(session(), 7)).rejects.toThrow(/still holds \d+ grants/);
    expect(onecli.agents.size).toBe(0);
    expect([...onecli.secrets.values()].filter((s) => s.name.startsWith(NAME))).toHaveLength(0);
  });

  it("is idempotent: a second process finds the agent and secrets, re-mints and rotates the value", async () => {
    await access().shellEnv(session(), 7);
    clock += 5 * 60 * 1000;
    const again = access(); // a restarted orchestrator: cold cache
    await again.shellEnv(session({ onecli: { agentId: "x", secretIds: [] } }), 7);
    expect(onecli.agents.size).toBe(1);
    expect([...onecli.secrets.values()].filter((s) => s.name.startsWith(`${NAME}-`))).toHaveLength(
      2,
    );
    expect(minted).toHaveLength(2);
    expect(onecli.secretNamed(`${NAME}-api`)?.value).toBe("ghs_token_2");
    expect(
      onecli.calls.filter(
        (c) => c === "PATCH /v1/secrets/" + (onecli.secretNamed(`${NAME}-api`)?.id ?? ""),
      ),
    ).toHaveLength(1);
  });
});

describe("token renewal", () => {
  it("re-mints before expiry on the next tool call and not earlier", async () => {
    const repos = access();
    await repos.shellEnv(session(), 7);
    expect(minted).toHaveLength(1);

    clock += 40 * 60 * 1000; // 20 minutes left: fine
    await repos.beforeUse(7);
    expect(minted).toHaveLength(1);

    clock += 15 * 60 * 1000; // 5 minutes left: renew
    await repos.beforeUse(7);
    expect(minted).toHaveLength(2);
    expect(onecli.secretNamed(`${NAME}-api`)?.value).toBe("ghs_token_2");
    // Renewal does not create a second agent or change the agent token.
    expect(onecli.agents.size).toBe(1);
  });

  /** A restarted orchestrator whose session row already stores the agent: it was proven narrow before. */
  async function openWithStoredAgent(): Promise<RepoAccess> {
    await access().shellEnv(session(), 7);
    const agentId = [...onecli.agents.keys()][0] ?? "";
    const repos = access();
    await repos.shellEnv(session({ onecli: { agentId, secretIds: [] } }), 7);
    return repos;
  }

  it("keeps the agent, and so the open env's token, when a renewal's grant check fails transiently", async () => {
    const repos = await openWithStoredAgent();
    const [agentId] = [...onecli.agents.keys()];
    clock += 55 * 60 * 1000;
    onecli.failGrantReads = true;
    await expect(repos.beforeUse(7)).rejects.toThrow();
    expect([...onecli.agents.keys()]).toEqual([agentId]);
    onecli.failGrantReads = false;
    await repos.beforeUse(7);
    expect([...onecli.agents.keys()]).toEqual([agentId]);
    expect(repos.envStale(7)).toBe(false);
  });

  it("reports the open env stale when the agent had to be replaced, so it can be reopened with the new token", async () => {
    const repos = await openWithStoredAgent();
    expect(repos.envStale(7)).toBe(false);
    const [before] = [...onecli.agents.keys()];
    clock += 55 * 60 * 1000;
    // Someone widened the agent and removing the grant does not work: it is proven still wide and must go.
    onecli.grants.get(before ?? "")?.secrets.add("llm-codex-0000000000000000");
    onecli.ignoreRevokes = true;
    await expect(repos.beforeUse(7)).rejects.toThrow(/still holds/);
    onecli.ignoreRevokes = false;
    await repos.beforeUse(7); // a new agent, a new token
    expect([...onecli.agents.keys()]).not.toContain(before);
    expect(repos.envStale(7)).toBe(true);
    // Opening an env reads the current token again, which clears it.
    await repos.shellEnv(session(), 7);
    expect(repos.envStale(7)).toBe(false);
  });

  it("does nothing for a conversation that is not a repo session", async () => {
    const repos = access();
    await repos.beforeUse(99);
    expect(onecli.calls).toEqual([]);
    expect(minted).toEqual([]);
  });
});

describe("a session without a repo", () => {
  it("makes no OneCLI call, no GitHub call and gets no extra env", async () => {
    const repos = access();
    const plain = session({ repo: null });
    expect(await repos.shellEnv(plain, 7)).toBeUndefined();
    await repos.beforeUse(7);
    await repos.teardown(plain);
    expect(onecli.calls).toEqual([]);
    expect(minted).toEqual([]);
  });
});

describe("misconfiguration", () => {
  it("refuses a repo session without the admin key, and without the GitHub App secret", async () => {
    await expect(access({ onecli: undefined }).shellEnv(session(), 7)).rejects.toThrow(
      /ONECLI_API_KEY/,
    );
    await rm(join(dir, "private-key.pem"));
    await expect(access().shellEnv(session(), 7)).rejects.toThrow(/private-key.pem is missing/);
    expect(onecli.agents.size).toBe(0);
  });

  it("mints nothing and creates nothing for a repo off the allowlist", async () => {
    await expect(access({ repoAllowed: () => false }).shellEnv(session(), 7)).rejects.toThrow(
      RepoUnavailableError,
    );
    expect(minted).toEqual([]);
    expect(onecli.calls).toEqual([]);
  });

  it("stops renewing the token once the repo leaves the allowlist", async () => {
    let allowed = true;
    const repos = access({ repoAllowed: () => allowed });
    await repos.shellEnv(session(), 7);
    expect(minted).toHaveLength(1);
    allowed = false;
    clock += 55 * 60 * 1000;
    await expect(repos.beforeUse(7)).rejects.toThrow(/not on the repo allowlist/);
    expect(minted).toHaveLength(1);
  });

  it("creates nothing in OneCLI when GitHub refuses the token", async () => {
    githubStatus = 404;
    await expect(access().shellEnv(session(), 7)).rejects.toThrow(/refused the installation token/);
    expect(onecli.calls).toEqual([]);
  });
});

describe("teardown", () => {
  it("deletes the agent first, then both secrets, and is repeatable", async () => {
    const repos = access();
    await repos.shellEnv(session(), 7);
    const agentId = [...onecli.agents.keys()][0] ?? "";
    const secretIds = [...onecli.secrets.values()]
      .filter((s) => s.name.startsWith(`${NAME}-`))
      .map((s) => s.id);
    onecli.calls.length = 0;

    await repos.teardown(session({ onecli: { agentId, secretIds } }));
    expect(onecli.agents.size).toBe(0);
    expect([...onecli.secrets.values()].some((s) => s.name.startsWith(NAME))).toBe(false);
    // Provider secrets are untouched.
    expect(onecli.secretNamed("Codex subscription")).toBeDefined();
    const firstDelete = onecli.calls.findIndex((c) => c.startsWith("DELETE"));
    expect(onecli.calls[firstDelete]).toBe(`DELETE /v1/agents/${agentId}`);

    await repos.teardown(session({ onecli: { agentId, secretIds } }));
    expect(onecli.agents.size).toBe(0);
  });

  it("finds objects by name when the ids were never stored (crash after create)", async () => {
    await access().shellEnv(session(), 7);
    await access().teardown(session({ onecli: null }));
    expect(onecli.agents.size).toBe(0);
    expect([...onecli.secrets.values()].some((s) => s.name.startsWith(NAME))).toBe(false);
  });

  it("does not touch another session's objects", async () => {
    const other = "99999999-2222-4333-8444-555555555555";
    await access().shellEnv(session({ id: other }), 8);
    await access().shellEnv(session(), 7);
    await access().teardown(session());
    expect([...onecli.agents.values()].map((a) => a.identifier)).toEqual([agentIdentifier(other)]);
    expect(onecli.secretNamed(`${agentIdentifier(other)}-git`)).toBeDefined();
  });
});

describe("name prefix", () => {
  it("names the agent and secrets with the prefix, and teardown touches only that prefix's objects", async () => {
    const e2e = "pi-e2e-ab12cd-";
    await access().shellEnv(session(), 7);
    await access({ namePrefix: e2e }).shellEnv(session(), 7);
    const prefixed = agentIdentifier(SESSION, e2e);
    expect(prefixed).toBe(`pi-e2e-ab12cd-${SESSION}`);
    expect([...onecli.agents.values()].map((a) => a.identifier).sort()).toEqual([prefixed, NAME]);
    expect(onecli.secretNamed(`${prefixed}-git`)).toBeDefined();
    await access({ namePrefix: e2e }).teardown(session());
    expect([...onecli.agents.values()].map((a) => a.identifier)).toEqual([NAME]);
    expect(onecli.secretNamed(`${NAME}-git`)).toBeDefined();
  });

  it("refuses an invalid prefix at construction", () => {
    expect(() => access({ namePrefix: "Bad_" })).toThrow(/PI_ONECLI_NAME_PREFIX/);
  });
});

describe("parseGrants", () => {
  it("reads both shapes and refuses anything else", () => {
    expect(parseGrants({ secrets: [{ id: "a" }, "b"], connections: [{ id: "c" }] })).toEqual([
      { kind: "secret", id: "a" },
      { kind: "secret", id: "b" },
      { kind: "connection", id: "c" },
    ]);
    expect(
      parseGrants([
        { type: "secret", id: "a" },
        { kind: "app", appConnectionId: "z" },
      ]),
    ).toEqual([
      { kind: "secret", id: "a" },
      { kind: "connection", id: "z" },
    ]);
    expect(parseGrants({ secrets: [] })).toEqual([]);
    expect(() => parseGrants({ something: [] })).toThrow(/unexpected shape/);
    expect(() => parseGrants("nope")).toThrow();
    expect(() => parseGrants([{ type: "mystery", id: "a" }])).toThrow(/unknown kind/);
  });
});

describe("admin client errors", () => {
  it("names the call and status, never a body or the key", async () => {
    const bad = new OneCliAdmin("http://onecli:10256", new Redacted("oc_wrong"), onecli.fetch);
    const error = await bad.listAgents().catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe("OneCLI GET /v1/agents answered HTTP 401");
    expect((error as Error).message).not.toContain("oc_");
  });
});

describe("behind the egress proxy (ADR 0037)", () => {
  const KEY = Buffer.alloc(32, 3);
  const proxied = (key: Buffer | null = KEY) => {
    const db = new FakeEgressDb();
    const egress = new EgressPrincipals({
      pool: db.asPool(),
      proxyUrl: "http://pi-egress-proxy.ns.svc:3128",
      resolve: () => Promise.resolve("10.96.1.2"),
      bindingKey: key ?? undefined,
      master: () => "master-key-for-tests",
      sleep: () => Promise.resolve(),
    });
    return { db, egress, repos: access({ egress }) };
  };

  it("gives the sandbox the egress token and the CA, and no OneCLI token or gateway", async () => {
    const { repos, db } = proxied();
    const env = await repos.shellEnv(session(), 7);
    const [agent] = [...onecli.agents.values()];
    const everything = JSON.stringify(env);
    expect(env?.HTTPS_PROXY).toMatch(/^http:\/\/x:[A-Za-z0-9_-]{43}@10\.96\.1\.2:3128$/);
    expect(env?.HTTP_PROXY).toBe(env?.HTTPS_PROXY);
    expect(everything).not.toContain(agent?.accessToken ?? "unreachable");
    expect(everything).not.toContain("onecli.onecli");
    expect(env).toMatchObject({
      SSL_CERT_FILE: "/workspace/.onecli/bundle.pem",
      GIT_SSL_CAINFO: "/workspace/.onecli/bundle.pem",
      NODE_EXTRA_CA_CERTS: "/workspace/.onecli/ca.pem",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(db.principals).toHaveLength(1);
  });

  it("seals the agent's token for the proxy and routes github.com and api.github.com through OneCLI", async () => {
    const { repos, db } = proxied();
    await repos.shellEnv(session(), 7);
    const [agent] = [...onecli.agents.values()];
    const row = db.bindings[0];
    expect(db.bindings).toHaveLength(1);
    expect(
      openBinding(KEY, SESSION, {
        keyId: row?.key_id ?? "",
        nonce: row?.nonce ?? Buffer.alloc(0),
        ciphertext: row?.ciphertext ?? Buffer.alloc(0),
      }),
    ).toBe(agent?.accessToken);
    expect(JSON.stringify(db.bindings)).not.toContain(agent?.accessToken ?? "unreachable");
    expect(db.rules.map((r) => [r.session_id, r.host, r.route, r.effect])).toEqual([
      [SESSION, "github.com", "onecli", "allow"],
      [SESSION, "api.github.com", "onecli", "allow"],
    ]);
  });

  it("does not bind an agent that failed the narrow-grants check", async () => {
    const { repos, db } = proxied();
    onecli.ignoreRevokes = true;
    await expect(repos.shellEnv(session(), 7)).rejects.toThrow();
    expect(db.bindings).toHaveLength(0);
    expect(db.rules).toHaveLength(0);
  });

  it("refuses a repo session when no binding key is configured, before anything is created", async () => {
    const { repos, db } = proxied(null);
    await expect(repos.shellEnv(session(), 7)).rejects.toThrow(RepoUnavailableError);
    expect(onecli.agents.size).toBe(0);
    expect(minted).toHaveLength(0);
    expect(db.bindings).toHaveLength(0);
  });

  it("keeps the env when the agent is replaced: the sandbox never held its token", async () => {
    const { repos } = proxied();
    const first = await repos.shellEnv(session(), 7);
    onecli.agents.clear();
    clock += 2 * 60 * 60 * 1000;
    await repos.beforeUse(7);
    expect(repos.envStale(7)).toBe(false);
    expect((await repos.shellEnv(session(), 7))?.HTTPS_PROXY).toBe(first?.HTTPS_PROXY);
  });

  it("rewrites the binding when the agent is replaced", async () => {
    const { repos, db } = proxied();
    await repos.shellEnv(session(), 7);
    const before = db.bindings[0]?.ciphertext.toString("hex");
    onecli.agents.clear();
    clock += 2 * 60 * 60 * 1000;
    await repos.beforeUse(7);
    const [agent] = [...onecli.agents.values()];
    const row = db.bindings[0];
    expect(row?.ciphertext.toString("hex")).not.toBe(before);
    expect(
      openBinding(KEY, SESSION, {
        keyId: row?.key_id ?? "",
        nonce: row?.nonce ?? Buffer.alloc(0),
        ciphertext: row?.ciphertext ?? Buffer.alloc(0),
      }),
    ).toBe(agent?.accessToken);
  });

  it("is unchanged with the proxy off: the OneCLI gateway URL and token", async () => {
    const env = await access().shellEnv(session(), 7);
    const [agent] = [...onecli.agents.values()];
    expect(env?.HTTPS_PROXY).toBe(`http://x:${agent?.accessToken ?? ""}@onecli.onecli:10255`);
  });
});
