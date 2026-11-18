/* global process, console, fetch, URL, AbortSignal */
// Driver of hack/egress-mcp-smoke.sh (epic #50, slice 8, docs/decisions/0040-mcp-egress-flow.md). It runs INSIDE the
// orchestrator pod (`kubectl exec -i deploy/pi-orchestrator -- node --input-type=module -e "$(cat this file)" <command> ...`),
// so the OneCLI admin key and the orchestrator's agent token stay in the cluster; it uses the orchestrator's compiled
// OneCliAdmin. Output is plain lines; a key or token is never printed (the dummy credentials of the smoke test are).
//
//   rules                          the OneCLI org host rules in order: `<priority> <action> <name> <host patterns>`
//   handmade <name> <host>         creates an allow rule by hand (an operator's), if no rule has that name
//   drop-rule <name>               deletes the rules with that name
//   probe <host>                   CONNECT <host>:443 through the gateway with the orchestrator's own agent token: prints
//                                  `blocked` for the gateway's 403, else `reachable <status>`
//   secret <name> <host> <header> <value>
//                                  creates a generic OneCLI secret (a dummy credential) unless one of that name exists
//   drop-secret <name>
//   grants <agent identifier>      the names of the secrets the agent holds, or `no-agent`
//   agent-fetch <agent identifier> <url>
//                                  GET <url> through the gateway AS that agent (its token is read from OneCLI and never
//                                  printed); prints `status <code>` and the X-Smoke-* request headers the origin echoed
//   agents <prefix>                the identifiers of the agents that start with it
import { readFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { createRequire } from "node:module";
import { loadConfig } from "/app/dist/config.js";
import { OneCliAdmin } from "/app/dist/onecli-admin.js";

const require = createRequire("/app/package.json");
const {
  fetch: undiciFetch,
  ProxyAgent,
} = require("/app/node_modules/.pnpm/undici@8.12.4/node_modules/undici");

const [command, a, b, c, d] = process.argv.slice(1);
const config = loadConfig(process.env);
if (config.repos.onecliApiKey === undefined)
  throw new Error("the orchestrator has no OneCLI admin key");
const admin = new OneCliAdmin(
  config.repos.onecliApi,
  config.repos.onecliApiKey,
  (url, init) => fetch(url, init),
  config.repos.onecliCalls,
);
const ca = await readFile(config.onecli.caFile, "utf8");

async function through(token, url) {
  const agent = new ProxyAgent({
    uri: config.onecli.gateway,
    token: `Basic ${Buffer.from(`x:${token}`).toString("base64")}`,
    requestTls: { ca: [...rootCertificates, ca] },
  });
  try {
    const res = await undiciFetch(url, { dispatcher: agent, signal: AbortSignal.timeout(15000) });
    return { status: res.status, text: await res.text() };
  } catch (error) {
    return { status: 0, text: String(error.cause?.code ?? error.message) };
  } finally {
    await agent.close();
  }
}

switch (command) {
  case "rules":
    for (const r of await admin.listHostRules())
      console.log(`${r.priority} ${r.action} ${r.name} ${(r.hostPatterns ?? ["?"]).join(",")}`);
    break;
  case "handmade": {
    const rules = await admin.listHostRules();
    if (!rules.some((r) => r.name === a))
      await admin.createHostRule({ name: a, action: "allow", hostPattern: b });
    break;
  }
  case "drop-rule":
    for (const r of (await admin.listHostRules()).filter((r) => r.name === a))
      await admin.deleteHostRule(r.id);
    break;
  case "probe": {
    const token = config.onecli.token?.reveal();
    if (token === undefined) throw new Error("the orchestrator has no agent token");
    const got = await through(token, `https://${a}/`);
    console.log(got.status === 403 ? "blocked" : `reachable ${got.status}`);
    break;
  }
  case "secret": {
    const known = (await admin.listSecrets()).find((s) => s.name === a);
    if (known === undefined)
      await admin.ensureSecret({
        name: a,
        value: d,
        hostPattern: b,
        header: c,
        valueFormat: "{value}",
      });
    break;
  }
  case "drop-secret":
    for (const s of (await admin.listSecrets()).filter((s) => s.name === a))
      await admin.deleteSecret(s.id);
    break;
  case "grants": {
    const agent = (await admin.listAgents()).find((x) => x.identifier === a);
    if (agent === undefined) {
      console.log("no-agent");
      break;
    }
    const names = new Map((await admin.listSecrets()).map((s) => [s.id, s.name]));
    const held = await admin.listGrants(agent.id);
    console.log(
      held.length === 0
        ? "none"
        : held
            .map((g) => (g.kind === "secret" ? (names.get(g.id) ?? "?") : `connection:${g.kind}`))
            .sort()
            .join(" "),
    );
    break;
  }
  case "agent-fetch": {
    const agent = (await admin.listAgents()).find((x) => x.identifier === a);
    if (agent === undefined) {
      console.log("no-agent");
      break;
    }
    const got = await through(agent.accessToken.reveal(), b);
    console.log(`status ${got.status}`);
    let headers = {};
    try {
      headers = JSON.parse(got.text).headers ?? {};
    } catch {
      /* not the echo */
    }
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase().startsWith("x-smoke-"))
        console.log(`header ${name} ${Array.isArray(value) ? value.join(",") : value}`);
    }
    break;
  }
  case "agents":
    for (const x of await admin.listAgents())
      if (x.identifier.startsWith(a)) console.log(x.identifier);
    break;
  default:
    throw new Error(`unknown command ${command}`);
}
