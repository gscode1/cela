import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// hack/kind-up.sh up to the point where it first needs a real cluster: the tool and version checks, the argument and image
// reference handling, and the kind create call. Fake docker, kind, helm and kubectl log their calls. The install itself
// (hack/install.sh, hack/agent-sandbox.sh) has its own tests; a live run is the kind workflow.
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "hack/kind-up.sh");

let dir: string;
const fake = (name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kind-up-"));
  fake(
    "docker",
    `printf 'docker %s\\n' "$*" >>"$FAKE_LOG"
[[ $1 == manifest ]] && exit "\${FAKE_MANIFEST_RC:-0}"
exit 0`,
  );
  fake(
    "kind",
    `printf 'kind %s\\n' "$*" >>"$FAKE_LOG"
case "$1" in
  version) echo "kind v\${FAKE_KIND_VERSION:-0.33.0} go1.27.1 linux/amd64" ;;
  get) printf '%s' "\${FAKE_CLUSTERS:-}" ;;
esac
exit 0`,
  );
  fake(
    "helm",
    `printf 'helm %s\\n' "$*" >>"$FAKE_LOG"
echo v4.3.1+gfake`,
  );
  // `get nodes` fails: the script stops right after the cluster is created, before anything is installed.
  fake(
    "kubectl",
    `printf 'kubectl %s\\n' "$*" >>"$FAKE_LOG"
[[ $* == *"version --client"* ]] && echo '"gitVersion": "v1.36.1",'
[[ $* == *"get nodes"* ]] && exit 1
exit 0`,
  );
  fake("curl", "exit 0");
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
      ...env,
    },
  });
const log = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "");

describe("hack/kind-up.sh", () => {
  it("refuses a kind older than 0.24 before it creates anything", () => {
    const r = run([], { FAKE_KIND_VERSION: "0.23.0", IMAGE_TAG: "t" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("kind 0.23.0 is too old");
    expect(log()).not.toContain("kind create");
  });

  it("accepts kind 0.24.0 and newer", () => {
    for (const version of ["0.24.0", "0.33.0", "1.0.0"]) {
      const r = run([], { FAKE_KIND_VERSION: version, IMAGE_TAG: "t" });
      expect(r.stderr).not.toContain("too old");
    }
  });

  it("rejects an unknown flag and a bad cluster name with the usage exit code", () => {
    expect(run(["--bogus"]).status).toBe(64);
    expect(run(["--name", "Bad_Name"]).status).toBe(1);
    expect(run(["--name"]).status).toBe(64);
  });

  it("stops before the cluster is created when an image cannot be pulled", () => {
    const r = run([], { IMAGE_TAG: "nope", FAKE_MANIFEST_RC: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot be pulled");
    expect(r.stderr).toContain("--build");
    expect(log()).not.toContain("kind create");
  });

  it("rejects an image reference with neither a tag nor a digest", () => {
    const r = run([], { ORCH_IMAGE: "ghcr.io/example/pi-orchestrator", IMAGE_TAG: "t" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bad image reference");
  });

  it("checks the default tag of every image and creates the cluster from the pinned config, with its own context", () => {
    const r = run(["--name", "demo"], {
      IMAGE_TAG: "1.2.3-abc",
      INGEST_IMAGE: "registry.local:5000/pi-ingest@sha256:" + "a".repeat(64),
    });
    expect(r.stderr).toContain("cannot reach the cluster through context kind-demo");
    const calls = log();
    expect(calls).toContain("docker manifest inspect ghcr.io/gscode1/pi-orchestrator:1.2.3-abc");
    expect(calls).toContain("docker manifest inspect ghcr.io/gscode1/pi-sandbox:1.2.3-abc");
    expect(calls).toContain(
      `docker manifest inspect registry.local:5000/pi-ingest@sha256:${"a".repeat(64)}`,
    );
    expect(calls).toMatch(
      /^kind create cluster --name demo --config .*hack\/kind-config\.yaml --wait 180s$/m,
    );
    // The current context of the user's kubeconfig is never used.
    for (const line of calls
      .split("\n")
      .filter((l) => l.startsWith("kubectl") && !l.includes("version --client"))) {
      expect(line).toContain("--context kind-demo");
    }
  });

  it("reuses an existing cluster of that name", () => {
    run(["--name", "demo"], { IMAGE_TAG: "t", FAKE_CLUSTERS: "demo\nother\n" });
    expect(log()).not.toContain("kind create");
  });
});

describe("hack/kind-down.sh", () => {
  const down = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(root, "hack/kind-down.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FAKE_LOG: join(dir, "log"),
        ...env,
      },
    });

  it("deletes only the named cluster, and nothing when it does not exist", () => {
    expect(down(["--name", "demo"], { FAKE_CLUSTERS: "demo\nother\n" }).status).toBe(0);
    expect(log()).toContain("kind delete cluster --name demo");
    rmSync(join(dir, "log"));
    expect(down([], { FAKE_CLUSTERS: "other\n" }).status).toBe(0);
    expect(log()).not.toContain("kind delete");
  });
});

describe("kind values and workflow", () => {
  it("keep the invariants the smoke test and the docs rely on", () => {
    const values = readFileSync(join(root, "charts/pi-durable/values-kind.yaml"), "utf8");
    expect(values).toMatch(/^ {2}runtimeClassName: ""/m);
    expect(values).toMatch(/^ {2}allowInsecureRuntime: true/m);
    expect(values).toMatch(/^ {2}provider: standard/m);
    expect(values).toMatch(/^ {2}mode: disabled/m);
    const workflow = readFileSync(join(root, ".github/workflows/kind.yml"), "utf8");
    // Every action is pinned by full commit SHA.
    for (const use of workflow.matchAll(/uses: (\S+)/g)) expect(use[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("sha256sum --check");
  });
});
