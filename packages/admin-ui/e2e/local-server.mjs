// A throwaway ingest for the local run of the browser suite: the real server code in front of the in-memory fake
// database that session-core's own tests use (settings, profiles, MCP catalog, skills, history, revisions and the
// default-profile guard run as in production; only Postgres is replaced). No database, no cluster. Tokens are the ones
// playwright.local.config.ts sets. Run with `node` (the fake is TypeScript).
import { fileURLToPath } from "node:url";
import { SettingsCache, seedSettings } from "../../session-core/dist/index.js";
import { FakeSettingsDb } from "../../session-core/test/fake-settings-db.ts";
import { createIngestServer } from "../../ingest/dist/server.js";

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
const settings = new SettingsCache(db.asPool(), { pollMs: 60_000 });
await settings.start();

const server = createIngestServer({
  pool: db.asPool(),
  authenticate: (headers) => {
    const token = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
    const owner = token === undefined ? undefined : owners[token];
    return Promise.resolve(owner === undefined ? undefined : { owner, subject: `static:${owner}` });
  },
  orchestratorUrl: "http://unused",
  settings,
  admins: ["alice"],
  consoleDir:
    process.env.WITH_CONSOLE === "1"
      ? fileURLToPath(new URL("../dist", import.meta.url))
      : undefined,
  schemaReady: () => true,
});
server.listen(Number(process.env.PORT), "127.0.0.1");
