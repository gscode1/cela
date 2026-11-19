import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// hack/onecli.sh (the bundled OneCLI step), and the way hack/install.sh and hack/kind-up.sh call it. Fake kubectl and helm
// log their calls; no cluster is touched. The bootstrap itself has its own test (onecli-bootstrap.test.ts): here its
// port-forward fails at once, which ends the script after the helm calls.
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "hack/onecli.sh");

let dir: string;
const fake = (name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "onecli-install-"));
  // FAKE_NS: "yes" when the namespace exists. FAKE_SECRETS: the Secrets that exist.
  fake(
    "kubectl",
    `printf 'kubectl %s\\n' "$*" >>"$FAKE_LOG"
args=("$@")
[[ $1 == --context=* ]] && shift
[[ $1 == --context ]] && shift 2
[[ $1 == -n ]] && shift 2
case "$1 $2" in
  "get namespace") [[ \${FAKE_NS:-yes} == yes ]] && echo "namespace/$3"; exit 0 ;;
  "get secret")
    if [[ " $* " == *" -o name "* ]]; then for s in $FAKE_SECRETS; do [[ $s == "$3" ]] && echo "secret/$3"; done; exit 0; fi
    printf 'fake-db-password' | base64; exit 0 ;;
  "create secret")
    name=$4
    for a in "\${args[@]}"; do case "$a" in --from-file=*) f=\${a##*=}; k=\${a#--from-file=}; k=\${k%%=*}; cp "$f" "$FAKE_DIR/secret-$name-$k";; esac; done
    exit 0 ;;
  "port-forward svc/onecli-api") echo "fake: no cluster" >&2; exit 1 ;;
esac
exit 0`,
  );
  fake("helm", `printf 'helm %s\\n' "$*" >>"$FAKE_LOG"`);
  writeFileSync(join(dir, "log"), "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_LOG: join(dir, "log"),
      FAKE_DIR: dir,
      FAKE_SECRETS: "pi-postgres-auth",
      ...env,
    },
  });
const log = () => readFileSync(join(dir, "log"), "utf8");

describe("hack/onecli.sh", () => {
  it("installs the policies before the upstream chart, pinned by version and digest, then bootstraps", () => {
    const r = run(["--namespace", "demo"], { KUBE_CONTEXT: "kind-demo" });
    expect(r.stderr).toContain("port-forward failed"); // the bootstrap ran, last
    const calls = log().split("\n");
    const helm = calls.filter((c) => c.startsWith("helm"));
    expect(helm).toHaveLength(2);
    expect(helm[0]).toMatch(
      /upgrade --install pi-onecli .*charts\/pi-onecli --namespace demo --set release=onecli --wait/,
    );
    expect(helm[1]).toMatch(
      /upgrade --install onecli oci:\/\/ghcr\.io\/onecli\/charts\/onecli:2\.20\.0@sha256:[0-9a-f]{64} --namespace demo/,
    );
    expect(helm[1]).toContain("--values " + join(root, "charts/pi-onecli/upstream-values.yaml"));
    expect(helm[1]).toContain(
      "--set externalUrl=http://localhost:10254 --set allowInsecureExternalUrl=true",
    );
    for (const line of [...helm, ...calls.filter((c) => c.startsWith("kubectl"))]) {
      if (line.startsWith("helm")) expect(line).toContain("--kube-context=kind-demo");
      else expect(line).toMatch(/--context[= ]kind-demo/);
    }
    expect(calls.findIndex((c) => c.includes("pi-onecli "))).toBeLessThan(
      calls.findIndex((c) => c.includes("oci://")),
    );
  });

  describe("open defaults and the egress proxy (ADR 0043)", () => {
    const calls = () =>
      log()
        .split("\n")
        .filter((c) => c.startsWith("helm"));

    it("installs the open values by default: nothing is set against the chart's and the upstream's defaults", () => {
      run(["--namespace", "demo"]);
      for (const c of calls()) expect(c).not.toMatch(/privateHttps|allowPrivateDestinations/);
      const values = readFileSync(join(root, "charts/pi-onecli/upstream-values.yaml"), "utf8");
      expect(values).toMatch(
        /allowPrivateDestinations: "10\.0\.0\.0\/8,172\.16\.0\.0\/12,192\.168\.0\.0\/16"/,
      );
    });

    it("installs the hardened values with --egress-proxy off: no private rule, no private destinations", () => {
      const r = run(["--namespace", "demo", "--egress-proxy", "off"]);
      const [policies, upstream] = calls();
      expect(policies).toContain("--set gateway.privateHttps.enabled=false");
      expect(upstream).toContain("--set gateway.allowPrivateDestinations= ");
      expect(r.stderr).toContain("HARDENED");
    });

    it("keeps the open values with --egress-proxy off only when --allow-open-without-proxy says so", () => {
      const r = run(["--namespace", "demo", "--egress-proxy", "off", "--allow-open-without-proxy"]);
      for (const c of calls()) expect(c).not.toMatch(/privateHttps|allowPrivateDestinations/);
      expect(r.stderr).toContain("stay OPEN");
    });

    it("rejects a bad --egress-proxy", () => {
      expect(run(["--egress-proxy", "maybe"]).stderr).toContain("bad --egress-proxy");
    });
  });

  it("creates the database URL and the three application keys once, and never prints a value", () => {
    const r = run(["--namespace", "demo"]);
    const uri = readFileSync(join(dir, "secret-onecli-database-DATABASE_URL"), "utf8");
    expect(uri).toBe("postgresql://onecli:fake-db-password@pi-postgres.demo.svc:5432/onecli");
    for (const key of ["BETTER_AUTH_SECRET", "SECRET_ENCRYPTION_KEY", "GATEWAY_INTERNAL_SECRET"]) {
      const value = readFileSync(join(dir, `secret-onecli-secrets-${key}`), "utf8");
      expect(value.length).toBeGreaterThanOrEqual(40);
      expect(r.stdout + r.stderr).not.toContain(value);
    }
    expect(r.stdout + r.stderr).not.toContain("fake-db-password");
  });

  it("keeps Secrets that exist, so a second run never regenerates the encryption key", () => {
    const r = run(["--namespace", "demo"], {
      FAKE_SECRETS: "pi-postgres-auth onecli-database onecli-secrets",
    });
    expect(r.stdout).toContain("onecli-secrets: exists, kept");
    expect(log()).not.toContain("create secret");
    expect(existsSync(join(dir, "secret-onecli-secrets-BETTER_AUTH_SECRET"))).toBe(false);
  });

  it("takes the database from ONECLI_DATABASE_URL, or stops when there is none", () => {
    run(["--namespace", "demo"], {
      FAKE_SECRETS: "",
      ONECLI_DATABASE_URL: "postgres://u:p@db.example:5432/onecli",
    });
    expect(readFileSync(join(dir, "secret-onecli-database-DATABASE_URL"), "utf8")).toBe(
      "postgres://u:p@db.example:5432/onecli",
    );
    rmSync(join(dir, "secret-onecli-database-DATABASE_URL"));
    const none = run(["--namespace", "demo"], { FAKE_SECRETS: "" });
    expect(none.status).toBe(1);
    expect(none.stderr).toContain("no database for OneCLI");
    const bad = run(["--namespace", "demo"], {
      FAKE_SECRETS: "",
      ONECLI_DATABASE_URL: "mysql://x",
    });
    expect(bad.stderr).toContain("postgres:// URI");
  });

  it("accepts an http externalUrl only for localhost, and passes an https one without the insecure flag", () => {
    const refused = run(["--external-url", "http://onecli.example.com"]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("only accepted for localhost");
    run(["--namespace", "demo", "--external-url", "https://onecli.example.com"]);
    expect(log()).toContain(
      "--set externalUrl=https://onecli.example.com --set allowInsecureExternalUrl=false",
    );
    expect(run(["--external-url", "https://x.example/path"]).stderr).toContain(
      "bad --external-url",
    );
  });

  it("stops before it installs anything when the namespace does not exist", () => {
    const r = run(["--namespace", "demo"], { FAKE_NS: "no" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not exist");
    expect(log()).not.toContain("helm");
  });

  it("rejects unknown flags and bad names with the usage exit code or an error", () => {
    expect(run(["--bogus"]).status).toBe(64);
    expect(run(["--namespace"]).status).toBe(64);
    expect(run(["--namespace", "Bad_NS"]).status).toBe(1);
    expect(run(["--release", "Bad_Release"]).status).toBe(1);
  });

  it("pins the same chart version and digest in the docs", () => {
    const text = readFileSync(script, "utf8");
    const version = /^onecli_version=(\S+)/m.exec(text)?.[1];
    const digest = /^onecli_digest=(sha256:[0-9a-f]{64})/m.exec(text)?.[1];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(digest).toBeDefined();
    const adr = readFileSync(join(root, "docs/decisions/0022-bundled-onecli.md"), "utf8");
    expect(adr).toContain(version ?? "?");
    expect(adr).toContain(digest ?? "?");
    expect(readFileSync(join(root, "charts/pi-onecli/Chart.yaml"), "utf8")).toContain(
      `appVersion: "${version ?? "?"}"`,
    );
  });
});

describe("hack/install.sh and hack/kind-up.sh", () => {
  const install = readFileSync(join(root, "hack/install.sh"), "utf8");
  const kindUp = readFileSync(join(root, "hack/kind-up.sh"), "utf8");

  it("run the OneCLI step before the chart, only for onecli.mode=bundled", () => {
    expect(install.indexOf("hack/onecli.sh")).toBeGreaterThan(0);
    expect(install.indexOf('"$root/hack/onecli.sh"')).toBeLessThan(
      install.indexOf("helm ${ctx:+--kube-context"),
    );
    expect(install).toContain("if [[ $onecli_mode == bundled ]]");
  });

  it("make --onecli add exactly onecli.mode=bundled to the install", () => {
    expect(kindUp).toContain("--set onecli.mode=bundled");
    expect(kindUp).toMatch(/--onecli\) onecli=1/);
    // The default install still has OneCLI disabled.
    expect(readFileSync(join(root, "charts/pi-durable/values-kind.yaml"), "utf8")).toMatch(
      /^ {2}mode: disabled/m,
    );
  });
});
