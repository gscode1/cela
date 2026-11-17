import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      FAKE_SECRETS: (o.secrets ?? ["db-uri"]).join(" "),
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
      /^helm upgrade --install pi-durable .*charts\/pi-durable --namespace demo --values .*values\.yaml --wait --timeout 10m$/m,
    );
    expect(calls).not.toContain("--create-namespace");
    expect(calls).toMatch(/get --raw \/apis\/agents\.x-k8s\.io\/v1beta1/);
    expect(calls).toMatch(/rollout status deployment\.apps\/pi-orchestrator/);
    expect(r.stdout).toContain("shard 0 configuredRuntime=gvisor");
  });

  it("never prints a secret value", () => {
    const r = run(base(), {
      env: { DATABASE_URL: "postgres://u:hunter2secret@db/app" },
      secrets: [],
    });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout + r.stderr + log();
    expect(out).not.toContain("hunter2secret");
    expect(out).not.toContain(file("secret-sandboxd-auth"));
    for (const t of file("secret-api-auth").split("\n"))
      expect(out).not.toContain(t.split(":")[1] ?? "x");
    expect(file("secret-db-uri")).toBe("postgres://u:hunter2secret@db/app");
    expect(file("secret-db-uri.arg")).toContain("--from-file=uri=");
  });

  it("keeps existing Secrets and an existing namespace, and changes nothing about them", () => {
    const r = run(base(), { ns: "yes", secrets: ["db-uri", "sandboxd-auth", "api-auth"] });
    expect(r.status, r.stderr).toBe(0);
    expect(log()).not.toMatch(/create secret|apply -f -|delete|replace|patch/);
    expect(r.stdout).toContain("sandboxd-auth: exists, kept");
    expect(r.stdout).toContain("api-auth: exists, kept");
  });

  it("warns when an admin has no token, and when the namespace does not enforce restricted", () => {
    const r = run(base(), {
      ns: "yes",
      secrets: ["db-uri", "sandboxd-auth", "api-auth"],
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
    expect(r.stderr).toContain("network policy is not-enforced");
    expect(log()).toContain("runtimeClassName=runc");
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
});
