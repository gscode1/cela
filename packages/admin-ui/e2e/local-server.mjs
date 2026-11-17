// A throwaway ingest for the local run of the browser suite: the real server code in front of the in-memory fake
// database that session-core's own tests use (settings, profiles, MCP catalog, skills, history, revisions and the
// default-profile guard run as in production; only Postgres is replaced). No database, no cluster. Tokens are the ones
// playwright.local.config.ts sets. Run with `node` (the fake is TypeScript).
//
// With FAKE_ADMIN=1 a small in-memory fake (fake-admin.mjs) answers the skills, MCP servers, status and profile reads in
// front of the real server, so the catalog specs can seed shard status and stale writes. Settings stay the real ingest's.
// Its profile list is the fake's own and does not read the profiles of the FakeSettingsDb, which is why the catalog specs
// and the profile specs run against different instances.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { SettingsCache, publishCapabilities, seedSettings } from "../../session-core/dist/index.js";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";
import { setConsoleHeaders } from "../../ingest/dist/console.js";
import { createIngestServer } from "../../ingest/dist/server.js";
import { createFakeAdmin } from "./fake-admin.mjs";

const owners = { "local-admin-token": "alice", "local-owner-token": "bob" };
const db = new FakeSettingsDb();
await seedSettings(db.asPool(), {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
});
// The model catalog the orchestrator would publish: "openai" has a credential, "anthropic" has none, scripted is the
// test provider. `/__local/models?mode=` switches what the credentials hint says, for the specs of the model pickers.
const MODELS = [
  {
    provider: "openai",
    id: "gpt-fast",
    name: "GPT Fast",
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
  },
  {
    provider: "openai",
    id: "gpt-think",
    name: "GPT Think",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  {
    provider: "anthropic",
    id: "claude-x",
    name: "Claude X",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 8192,
  },
  { provider: "scripted", id: "scripted-1", reasoning: false },
  { provider: "scripted", id: "scripted-2", reasoning: false },
];
const PROVIDERS = {
  default: [
    { provider: "openai", credential: "configured" },
    { provider: "anthropic", credential: "missing" },
    { provider: "scripted", credential: "configured" },
  ],
  "none-configured": [
    { provider: "openai", credential: "missing" },
    { provider: "anthropic", credential: "missing" },
    { provider: "scripted", credential: "configured" },
  ],
  unknown: [
    { provider: "openai", credential: "unknown" },
    { provider: "anthropic", credential: "unknown" },
    { provider: "scripted", credential: "configured" },
  ],
};
const publishModels = (mode) =>
  publishCapabilities(
    db.asPool(),
    {
      tools: ["read", "write", "edit", "bash"],
      extensions: [],
      models: MODELS,
      modelProviders: PROVIDERS[mode] ?? PROVIDERS.default,
    },
    "local",
  );
await publishModels("default");
const settings = new SettingsCache(db.asPool(), { pollMs: 60_000 });
await settings.start();

const authenticate = (headers) => {
  const token = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
  const owner = token === undefined ? undefined : owners[token];
  return Promise.resolve(owner === undefined ? undefined : { owner, subject: `static:${owner}` });
};
const ingest = createIngestServer({
  pool: db.asPool(),
  authenticate,
  orchestratorUrl: "http://unused",
  settings,
  admins: ["alice"],
  consoleDir:
    process.env.WITH_CONSOLE === "1"
      ? fileURLToPath(new URL("../dist", import.meta.url))
      : undefined,
  consoleCatalogs: process.env.CATALOGS === "readOnly" ? "readOnly" : "manage",
  schemaReady: () => true,
});
const modelControl = (req, res) => {
  const mode = new URL(req.url ?? "/", "http://localhost").searchParams.get("mode") ?? "default";
  void publishModels(mode).then(() => {
    res.writeHead(204);
    res.end();
  });
};
if (process.env.FAKE_ADMIN !== "1") {
  createServer((req, res) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname === "/__local/models")
      return modelControl(req, res);
    return ingest.emit("request", req, res);
  }).listen(Number(process.env.PORT), "127.0.0.1");
} else {
  const fake = createFakeAdmin();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    // Test controls of the fake: local only, no token.
    if (path.startsWith("/__fake/")) return void fake.handle(req, res, "test");
    if (!path.startsWith("/admin/")) return ingest.emit("request", req, res);
    // The same gate as ingest: 401 for an unknown token, 403 for an owner that is not an admin.
    void authenticate(req.headers).then(async (principal) => {
      setConsoleHeaders(res);
      if (principal === undefined) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "unauthorized" }));
      }
      if (principal.owner !== "alice") {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "forbidden" }));
      }
      // /admin/settings is the real ingest's; everything else of the catalogs is the fake's.
      if (path === "/admin/settings" || !(await fake.handle(req, res, principal.owner)))
        return ingest.emit("request", req, res);
    });
  });
  server.listen(Number(process.env.PORT), "127.0.0.1");
}
