import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Invariants of the per-run e2e namespace (docs/e2e.md, issue #69). No cluster is touched: kubectl is a stub.
const root = resolve(import.meta.dirname, "../../..");
const poc = "pi-durable-poc";

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

describe("nothing outside the long-lived defaults names pi-durable-poc", () => {
  // The long-lived deployment's own manifests (its namespace and the kustomizations that set it) and the reference copy
  // of the policies applied in the OneCLI namespace.
  const allowedFiles = new Set([
    "deploy/namespace.yaml",
    "deploy/kustomization.yaml",
    "deploy/cilium/kustomization.yaml",
  ]);
  const files = [...walk(join(root, "deploy")), ...walk(join(root, "tests/e2e"))]
    .map((p) => relative(root, p))
    .filter((p) => !allowedFiles.has(p) && !p.startsWith("deploy/onecli-policies/"));

  it("scans the deploy scripts, the manifests and the e2e scripts", () => {
    expect(files).toContain("deploy/push-code.sh");
    expect(files).toContain("tests/e2e/run.sh");
    expect(files).toContain("tests/e2e/driver/driver-rbac.yaml");
  });

  it("only as a comment or as the default of ${NAMESPACE:-...}", () => {
    const offenders = files.flatMap((file) =>
      readFileSync(join(root, file), "utf8")
        .split("\n")
        .map((line, i) => ({ line, at: `${file}:${String(i + 1)}` }))
        .filter(({ line }) => line.includes(poc))
        .filter(({ line }) => !line.trimStart().startsWith("#"))
        .filter(({ line }) => line.replaceAll("${NAMESPACE:-" + poc + "}", "").includes(poc))
        .map(({ line, at }) => `${at}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("tests/e2e/run.sh and sweep.sh safety", { timeout: 30_000 }, () => {
  let dir: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-ns-"));
    log = join(dir, "kubectl.log");
    chmodSync(dir, 0o700);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stub = (body: string) => {
    writeFileSync(join(dir, "kubectl"), `#!/usr/bin/env bash\necho "$*" >>"${log}"\n${body}\n`);
    chmodSync(join(dir, "kubectl"), 0o755);
  };
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(root, script), ...args], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}`, KUBE_CONTEXT: "", ...env },
    });
  const calls = () => {
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  };

  const hoursAgo = (h: number) =>
    new Date(Date.now() - h * 3600_000).toISOString().replace(/\.\d+Z$/, "Z");
  const ns = (name: string, ageHours: number) => ({
    metadata: { name, creationTimestamp: hoursAgo(ageHours), labels: { "pi-durable-e2e": "true" } },
  });

  it("sweep deletes only pi-e2e-* namespaces older than the limit, never pi-durable-poc", () => {
    const items = [
      ns("pi-e2e-old111", 9),
      ns("pi-e2e-new222", 1),
      ns(poc, 500),
      ns("kube-system", 900),
    ];
    // The real API filters on the label; the stub returns everything so the script's own name check is what is tested.
    stub(
      `case "$*" in *"get namespaces"*) cat <<'JSON'\n${JSON.stringify({ items })}\nJSON\n;; esac`,
    );
    const r = run("tests/e2e/sweep.sh", ["6"]);
    expect(r.status, r.stderr).toBe(0);
    const deletes = calls().filter((c) => c.includes("delete namespace"));
    expect(deletes).toEqual(["delete namespace pi-e2e-old111 --ignore-not-found --wait=false"]);
    expect(calls().find((c) => c.includes("get namespaces"))).toContain("-l pi-durable-e2e=true");
  });

  it("sweep with DRY_RUN=1 deletes nothing", () => {
    stub(
      `case "$*" in *"get namespaces"*) echo '${JSON.stringify({ items: [ns("pi-e2e-old111", 9)] })}' ;; esac`,
    );
    const r = run("tests/e2e/sweep.sh", ["6"], { DRY_RUN: "1" });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("would delete namespace pi-e2e-old111");
    expect(calls().filter((c) => c.includes("delete"))).toEqual([]);
  });

  it("sweep rejects a non-numeric age", () => {
    stub("exit 1");
    expect(run("tests/e2e/sweep.sh", ["soon"]).status).toBe(64);
    expect(calls()).toEqual([]);
  });

  it("run.sh refuses a RUN_ID that would not give a pi-e2e-* namespace, before any kubectl call", () => {
    stub("exit 1");
    for (const bad of ["Bad_ID", "x y", "-x", "a;b", ""].filter(Boolean)) {
      const r = run("tests/e2e/run.sh", ["smoke"], { RUN_ID: bad });
      expect(r.status, bad).toBe(64);
    }
    expect(calls()).toEqual([]);
  });
});
