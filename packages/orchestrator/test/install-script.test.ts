import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// hack/install.sh against a fake kubectl and a fake helm (the real one renders, the fake one logs the install). No
// cluster is touched. The rendering uses the real chart, so a rename in the chart that install.sh reads fails here.
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "hack/install.sh");
const realHelm = spawnSync("sh", ["-c", "command -v helm"], { encoding: "utf8" }).stdout.trim();

let dir: string;
let valuesFile: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-"));
  valuesFile = join(dir, "values.yaml");
  writeFileSync(
    valuesFile,
    [
      "images:",
      "  orchestrator: { tag: t }",
      "  ingest: { tag: t }",
      "  sandbox: { tag: t }",
      "  sandboxBrowser: { tag: t }",
      "  egressProxy: { tag: t }",
      "database:",
      "  external:",
      "    existingSecret: db-uri",
      "    egress: { podSelector: { app: db } }",
      "api: { admins: [root, ops] }",
      "",
    ].join("\n"),
  );
  // FAKE_NS: "yes" when the namespace exists. FAKE_SECRETS: Secrets that exist. FAKE_OWNERS: owners in api-auth.
  // FAKE_STATUS / FAKE_STATUS_RC: what `kubectl exec` prints and returns. Every call is logged; `create secret` and
  // `apply -f -` also copy their inputs to files so the tests can check what was written.
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_LOG"
args=("$@")
if [[ $1 == --context ]]; then shift 2; elif [[ $1 == --context=* ]]; then shift; fi
if [[ $1 == -n ]]; then shift 2; fi
case "$1 $2" in
  "get namespace")
    if [[ " $* " == *" -o name "* ]]; then [[ $FAKE_NS == yes ]] && echo "namespace/$3"; exit 0; fi
    echo "\${FAKE_PSA:-restricted}"; exit 0 ;;
  "apply -f") cat >"$FAKE_DIR/applied.yaml"; exit 0 ;;
  "get secret")
    if [[ " $* " == *" -o name "* ]]; then
      for s in $FAKE_SECRETS; do [[ $s == "$3" ]] && echo "secret/$3"; done; exit 0
    fi
    printf '%s' "$FAKE_OWNERS" | sed 's/$/:x/' | base64; exit 0 ;;
  "create secret")
    name=\${4}; for a in "\${args[@]}"; do case "$a" in --from-file=*) f=\${a##*=}; cp "$f" "$FAKE_DIR/secret-$name"; echo "$a" >>"$FAKE_DIR/secret-$name.arg";; esac; done
    exit 0 ;;
  "get deployments")
    if [[ " $* " == *" -A "* ]]; then echo 1; else echo deployment.apps/pi-ingest; echo deployment.apps/pi-orchestrator; fi; exit 0 ;;
  "get --raw")
    echo '{"resources":[{"name":"sandboxes"},{"name":"sandboxclaims"},{"name":"sandboxtemplates"},{"name":"sandboxwarmpools"}]}'; exit 0 ;;
  "port-forward svc/pi-ingest") echo "Forwarding from 127.0.0.1:18999 -> 8080"; exit 0 ;;
  "exec deploy/pi-ingest")
    printf '%s' "$FAKE_STATUS"; exit "\${FAKE_STATUS_RC:-0}" ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "helm"),
    `#!/usr/bin/env bash
printf 'helm %s\\n' "$*" >>"$FAKE_LOG"
if [[ $1 == --kube-context* ]]; then shift; fi
if [[ $1 == template ]]; then exec "$REAL_HELM" "$@"; fi
exit 0
`,
  );
  // The seed script itself is tested below against a fake API; here only whether and how install.sh calls it.
  writeFileSync(
    join(dir, "node"),
    `#!/usr/bin/env bash
printf 'node %s url=%s token=%s\\n' "$*" "$PI_API_URL" "$PI_API_TOKEN" >>"$FAKE_LOG"
exit "\${FAKE_SEED_RC:-0}"
`,
  );
  chmodSync(join(dir, "node"), 0o755);
  chmodSync(join(dir, "kubectl"), 0o755);
  chmodSync(join(dir, "helm"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const gvisorStatus =
  "shard 0 configuredRuntime=gvisor observedRuntime=gvisor networkPolicy=unknown\n";
interface Opts {
  ns?: string;
  secrets?: string[];
  owners?: string;
  status?: string;
  statusRc?: number;
  env?: Record<string, string>;
}
const run = (args: string[], o: Opts = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      REAL_HELM: realHelm,
      FAKE_DIR: dir,
      FAKE_LOG: join(dir, "log"),
      FAKE_NS: o.ns ?? "no",
      FAKE_SECRETS: (o.secrets ?? ["db-uri", "pi-egress-database"]).join(" "),
      FAKE_OWNERS: o.owners ?? "root\nops",
      FAKE_STATUS: o.status ?? gvisorStatus,
      FAKE_STATUS_RC: String(o.statusRc ?? 0),
      KUBE_CONTEXT: "",
      ...o.env,
    },
  });
const log = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "");
const file = (name: string) => readFileSync(join(dir, name), "utf8");
const base = () => ["--namespace", "demo", "--values", valuesFile];
const externalOnecli = [
  "--set",
  "onecli.mode=external",
  "--set",
  "onecli.external.apiUrl=http://onecli.onecli:10256",
  "--set",
  "onecli.external.gatewayUrl=http://onecli.onecli:10255",
];

describe("hack/install.sh", () => {
  it("creates the namespace with the restricted Pod Security labels, the missing Secrets, then installs", () => {
    const r = run(base());
    expect(r.status, r.stderr).toBe(0);
    const ns = file("applied.yaml");
    for (const level of ["enforce", "warn", "audit"]) {
      expect(ns).toContain(`pod-security.kubernetes.io/${level}: restricted`);
      expect(ns).toContain(`pod-security.kubernetes.io/${level}-version: v1.36`);
    }
    expect(ns).toContain("name: demo");
    expect(file("secret-sandboxd-auth")).toMatch(/^[0-9a-f]{64}$/);
    expect(file("secret-sandboxd-auth.arg")).toContain("--from-file=master=");
    const tokens = file("secret-api-auth").split("\n");
    expect(tokens.map((t) => t.split(":")[0])).toEqual(["root", "ops"]);
    for (const t of tokens) expect(t.split(":")[1]).toMatch(/^[0-9a-f]{64}$/);
    const calls = log();
    expect(calls.indexOf("create secret generic sandboxd-auth")).toBeLessThan(
      calls.indexOf("helm upgrade"),
    );
    expect(calls).toMatch(
      /^helm upgrade --install cela .*charts\/cela --namespace demo --values .*values\.yaml --wait --timeout 10m$/m,
    );
    expect(calls).not.toContain("--create-namespace");
    expect(calls).toMatch(/get --raw \/apis\/agents\.x-k8s\.io\/v1beta1/);
    expect(calls).toMatch(/rollout status deployment\.apps\/pi-orchestrator/);
    expect(r.stdout).toContain("shard 0 configuredRuntime=gvisor");
  });

  it("never prints a secret value", () => {
    const r = run([...base(), ...externalOnecli], {
      env: {
        DATABASE_URL: "postgres://u:hunter2secret@db/app",
        EGRESS_DATABASE_URL: "postgres://pi_egress:hunter3secret@db/app",
      },
      secrets: [],
    });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr + log();
    expect(out).not.toContain("hunter2secret");
    expect(out).not.toContain("hunter3secret");
    expect(out).not.toContain(file("secret-pi-egress-binding"));
    expect(out).not.toContain(file("secret-sandboxd-auth"));
    for (const t of file("secret-api-auth").split("\n"))
      expect(out).not.toContain(t.split(":")[1] ?? "x");
    expect(file("secret-db-uri")).toBe("postgres://u:hunter2secret@db/app");
    expect(file("secret-db-uri.arg")).toContain("--from-file=uri=");
  });

  it("keeps existing Secrets and an existing namespace, and changes nothing about them", () => {
    const r = run([...base(), ...externalOnecli], {
      ns: "yes",
      secrets: ["db-uri", "sandboxd-auth", "api-auth", "pi-egress-database", "pi-egress-binding"],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toMatch(/create secret|apply -f -|delete|replace|patch/);
    expect(r.stdout).toContain("sandboxd-auth: exists, kept");
    expect(r.stdout).toContain("api-auth: exists, kept");
    expect(r.stdout).toContain("pi-egress-binding: exists, kept");
  });

  it("warns when an admin has no token, and when the namespace does not enforce restricted", () => {
    const r = run(base(), {
      ns: "yes",
      secrets: ["db-uri", "sandboxd-auth", "api-auth", "pi-egress-database"],
      owners: "root",
      env: { FAKE_PSA: "baseline" },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("no token for api.admins entry 'ops'");
    expect(r.stderr).toContain("does not enforce Pod Security 'restricted'");
    expect(log()).not.toMatch(/^(-n \S+ )?(label|patch|annotate)\b/m);
  });

  it("stops before installing when the database Secret is missing", () => {
    const r = run(base(), { secrets: [] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Secret db-uri");
    expect(log()).not.toContain("helm upgrade");
  });

  it("stops before installing when the egress proxy's database Secret is missing, and names the opt-out", () => {
    const r = run(base(), { secrets: ["db-uri"] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Secret pi-egress-database");
    expect(r.stderr).toContain("auth.egressReader.enabled=true");
    expect(r.stderr).toContain("--set egressProxy.enabled=false");
    expect(log()).not.toContain("helm upgrade");
    expect(log()).not.toContain("create secret generic pi-egress-database");
  });

  it("creates the egress proxy's database Secret from EGRESS_DATABASE_URL, and only from a postgres URI", () => {
    const uri = "postgres://pi_egress:pw@db/app";
    const r = run(base(), { secrets: ["db-uri"], env: { EGRESS_DATABASE_URL: uri } });
    expect(r.status, r.stderr).toBe(0);
    expect(file("secret-pi-egress-database")).toBe(uri);
    expect(file("secret-pi-egress-database.arg")).toContain("--from-file=uri=");
    expect(log()).toContain("--values");
    const bad = run(base(), { secrets: ["db-uri"], env: { EGRESS_DATABASE_URL: "mysql://x" } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("EGRESS_DATABASE_URL must be a postgres:// URI");
  });

  it("creates the binding key only when the chart mounts it (proxy and OneCLI)", () => {
    let r = run(base());
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toContain("pi-egress-binding");
    r = run([...base(), ...externalOnecli]);
    expect(r.status, r.stderr).toBe(0);
    // 32 random bytes, base64 (ADR 0037).
    expect(file("secret-pi-egress-binding")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(file("secret-pi-egress-binding.arg")).toContain("--from-file=key=");
  });

  it("follows Secret names from the user's values over its own defaults", () => {
    const r = run(
      [
        ...base(),
        ...externalOnecli,
        "--set",
        "egressProxy.database.existingSecret=my-egress-db",
        "--set",
        "egressProxy.binding.existingSecret=my-binding",
      ],
      { secrets: ["db-uri", "my-egress-db"] },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("my-egress-db: exists");
    expect(file("secret-my-binding")).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(log()).not.toMatch(/create secret generic pi-egress-/);
  });

  it("installs without the proxy and its Secrets when the user opts out", () => {
    const r = run([...base(), ...externalOnecli, "--set", "egressProxy.enabled=false"], {
      secrets: ["db-uri"],
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("egress proxy: off");
    expect(log()).not.toMatch(/pi-egress-/);
    expect(log()).toContain("egressProxy.enabled=false");
  });

  describe("bundled OneCLI follows the egress proxy (ADR 0043)", () => {
    // The fake kubectl has no cluster to port-forward to, so the bootstrap at the end of hack/onecli.sh fails: only the helm
    // calls before it matter here.
    const bundled = () => [...base(), "--set", "onecli.mode=bundled"];
    const opts = {
      ns: "yes",
      secrets: ["db-uri", "pi-egress-database", "onecli-database", "onecli-secrets"],
    };
    const onecliHelm = () =>
      log()
        .split("\n")
        .filter((l) => /^helm .*upgrade --install (pi-onecli|onecli) /.test(l));

    it("installs OneCLI open when the release has the egress proxy", () => {
      run(bundled(), opts);
      const calls = onecliHelm();
      expect(calls).toHaveLength(2);
      for (const call of calls) expect(call).not.toMatch(/privateHttps|allowPrivateDestinations/);
    });

    it("installs OneCLI hardened when the release has no proxy", () => {
      const r = run([...bundled(), "--set", "egressProxy.enabled=false"], {
        ...opts,
        secrets: ["db-uri", "onecli-database", "onecli-secrets"],
      });
      const [policies, upstream] = onecliHelm();
      expect(policies).toContain("--set gateway.privateHttps.enabled=false");
      expect(upstream).toContain("--set gateway.allowPrivateDestinations= ");
      expect(r.stderr).toContain("HARDENED");
    });

    it("keeps it open without a proxy only when the operator acknowledges it", () => {
      const r = run(
        [...bundled(), "--set", "egressProxy.enabled=false", "--onecli-allow-open-without-proxy"],
        {
          ...opts,
          secrets: ["db-uri", "onecli-database", "onecli-secrets"],
        },
      );
      for (const call of onecliHelm())
        expect(call).not.toMatch(/privateHttps|allowPrivateDestinations/);
      expect(r.stderr).toContain("stay OPEN");
    });
  });

  it("rejects a DATABASE_URL that is not a postgres URI", () => {
    const r = run(base(), { secrets: [], env: { DATABASE_URL: "mysql://x" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("postgres://");
  });

  it("does not touch the cluster when the chart does not render", () => {
    const r = run([
      "--namespace",
      "demo",
      "--values",
      valuesFile,
      "--set",
      "sandbox.runtimeClassName=runc",
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not render");
    expect(log()).not.toMatch(/kubectl|get namespace|apply|create|helm upgrade/);
  });

  it("warns, and still succeeds, for a runtime that is not gvisor and a network policy that is not enforced", () => {
    const r = run(
      [
        ...base(),
        "--set",
        "sandbox.runtimeClassName=runc",
        "--set",
        "security.allowInsecureRuntime=true",
      ],
      {
        status: "shard 0 configuredRuntime=runc observedRuntime=runc networkPolicy=not-enforced\n",
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("not gVisor");
    expect(r.stderr).toContain("network policy is NOT ENFORCED");
    expect(log()).toContain("runtimeClassName=runc");
  });

  it("prints a line per named runtime, and warns about an insecure or mismatched one without failing", () => {
    const r = run(base(), {
      status:
        gvisorStatus.replace("unknown", "enforced") +
        "runtime shard=0 name=gvisorkvm configuredRuntime=gvisor-kvm observedRuntime=gvisor-kvm insecure=false\n" +
        "runtime shard=0 name=runc configuredRuntime=runc-sandbox observedRuntime=gvisor insecure=true\n",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("runtime shard=0 name=gvisorkvm configuredRuntime=gvisor-kvm");
    expect(r.stderr).toContain(
      "sandbox runtime runc on shard 0 runs with runc-sandbox, not gVisor",
    );
    expect(r.stderr).toContain("was observed with gvisor, configured runc-sandbox");
    expect(r.stderr).not.toContain("runtime gvisorkvm");
  });

  it("prints the probe line, and does not warn when the probe says enforced", () => {
    const r = run(base(), {
      status:
        "shard 0 configuredRuntime=gvisor observedRuntime=gvisor networkPolicy=enforced\nisolation-probe state=enforced checkedAt=now reason=ok\n",
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("isolation-probe state=enforced");
    expect(r.stderr).not.toContain("network policy");
  });

  it("asks the status reader to wait for the isolation probe", () => {
    expect(readFileSync(script, "utf8")).toMatch(/isolation probe has not finished/);
  });

  it("warns about an unknown network policy state even with gvisor", () => {
    const r = run(base());
    expect(r.stderr).toContain("network policy is unknown");
    expect(r.stderr).not.toContain("not gVisor");
  });

  it("fails when /admin/status cannot be read, after the install", () => {
    const r = run(base(), { statusRc: 2, status: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not read GET /admin/status");
    expect(log()).toContain("helm upgrade");
  });

  it("passes KUBE_CONTEXT to kubectl and helm", () => {
    const r = run(base(), { env: { KUBE_CONTEXT: "ctx-a" } });
    expect(r.status, r.stderr).toBe(0);
    const calls = log()
      .split("\n")
      .filter((l) => /^(helm |-n |get |apply |create |--context)/.test(l));
    expect(calls.length).toBeGreaterThan(8);
    for (const line of calls) {
      expect(line, line).toMatch(
        /^(helm --kube-context=ctx-a |--context=ctx-a |--context ctx-a |helm template)/,
      );
    }
  });

  it("asks for values and rejects bad names", () => {
    expect(run([]).status).toBe(64);
    expect(run(["--namespace", "Bad_NS", "--values", valuesFile]).status).toBe(1);
    expect(run(["--values", join(dir, "missing.yaml")]).status).toBe(1);
    expect(log()).not.toMatch(/get namespace/);
  });

  describe("browser profile seed (step 7)", () => {
    const seedCalls = () =>
      log()
        .split("\n")
        .filter((l) => l.startsWith("node "));
    const noBrowser = ["--set", "sandbox.flavours.browser.enabled=false"];

    it("seeds create-only through a port-forward with the first admin's token when the browser flavour is on", () => {
      const r = run(base());
      expect(r.status, r.stderr).toBe(0);
      expect(seedCalls()).toHaveLength(1);
      expect(seedCalls()[0]).toContain("seed-browser-profile.mjs --create-only");
      expect(seedCalls()[0]).toContain("url=http://127.0.0.1:18999 token=x");
      // the token is never printed
      expect(r.stdout + r.stderr).not.toMatch(/token=x/);
      expect(log().indexOf("helm upgrade")).toBeLessThan(log().indexOf("node "));
    });

    it("does not seed when the browser flavour is off", () => {
      const r = run([...base(), ...noBrowser]);
      expect(r.status, r.stderr).toBe(0);
      expect(seedCalls()).toHaveLength(0);
      expect(r.stdout).toContain("the browser flavour is off");
    });

    it("does not seed with --no-seed-browser-profile", () => {
      const r = run([...base(), "--no-seed-browser-profile"]);
      expect(r.status, r.stderr).toBe(0);
      expect(seedCalls()).toHaveLength(0);
      expect(r.stdout).toContain("skipped: --no-seed-browser-profile");
    });

    it("skips with a note, and still succeeds, when api-auth has no token for any admin", () => {
      const r = run(base(), {
        secrets: ["db-uri", "pi-egress-database", "api-auth"],
        owners: "other",
      });
      expect(r.status, r.stderr).toBe(0);
      expect(seedCalls()).toHaveLength(0);
      expect(r.stdout).toContain("api-auth has no token for any api.admins entry");
    });

    it("warns but does not fail the install when the seed fails", () => {
      const r = run(base(), { env: { FAKE_SEED_RC: "1" } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("the browser profile was not seeded");
    });
  });
});

// hack/seed-browser-profile.mjs against a fake admin API: create-only never changes what exists.
describe("hack/seed-browser-profile.mjs --create-only", () => {
  const seed = join(root, "hack/seed-browser-profile.mjs");
  const serve = async (hasProfile: boolean, hasSkills: boolean) => {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(`${req.method ?? ""} ${req.url ?? ""}`);
      req.resume();
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const url = req.url ?? "";
      if (req.method === "GET" && url.startsWith("/admin/profiles/")) {
        if (hasProfile) send(200, { currentVersion: 7, revision: 7 });
        else send(404, {});
      } else if (req.method === "GET" && url.startsWith("/admin/skills/")) {
        if (hasSkills) send(200, { currentVersion: 3 });
        else send(404, {});
      } else if (req.method === "POST") send(201, { version: 1 });
      else if (req.method === "PUT") send(201, { currentVersion: 1, versionCreated: true });
      else send(500, {});
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;
    const run = () =>
      new Promise<{ code: number | null; out: string }>((ok) => {
        const child = spawn("node", [seed, "--create-only"], {
          env: {
            ...process.env,
            PI_API_URL: `http://127.0.0.1:${String(port)}`,
            PI_API_TOKEN: "t",
          },
        });
        let out = "";
        child.stdout.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr.on("data", (d: Buffer) => (out += d.toString()));
        child.on("close", (code) => ok({ code, out }));
      });
    return { requests, run, close: () => new Promise<void>((ok) => server.close(() => ok())) };
  };

  it("leaves an existing profile alone: no skill is published and no profile version is written", async () => {
    const api = await serve(true, true);
    try {
      const r = await api.run();
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("profile browser v7 exists, kept");
      expect(api.requests.filter((q) => /^(POST|PUT|DELETE)/.test(q))).toEqual([]);
    } finally {
      await api.close();
    }
  }, 20_000);

  it("creates a missing profile and missing skills, and keeps an existing skill", async () => {
    const api = await serve(false, false);
    try {
      const r = await api.run();
      expect(r.code, r.out).toBe(0);
      expect(api.requests).toContain("POST /admin/skills/patchright/versions");
      expect(api.requests).toContain("POST /admin/skills/agent-browser/versions");
      expect(api.requests).toContain("PUT /admin/profiles/browser");
    } finally {
      await api.close();
    }
    const kept = await serve(false, true);
    try {
      const r = await kept.run();
      expect(r.code, r.out).toBe(0);
      expect(r.out).toContain("skill patchright v3 exists, kept");
      expect(kept.requests.filter((q) => q.startsWith("POST"))).toEqual([]);
      expect(kept.requests).toContain("PUT /admin/profiles/browser");
    } finally {
      await kept.close();
    }
  }, 20_000);
});

// `cmd >"$log" 2>&1 &` opens the log only once the background job runs, so a poll that reads it at once (sed) can find
// no file, and errexit ends the script there. It flaked CI for install.sh (gscode1/cela#432); scheduling is not
// reproducible in a test, so every such job in hack/ must create its log first.
describe("hack/*.sh background jobs", () => {
  it("create their log file before starting the job that writes it", () => {
    const jobs: string[] = [];
    for (const name of readdirSync(join(root, "hack")).filter((n) => n.endsWith(".sh"))) {
      const lines = readFileSync(join(root, "hack", name), "utf8").split("\n");
      lines.forEach((line, index) => {
        const at = `${name}:${String(index + 1)}`;
        const log = /\s>("[^"]+") 2>&1 &\s*$/.exec(line)?.[1];
        if (log === undefined) return;
        jobs.push(at);
        const created = lines.slice(0, index).some((l) => l.trim() === `: >${log}`);
        expect(created, `${at} starts a job that writes ${log} without creating it first`).toBe(
          true,
        );
      });
    }
    expect(jobs.length).toBeGreaterThan(0);
  });
});
