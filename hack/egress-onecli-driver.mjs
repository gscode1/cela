/* global process, console, fetch, URL */
// Driver of hack/egress-onecli-smoke.sh (epic #50, slice 5, docs/decisions/0037-egress-onecli-route.md). It runs INSIDE the
// orchestrator pod (`kubectl exec -i deploy/pi-orchestrator -- node --input-type=module -e "$(cat this file)" <command> ...`, cwd /app), so the
// OneCLI admin key, the binding key and the database URL stay in the cluster, and it uses the orchestrator's own compiled
// code: RepoAccess (with a fake GitHub that mints a dummy token, since a throwaway cluster has no GitHub App),
// EgressPrincipals and the session-core store. Output is plain lines; a token or key is never printed.
//
//   provision <session> <echo-host>  run RepoAccess for <session> as a repo session (agent, secrets for github.com and
//                                    api.github.com holding a dummy token, narrow grants, the sealed binding, the session
//                                    rules), then also grant it a secret on <echo-host> (header X-Smoke-Credential) and a
//                                    session rule for it. Prints the shape of the sandbox env, masked.
//   absent <session>                 reads text on stdin; says whether it contains the session's OneCLI token or egress token
//   unbind <session> | bind <session>  delete the session's binding row / seal its current agent token again
//   copy-binding <from> <to>         (SQL) copy one session's sealed row onto another's: it must not open
//   facts <session>                  counts: binding rows, session rules, live principal
//   allow-host <host> | disallow-host <host>
//                                    the bundled OneCLI blocks every host that hack/onecli-host-rules.sh did not allow
//                                    (rule pi-block-all, created last). The echo host is not on that list: add an allow rule
//                                    for it and re-create the block rule after it (the order the script keeps), or remove it
//   cleanup <session>                what the session delete and the sweep do, for a session that is already gone
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "/app/dist/config.js";
import { OneCliAdmin } from "/app/dist/onecli-admin.js";
import { agentIdentifier, secretName } from "/app/dist/onecli-names.js";
import { RepoAccess } from "/app/dist/repo-access.js";
import { EgressPrincipals } from "/app/dist/egress.js";
import {
  createPool,
  ensureSessionOneCliRules,
  parseBindingKey,
} from "/app/node_modules/@pi-durable-k8s/session-core/dist/index.js";

const [command, session, extra] = process.argv.slice(1);
const config = loadConfig(process.env);
if (config.egressProxyUrl === undefined || config.egressBindingKeyFile === undefined)
  throw new Error("the orchestrator has no egress proxy or binding key configured");
const pool = createPool(config.databaseUrl, "egress-onecli-driver", 2, config.databaseTls);
const callApi = (url, init) => fetch(url, init);
const onecli = new OneCliAdmin(
  config.repos.onecliApi,
  config.repos.onecliApiKey,
  callApi,
  config.repos.onecliCalls,
);
const bindingKey = parseBindingKey(await readFile(config.egressBindingKeyFile, "utf8"));
const egress = new EgressPrincipals({
  pool,
  proxyUrl: config.egressProxyUrl,
  bindingKey,
  master: () => process.env.PI_SANDBOX_MASTER_KEY ?? "",
});
const row = (id) => ({
  id,
  status: "active",
  repo: { repo: "octo/hello" },
  onecli: null,
  workspaceReadyAt: null,
  profile: null,
  conversationId: 424242,
  owner: "smoke",
  shard: 0,
});

async function fakeGithub() {
  const dir = await mkdtemp(join(tmpdir(), "smoke-app-"));
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  await writeFile(join(dir, "app-id"), "123456");
  await writeFile(join(dir, "installation-id"), "7890123");
  await writeFile(join(dir, "private-key.pem"), privateKey);
  const dummy = `ghs_dummy_${randomBytes(8).toString("hex")}`;
  const fetchGithub = () => {
    const answer = {
      token: dummy,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      repositories: [{ full_name: "octo/hello" }],
    };
    return Promise.resolve({
      status: 201,
      json: () => Promise.resolve(answer),
      text: () => Promise.resolve(JSON.stringify(answer)),
    });
  };
  return { dir, fetchGithub };
}

async function agentToken(id) {
  const { agent } = await onecli.ensureAgent(agentIdentifier(id, config.repos.namePrefix));
  return agent;
}

// One OneCLI management call with the admin key (never printed). The list answers a bare array or {rules|data: []}.
async function policy(method, path, body) {
  const res = await fetch(`${config.repos.onecliApi}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${config.repos.onecliApiKey.reveal()}`,
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`OneCLI ${method} ${path} answered ${String(res.status)}`);
  return text === "" ? undefined : JSON.parse(text);
}
const listRules = async () => {
  const body = await policy("GET", "/v1/org/policy/rules");
  return Array.isArray(body) ? body : (body?.rules ?? body?.data ?? []);
};
const ruleBody = (name, action, host) => ({
  name,
  action,
  targets: [{ kind: "network", hostPattern: host }],
});

try {
  switch (command) {
    case "allow-host": {
      const name = `smoke-allow-${session}`;
      let rules = await listRules();
      if (!rules.some((r) => r.name === name)) {
        await policy("POST", "/v1/org/policy/rules", ruleBody(name, "allow", session));
        rules = await listRules();
        const block = rules.find((r) => r.name === "pi-block-all");
        if (block !== undefined) {
          await policy("DELETE", `/v1/org/policy/rules/${block.id}`);
          await policy("POST", "/v1/org/policy/rules", ruleBody("pi-block-all", "block", "*"));
        }
      }
      console.log("allowed yes");
      break;
    }
    case "disallow-host": {
      const name = `smoke-allow-${session}`;
      for (const r of (await listRules()).filter((x) => x.name === name))
        await policy("DELETE", `/v1/org/policy/rules/${r.id}`);
      console.log("disallowed yes");
      break;
    }
    case "provision": {
      const echoHost = extra;
      const gh = await fakeGithub();
      const repos = new RepoAccess({
        pool,
        onecli,
        repoAllowed: () => true,
        githubAppDir: gh.dir,
        gateway: config.onecli.gateway,
        caFile: config.onecli.caFile,
        fetch: gh.fetchGithub,
        namePrefix: config.repos.namePrefix,
        egress,
      });
      const env = await repos.shellEnv(row(session), 424242);
      const agent = await agentToken(session);
      const blob = JSON.stringify(env);
      console.log(
        `env-keys ${Object.keys(env ?? {})
          .sort()
          .join(",")}`,
      );
      console.log(
        `env-has-onecli-token ${blob.includes(agent.accessToken.reveal()) ? "yes" : "no"}`,
      );
      console.log(
        `env-has-onecli-gateway ${blob.includes(new URL(config.onecli.gateway).host) ? "yes" : "no"}`,
      );
      console.log(`env-proxy ${new URL(env.HTTPS_PROXY).host}`);
      console.log(`agent ${agent.id}`);
      // A second credentialed host that echoes headers, so the smoke test can see what an origin receives.
      const name = secretName(session, "echo", config.repos.namePrefix);
      const value = `smoke-credential-${randomBytes(6).toString("hex")}`;
      const id = await onecli.ensureSecret({
        name,
        value,
        hostPattern: echoHost,
        header: "X-Smoke-Credential",
        valueFormat: "{value}",
      });
      await onecli.grantSecret(agent.id, id);
      await ensureSessionOneCliRules(pool, session, [echoHost]);
      console.log(`echo-credential ${value}`);
      break;
    }
    case "absent": {
      let text = "";
      for await (const chunk of process.stdin) text += chunk;
      const oc = (await agentToken(session)).accessToken.reveal();
      const eg = new URL((await egress.shellEnv(row(session))).HTTPS_PROXY).password;
      console.log(`onecli-token-in-text ${text.includes(oc) ? "yes" : "no"}`);
      console.log(`egress-token-in-text ${text.includes(eg) ? "yes" : "no"}`);
      console.log(
        `proxy-authorization-in-text ${/proxy-authorization/i.test(text) ? "yes" : "no"}`,
      );
      break;
    }
    case "unbind": {
      const { deleteBinding } =
        await import("/app/node_modules/@pi-durable-k8s/session-core/dist/index.js");
      console.log(`unbound ${(await deleteBinding(pool, session)) ? "yes" : "was-absent"}`);
      break;
    }
    case "bind": {
      const agent = await agentToken(session);
      await egress.bindOneCli(row(session), agent.accessToken, ["github.com", "api.github.com"]);
      console.log("bound yes");
      break;
    }
    case "copy-binding": {
      const to = extra;
      await pool.query(
        `insert into egress.bindings (session_id, key_id, nonce, ciphertext)
         select $2, key_id, nonce, ciphertext from egress.bindings where session_id = $1
         on conflict (session_id) do update set key_id = excluded.key_id, nonce = excluded.nonce, ciphertext = excluded.ciphertext`,
        [session, to],
      );
      console.log("copied yes");
      break;
    }
    case "facts": {
      const b = await pool.query(
        "select count(*) as n from egress.bindings where session_id = $1",
        [session],
      );
      const r = await pool.query("select count(*) as n from egress.rules where session_id = $1", [
        session,
      ]);
      const p = await pool.query(
        "select count(*) filter (where revoked_at is null) as live, count(*) as total from egress.principals where session_id = $1",
        [session],
      );
      console.log(
        `bindings ${b.rows[0].n} rules ${r.rows[0].n} principal-live ${p.rows[0].live} principal-rows ${p.rows[0].total}`,
      );
      break;
    }
    case "cleanup": {
      await egress.revoke(session);
      const agents = (await onecli.listAgents()).filter(
        (a) => a.identifier === agentIdentifier(session, config.repos.namePrefix),
      );
      for (const a of agents) await onecli.deleteAgent(a.id);
      const names = new Set(
        ["git", "api", "echo"].map((s) => secretName(session, s, config.repos.namePrefix)),
      );
      for (const s of (await onecli.listSecrets()).filter((x) => names.has(x.name)))
        await onecli.deleteSecret(s.id);
      console.log("cleaned yes");
      break;
    }
    default:
      throw new Error(`unknown command ${String(command)}`);
  }
} finally {
  await pool.end();
}
