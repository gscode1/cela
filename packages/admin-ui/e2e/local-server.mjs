// A throwaway ingest for the local run of the browser suite: the real server code over a pool that answers only the
// settings read the console makes. No database, no cluster. Tokens are the ones playwright.local.config.ts sets.
import { fileURLToPath } from "node:url";
import { createIngestServer } from "../../ingest/dist/server.js";

const owners = { "local-admin-token": "alice", "local-owner-token": "bob" };
const row = {
  default_model: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  default_reasoning: null,
  max_reasoning: null,
  default_profile: null,
  turn_budget: 100,
  updated_at: new Date(0),
  updated_by: "seed",
};
const pool = {
  query: (sql) =>
    Promise.resolve(
      String(sql).includes("from inbox.settings")
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    ),
};
const server = createIngestServer({
  pool,
  authenticate: (headers) => {
    const token = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
    const owner = token === undefined ? undefined : owners[token];
    return Promise.resolve(owner === undefined ? undefined : { owner, subject: `static:${owner}` });
  },
  orchestratorUrl: "http://unused",
  settings: {},
  admins: ["alice"],
  consoleDir:
    process.env.WITH_CONSOLE === "1"
      ? fileURLToPath(new URL("../dist", import.meta.url))
      : undefined,
  schemaReady: () => true,
});
server.listen(Number(process.env.PORT), "127.0.0.1");
