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
import { SettingsCache, seedSettings } from "../../session-core/dist/index.js";
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
if (process.env.FAKE_ADMIN !== "1") {
  ingest.listen(Number(process.env.PORT), "127.0.0.1");
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
