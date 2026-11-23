/* global process, console, fetch, Buffer, AbortSignal */
// Driver of hack/egress-mcp-smoke.sh (epic #50, slice 8, docs/decisions/0040-mcp-egress-flow.md). It runs INSIDE the
// orchestrator pod (`kubectl exec -i deploy/pi-orchestrator -- node --input-type=module -e "$(cat this file)" <command> ...`),
// so the OneCLI admin key and the orchestrator's agent token stay in the cluster; it uses the orchestrator's compiled
// OneCliAdmin. Output is plain lines; a key or token is never printed (the dummy credentials of the smoke test are).
//
//   rules                          the OneCLI org host rules in order: `<priority> <action> <name> <host patterns>`
//   handmade <name> <host>         creates an allow rule by hand (an operator's), if no rule has that name
//   ensure-block                   creates the terminal `block *` rule pi-block-all if there is none; prints `created` or `present`
//   drop-rule <name>               deletes the rules with that name
//   probe <host>                   CONNECT <host>:443 through the gateway with the orchestrator's own agent token: prints
//                                  `blocked` for the gateway's 403, else `reachable <status>`
//   secret <name> <host> <header> <value>
//                                  creates a generic OneCLI secret (a dummy credential) unless one of that name exists
//   drop-secret <name>
//   grants <agent identifier>      the names of the secrets the agent holds, or `no-agent`
//   agent-fetch <agent identifier> <url> [--header Name=Value]... [--timeout-s N]
//                                  GET <url> through the gateway AS that agent (its token is read from OneCLI and never
//                                  printed), with the extra request headers; prints `status <code>`, `elapsed <ms>` and the
//                                  X-Smoke-* and X-Cela-* request headers the origin echoed (a header the origin saw twice
//                                  prints comma-joined). --timeout-s defaults to 15
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

// `--header Name=Value` and `--timeout-s N` after the positional arguments of agent-fetch.
function options(args) {
  const out = { headers: {}, timeoutS: 15 };
  for (let i = 0; i < args.length; i += 2) {
    const value = args[i + 1];
    if (value === undefined) throw new Error(`${args[i]} needs a value`);
    if (args[i] === "--header") {
      const at = value.indexOf("=");
      if (at < 1) throw new Error("--header wants Name=Value");
      out.headers[value.slice(0, at)] = value.slice(at + 1);
    } else if (args[i] === "--timeout-s") {
      out.timeoutS = Number(value);
      if (!(out.timeoutS > 0)) throw new Error("--timeout-s wants a positive number");
    } else throw new Error(`unknown option ${args[i]}`);
  }
  return out;
}

async function through(token, url, { headers = {}, timeoutS = 15 } = {}) {
  const agent = new ProxyAgent({
    uri: config.onecli.gateway,
    token: `Basic ${Buffer.from(`x:${token}`).toString("base64")}`,
    requestTls: { ca: [...rootCertificates, ca] },
  });
  try {
    const res = await undiciFetch(url, {
      dispatcher: agent,
      headers,
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
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
  case "ensure-block": {
    // The bundled OneCLI is open by default (ADR 0043): this smoke tests the hardened path, so it makes the terminal block
    // itself, and prints `created` so that the script removes it again.
    const rules = await admin.listHostRules();
    if (rules.some((r) => r.name === "pi-block-all")) console.log("present");
    else {
      await admin.createHostRule({ name: "pi-block-all", action: "block", hostPattern: "*" });
      console.log("created");
    }
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
    const opts = options(process.argv.slice(4));
    const started = Date.now();
    const got = await through(agent.accessToken.reveal(), b, opts);
    console.log(`status ${got.status}`);
    console.log(`elapsed ${Date.now() - started}`);
    // A status 0 carries the error code (e.g. UND_ERR_HEADERS_TIMEOUT) in the text: print it, the cut-off needs a reason.
    if (got.status === 0) console.log(`error ${got.text}`);
    let headers = {};
    try {
      headers = JSON.parse(got.text).headers ?? {};
    } catch {
      /* not the echo */
    }
    for (const [name, value] of Object.entries(headers)) {
      if (/^x-(smoke|cela)-/i.test(name))
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
