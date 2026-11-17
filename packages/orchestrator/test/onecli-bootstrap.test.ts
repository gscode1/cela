import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// hack/onecli-bootstrap.sh against a fake OneCLI API (the endpoints and the answers recorded in
// docs/research/onecli-bundled-spike.md) and a fake kubectl that keeps Secrets and ConfigMaps in a JSON file. The point:
// a second run writes nothing (changed=0, no new agents, secrets or rules), and no secret value reaches the output.
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "hack/onecli-bootstrap.sh");
const have = (tool: string): boolean => spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const tools = have("jq") && have("openssl") && have("curl");

interface Agent {
  id: string;
  identifier: string;
  accessToken: string;
}
interface Rule {
  id: string;
  name: string;
  action: string;
}
interface FakeState {
  users: Map<string, string>; // email -> password
  agents: Agent[];
  rules: Rule[];
  secrets: { id: string; name: string }[];
  grants: string[];
  calls: string[];
  nextId: number;
}
const freshState = (): FakeState => ({
  users: new Map(),
  agents: [],
  rules: [],
  secrets: [],
  grants: [],
  calls: [],
  nextId: 1,
});

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((done) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => {
      done(data);
    });
  });

// The one account's admin key and the cookie the fake server accepts. Fixed strings: nothing here is a real credential.
const API_KEY = "oc_fake-admin-key-0123456789";
const COOKIE = "better-auth.session_token=fake-session";
const PASSWORD_MARK = "never-print-me"; // not used as a value: the script generates its own password

let server: Server;
let state = freshState();
const origin = "http://localhost:10254";

beforeAll(async () => {
  server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const json = (code: number, value: unknown, headers: Record<string, string> = {}): true => {
        res.writeHead(code, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(value));
        return true;
      };
      const url = req.url ?? "";
      const method = req.method ?? "";
      state.calls.push(`${method} ${url}`);
      const bearer = req.headers.authorization === `Bearer ${API_KEY}`;
      const cookie = (req.headers.cookie ?? "").includes(COOKIE);
      const sessionOk = cookie && req.headers.origin === origin;
      const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, string>);

      if (url === "/v1/health") return json(200, { ok: true });
      if (url === "/v1/instance") return json(200, { origins: { external: origin } });
      if (url === "/auth/sign-up/email" && method === "POST") {
        if (state.users.has(parsed.email ?? "")) {
          return json(422, { code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" });
        }
        state.users.set(parsed.email ?? "", parsed.password ?? "");
        return json(200, { token: "t" }, { "set-cookie": `${COOKIE}; Path=/` });
      }
      if (url === "/auth/sign-in/email" && method === "POST") {
        if (state.users.get(parsed.email ?? "") !== parsed.password) {
          return json(401, { code: "INVALID_EMAIL_OR_PASSWORD" });
        }
        return json(200, { token: "t" }, { "set-cookie": `${COOKIE}; Path=/` });
      }
      if (url === "/v1/auth/session") return sessionOk ? json(200, { id: "u" }) : json(401, {});
      if (url === "/v1/user/api-key") {
        return sessionOk ? json(200, { apiKey: API_KEY }) : json(401, {});
      }
      if (!bearer) return json(401, { error: "Invalid API key or token" });

      if (url === "/v1/agents" && method === "GET") return json(200, state.agents);
      if (url === "/v1/agents" && method === "POST") {
        if (state.agents.some((a) => a.identifier === parsed.identifier)) return json(409, {});
        const id = `agent-${String(state.nextId++)}`;
        state.agents.push({
          id,
          identifier: parsed.identifier ?? "",
          accessToken: `aoc_fake-agent-token-${id}`,
        });
        return json(201, { id });
      }
      if (url === "/v1/org/policy/rules" && method === "GET") return json(200, state.rules);
      if (url === "/v1/org/policy/rules" && method === "POST") {
        const id = `rule-${String(state.nextId++)}`;
        state.rules.push({ id, name: parsed.name ?? "", action: parsed.action ?? "" });
        return json(201, { id });
      }
      const del = /^\/v1\/org\/policy\/rules\/(.+)$/.exec(url);
      if (del && method === "DELETE") {
        state.rules = state.rules.filter((r) => r.id !== del[1]);
        res.writeHead(204).end();
        return;
      }
      if (url === "/v1/secrets" && method === "GET") return json(200, state.secrets);
      if (url === "/v1/secrets" && method === "POST") {
        const id = `secret-${String(state.nextId++)}`;
        state.secrets.push({ id, name: parsed.name ?? "" });
        return json(201, { id });
      }
      if (/^\/v1\/agents\/[^/]+\/grants\/secrets\/[^/]+$/.test(url) && method === "PUT") {
        if (!state.grants.includes(url)) state.grants.push(url);
        return json(200, {});
      }
      json(404, { error: `unexpected ${method} ${url}` });
    })();
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
afterAll(() => {
  server.close();
});

let dir: string;
const fakeKubectl = `#!/usr/bin/env node
// Secrets and ConfigMaps in $FAKE_DIR/state.json. Only the calls hack/onecli-bootstrap.sh makes.
const fs = require("node:fs");
const file = process.env.FAKE_DIR + "/state.json";
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { secret: {}, configmap: {} };
const save = () => fs.writeFileSync(file, JSON.stringify(state));
let a = process.argv.slice(2);
const flag = (n) => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1]; };
for (const f of ["--context", "-n"]) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 2); }
fs.appendFileSync(process.env.FAKE_DIR + "/kubectl.log", a.join(" ") + "\\n");
const [verb, kind, name] = a;
const b64 = (s) => Buffer.from(s).toString("base64");
const jp = flag("-o");
if (verb === "get") {
  const store = state[kind === "secret" ? "secret" : "configmap"];
  const obj = store[name];
  if (obj === undefined) process.exit(1);
  if (jp && jp.startsWith("jsonpath=")) {
    const key = jp.slice('jsonpath={.data.'.length, -1).replace(/\\\\./g, ".");
    const v = obj[key];
    if (v === undefined) process.exit(0);
    process.stdout.write(kind === "secret" ? b64(v) : v);
  }
  process.exit(0);
}
if (verb === "create") {
  const pairs = a.filter((x) => x.startsWith("--from-file=")).map((x) => x.slice(12).split(/=(.*)/s));
  const data = Object.fromEntries(pairs.map(([k, p]) => [k, fs.readFileSync(p, "utf8")]));
  if (a.includes("--dry-run=client")) {
    const out = kind === "secret"
      ? { data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, b64(v)])) }
      : { kind: "ConfigMap", metadata: { name: a[2] }, data };
    process.stdout.write(JSON.stringify(out));
  } else { state.secret[a[3]] = data; save(); }
  process.exit(0);
}
if (verb === "patch") {
  const patch = JSON.parse(fs.readFileSync(flag("--patch-file"), "utf8"));
  Object.assign(state.secret[name], patch.stringData); save(); process.exit(0);
}
if (verb === "apply") {
  const o = JSON.parse(fs.readFileSync(0, "utf8"));
  state.configmap[o.metadata.name] = o.data; save(); process.exit(0);
}
console.error("fake kubectl: unsupported " + a.join(" "));
process.exit(2);
`;

let caPem = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "onecli-bootstrap-"));
  writeFileSync(join(dir, "kubectl"), fakeKubectl);
  chmodSync(join(dir, "kubectl"), 0o755);
  execFileSync(
    "openssl",
    [
      ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
      ...["-days", "2", "-subj", "/CN=Test Gateway CA", "-keyout", join(dir, "ca.key")],
      ...["-out", join(dir, "ca.crt")],
    ],
    { stdio: "ignore" },
  );
  caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  seedCa();
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const seedCa = (): void => {
  const file = join(dir, "state.json");
  const state = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>)
    : { secret: {}, configmap: {} };
  state.secret = { ...state.secret, "onecli-gateway-ca": { GATEWAY_CA_CERT: caPem } };
  writeFileSync(file, JSON.stringify(state));
};
const kube = (): {
  secret: Record<string, Record<string, string>>;
  configmap: Record<string, Record<string, string>>;
} => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as ReturnType<typeof kube>;

interface Result {
  status: number | null;
  out: string;
}
const bootstrap = (env: Record<string, string> = {}): Promise<Result> =>
  new Promise((done) => {
    const child = spawn("bash", [script, "-n", "ns"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FAKE_DIR: dir,
        ONECLI_API_URL: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (status) => {
      done({ status, out });
    });
  });

describe.skipIf(!tools)("hack/onecli-bootstrap.sh", () => {
  it("creates the account, key, agent, rules and CA on the first run, and changes nothing on the second", async () => {
    state = freshState();
    const first = await bootstrap();
    expect(first.status, first.out).toBe(0);
    expect(first.out).toMatch(/first account created/);
    expect(first.out).toMatch(/done: changed=[1-9]/);

    const k = kube();
    expect(k.secret["pi-onecli-admin"]?.["api-key"]).toBe(API_KEY);
    expect(Object.keys(k.secret["pi-onecli-admin"] ?? {}).sort()).toEqual([
      "api-key",
      "email",
      "password",
    ]);
    expect(k.secret["pi-onecli"]?.["agent-token"]).toMatch(/^aoc_/);
    // The key the chart mounts, the public certificate only.
    expect(k.configmap["pi-onecli-ca"]?.["ca.pem"]).toBe(caPem);
    expect(k.configmap["pi-onecli-ca"]?.["ca.pem"]).not.toContain("PRIVATE KEY");
    expect(state.agents.map((a) => a.identifier)).toEqual(["pi-orchestrator"]);
    const rules = state.rules.map((r) => r.name);
    expect(rules.at(-1)).toBe("pi-block-all");
    expect(rules).toContain("pi-allow-api.openai.com");
    expect(rules).toContain("pi-allow-wild-chatgpt.com");
    const ruleCount = rules.length;
    const snapshot = readFileSync(join(dir, "state.json"), "utf8");

    // Nothing secret is printed.
    const password = k.secret["pi-onecli-admin"]?.password ?? "";
    for (const value of [password, API_KEY, k.secret["pi-onecli"]?.["agent-token"] ?? "x"]) {
      expect(first.out).not.toContain(value);
    }

    state.calls.length = 0;
    const second = await bootstrap();
    expect(second.status, second.out).toBe(0);
    expect(second.out).toContain("done: changed=0");
    expect(second.out).toContain("stored admin key is valid");
    expect(second.out).toContain("host rules: 0 written");
    expect(second.out).toContain("CA ConfigMap pi-onecli-ca unchanged");
    expect(state.agents).toHaveLength(1);
    expect(state.rules).toHaveLength(ruleCount);
    expect(readFileSync(join(dir, "state.json"), "utf8")).toBe(snapshot);
    // No write to OneCLI at all, and no auth call (those are rate limited).
    expect(state.calls.filter((c) => /^(POST|PUT|DELETE) /.test(c))).toEqual([]);
    expect(state.calls.filter((c) => c.includes("/auth/"))).toEqual([]);
  });

  it("recovers the admin key from the stored login when only the key Secret is lost", async () => {
    const k = kube();
    delete k.secret["pi-onecli-admin"]?.["api-key"];
    writeFileSync(join(dir, "state.json"), JSON.stringify(k));
    const run = await bootstrap();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toContain("account exists; signing in");
    expect(kube().secret["pi-onecli-admin"]?.["api-key"]).toBe(API_KEY);
    expect(state.agents).toHaveLength(1);
  });

  it("stops when the account exists with a password this install does not hold", async () => {
    const k = kube();
    delete k.secret["pi-onecli-admin"];
    writeFileSync(join(dir, "state.json"), JSON.stringify(k));
    const run = await bootstrap();
    expect(run.status).toBe(1);
    expect(run.out).toContain("may have been claimed by someone else");
  });

  it("creates the optional provider secret once, from the environment, and never prints it", async () => {
    state = freshState();
    rmSync(join(dir, "state.json"));
    seedCa();
    const env = {
      ONECLI_SECRET_NAME: "pi-openai",
      ONECLI_SECRET_HOST: "api.openai.com",
      ONECLI_SECRET_VALUE: `sk-${PASSWORD_MARK}`,
    };
    const first = await bootstrap(env);
    expect(first.status, first.out).toBe(0);
    expect(state.secrets).toHaveLength(1);
    expect(first.out).not.toContain(PASSWORD_MARK);
    const second = await bootstrap(env);
    expect(second.out).toContain("done: changed=0");
    expect(state.secrets).toHaveLength(1);
  });

  it("refuses a partial secret definition", async () => {
    const run = await bootstrap({ ONECLI_SECRET_NAME: "x" });
    expect(run.status).toBe(64);
    expect(run.out).toContain("all of ONECLI_SECRET_NAME");
  });
});
