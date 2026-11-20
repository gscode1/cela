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
  // FAKE_GATEWAYS: what `docker network inspect kind` prints (IPAM gateways, space separated); FAKE_PORTS: what
  // `docker port <node> 30080/tcp` prints for an existing cluster.
  fake(
    "docker",
    `printf 'docker %s\\n' "$*" >>"$FAKE_LOG"
[[ $1 == manifest ]] && exit "\${FAKE_MANIFEST_RC:-0}"
[[ $1 == network ]] && printf '%s' "\${FAKE_GATEWAYS-fc00:f853:ccd:e793::1 172.20.0.1 }"
[[ $1 == port ]] && printf '%s' "\${FAKE_PORTS:-}"
exit 0`,
  );
  fake(
    "kind",
    `printf 'kind %s\\n' "$*" >>"$FAKE_LOG"
case "$1" in
  version) echo "kind v\${FAKE_KIND_VERSION:-0.33.0} go1.27.1 linux/amd64" ;;
  get) printf '%s' "\${FAKE_CLUSTERS:-}" ;;
  create) while [[ $# -gt 0 ]]; do [[ $1 == --config ]] && cp "$2" "$FAKE_LOG.config"; shift; done ;;
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
[[ $* == *"get nodes"* ]] && exit "\${FAKE_NODES_RC:-1}"
[[ $* == *"daemonset kindnet"* ]] && printf '%s' "\${FAKE_KINDNET:-}"
[[ $* == *"daemonset cilium"* ]] && printf '%s' "\${FAKE_CILIUM:-}"
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
      // The quiet mode's log file lands in the test's temp dir.
      TMPDIR: dir,
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
    // The egress proxy is on by default (ADR 0038, amendment of 2026-11-19), so its image is checked too.
    expect(calls).toContain("docker manifest inspect ghcr.io/gscode1/pi-egress-proxy:1.2.3-abc");
    expect(calls).toContain(
      `docker manifest inspect registry.local:5000/pi-ingest@sha256:${"a".repeat(64)}`,
    );
    expect(calls).toMatch(
      /^kind create cluster --name demo --config \S+\/kind-config\.yaml --wait 180s$/m,
    );
    // The current context of the user's kubeconfig is never used.
    for (const line of calls
      .split("\n")
      .filter((l) => l.startsWith("kubectl") && !l.includes("version --client"))) {
      expect(line).toContain("--context kind-demo");
    }
  });

  it("--no-egress-proxy opts out: no proxy image, the chart's opt-out passed to the install, and no browser", () => {
    const r = run(["--name", "demo", "--no-egress-proxy"], { IMAGE_TAG: "t" });
    expect(r.stderr).toContain("cannot reach the cluster through context kind-demo");
    expect(log()).not.toContain("pi-egress-proxy");
    const kindUp = readFileSync(script, "utf8");
    expect(kindUp).toContain(
      "[[ $egress_proxy -eq 1 ]] || extra_args+=(--set egressProxy.enabled=false)",
    );
    const browser = run(["--browser", "--no-egress-proxy"], { IMAGE_TAG: "t" });
    expect(browser.status).toBe(1);
    expect(browser.stderr).toContain("--browser needs the egress proxy");
    // --egress-proxy, the old way to ask for it, still works.
    expect(run(["--name", "demo", "--egress-proxy"], { IMAGE_TAG: "t" }).stderr).toContain(
      "cannot reach the cluster through context kind-demo",
    );
  });

  it("reuses an existing cluster of that name", () => {
    run(["--name", "demo"], {
      IMAGE_TAG: "t",
      FAKE_CLUSTERS: "demo\nother\n",
      FAKE_PORTS: "127.0.0.1:8080",
    });
    expect(log()).not.toContain("kind create");
  });
});

describe("hack/kind-up.sh localhost ports", () => {
  const config = () => readFileSync(join(dir, "log.config"), "utf8");

  it("maps the three host ports on 127.0.0.1 only, to the NodePorts the charts use", () => {
    const text = readFileSync(join(root, "hack/kind-config.yaml"), "utf8");
    const mappings = [
      ...text.matchAll(/containerPort: (\d+), hostPort: (\d+), listenAddress: "([^"]+)"/g),
    ];
    expect(mappings.map((m) => [m[1], m[2]])).toEqual([
      ["30080", "8080"],
      ["30254", "10254"],
      ["30256", "10256"],
    ]);
    // Never 0.0.0.0: the host's other interfaces must not reach them.
    for (const m of mappings) expect(m[3]).toBe("127.0.0.1");
    expect(text).not.toMatch(/0\.0\.0\.0/);
    const ingest = readFileSync(join(root, "charts/cela/values.yaml"), "utf8");
    expect(ingest).toMatch(/nodePort: 30080/);
    const onecli = readFileSync(join(root, "charts/pi-onecli/values.yaml"), "utf8");
    expect(onecli).toMatch(/nodePorts: \{ web: 30254, api: 30256 \}/);
  });

  it("creates the cluster with the mappings and reads the IPv4 gateway (not the first, IPv6, entry)", () => {
    run(["--name", "demo"], { IMAGE_TAG: "t" });
    expect(config()).toContain("extraPortMappings:");
    expect(log()).toContain("docker network inspect kind");
  });

  it("--no-expose creates the cluster without mappings and never asks Docker for the gateway", () => {
    const r = run(["--name", "demo", "--no-expose"], { IMAGE_TAG: "t" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot reach the cluster through context kind-demo");
    expect(config()).not.toContain("extraPortMappings");
    expect(config()).not.toContain("expose:");
    expect(config()).toContain("kindest/node");
    expect(log()).not.toContain("network inspect");
  });

  it("refuses an existing cluster without the mappings, and says what to do", () => {
    const r = run(["--name", "demo"], { IMAGE_TAG: "t", FAKE_CLUSTERS: "demo\n" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("without the localhost port mappings");
    expect(r.stderr).toContain("hack/kind-down.sh --name demo");
    expect(r.stderr).toContain("--no-expose");
  });

  it("reuses an existing cluster without the mappings when --no-expose is given", () => {
    const r = run(["--name", "demo", "--no-expose"], { IMAGE_TAG: "t", FAKE_CLUSTERS: "demo\n" });
    expect(r.stderr).not.toContain("port mappings");
    expect(r.stderr).toContain("cannot reach the cluster through context kind-demo");
  });

  it("stops when the network has no IPv4 gateway, instead of admitting a wider range", () => {
    const r = run(["--name", "demo"], { IMAGE_TAG: "t", FAKE_GATEWAYS: "fc00:f853:ccd:e793::1 " });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read the IPv4 gateway");
  });

  it("keeps the steps' output in a log, and on a failure shows the step's last lines and the log's path", () => {
    const r = run(["--name", "demo"], { IMAGE_TAG: "t", CI: "" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("✓ check the tools and the images");
    // helm's version line is step output: in the log, not on the terminal.
    expect(r.stdout).not.toContain("v4.3.1+gfake");
    expect(r.stderr).toContain("✗ kind cluster demo failed");
    expect(r.stderr).toContain("cannot reach the cluster through context kind-demo");
    const path = /Full log: (\S+)/.exec(r.stderr)?.[1] ?? "";
    expect(path.startsWith(dir)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("v4.3.1+gfake");
  });

  it("--verbose, and CI in the environment, stream the steps' output and keep no log", () => {
    for (const [args, env] of [
      [["--name", "demo", "--verbose"], { CI: "" }],
      [["--name", "demo"], { CI: "true" }],
    ] as const) {
      const r = run([...args], { IMAGE_TAG: "t", ...env });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("## check the tools and the images");
      expect(r.stdout).toContain("v4.3.1+gfake");
      expect(r.stderr).not.toContain("Full log");
    }
  });

  it("passes the gateway as a /32 to the install, and to OneCLI only with --onecli", () => {
    const kindUp = readFileSync(script, "utf8");
    expect(kindUp).toContain(
      '--set ingest.expose.enabled=true --set "ingest.expose.sourceCidr=$expose_cidr"',
    );
    expect(kindUp).toContain("expose_cidr=$gateway/32");
    expect(kindUp).toMatch(
      /\[\[ \$onecli -eq 0 \]\] \|\| extra_args\+=\(--onecli-expose-cidr "\$expose_cidr"\)/,
    );
    expect(kindUp).toMatch(/--no-expose\) expose=0/);
  });
});

describe("hack/kind-up.sh --cni", () => {
  const config = () => readFileSync(join(dir, "log.config"), "utf8");

  it("rejects an unknown CNI", () => {
    const r = run(["--cni", "calico"], { IMAGE_TAG: "t" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bad --cni 'calico'");
    expect(run(["--cni"]).status).toBe(64);
  });

  it("kindnet (the default) keeps the pinned config and waits for the node", () => {
    run(["--name", "demo"], { IMAGE_TAG: "t" });
    expect(config()).not.toMatch(/^networking:/m);
    expect(log()).toMatch(/^kind create cluster --name demo --config \S+ --wait 180s$/m);
  });

  it("cilium creates the cluster without kindnet and does not wait for a node that has no CNI yet", () => {
    run(["--name", "demo", "--cni", "cilium"], { IMAGE_TAG: "t" });
    expect(config()).toMatch(/^networking:\n {2}disableDefaultCNI: true$/m);
    expect(config()).toContain("extraPortMappings:");
    expect(log()).toMatch(/^kind create cluster --name demo --config \S+$/m);
  });

  it("refuses to reuse a cluster whose CNI does not match", () => {
    const reuse = { IMAGE_TAG: "t", FAKE_CLUSTERS: "demo\n", FAKE_NODES_RC: "0" };
    let r = run(["--name", "demo", "--no-expose", "--cni", "cilium"], {
      ...reuse,
      FAKE_KINDNET: "daemonset.apps/kindnet",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cluster demo runs kindnet");
    r = run(["--name", "demo", "--no-expose"], { ...reuse, FAKE_CILIUM: "daemonset.apps/cilium" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("pass --cni cilium");
    expect(log()).not.toContain("helm --kube-context");
  });

  it("installs a pinned Cilium and the chart's Cilium policies, and requires an enforced probe", () => {
    const kindUp = readFileSync(script, "utf8");
    expect(kindUp).toMatch(/^cilium_version=\d+\.\d+\.\d+$/m);
    expect(kindUp).toContain('--repo https://helm.cilium.io --version "$cilium_version"');
    // The user's Helm repositories are never read or changed.
    expect(kindUp).toContain("HELM_REPOSITORY_CONFIG=$helm_home/repositories.yaml");
    expect(kindUp).toContain("--set networkPolicy.provider=cilium");
    expect(kindUp).toContain("export NETPOL_ENFORCED=${NETPOL_ENFORCED:-1}");
    const smoke = readFileSync(join(root, "hack/kind-smoke.sh"), "utf8");
    expect(smoke).toContain("export NETPOL_ENFORCED=${NETPOL_ENFORCED:-1}");
    expect(smoke).toContain('check "the sandbox does not reach the kubelet on the node"');
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
    const values = readFileSync(join(root, "charts/cela/values-kind.yaml"), "utf8");
    expect(values).toMatch(/^ {2}runtimeClassName: ""/m);
    expect(values).toMatch(/^ {2}allowInsecureRuntime: true/m);
    expect(values).toMatch(/^ {2}provider: standard/m);
    expect(values).toMatch(/^ {2}mode: disabled/m);
    // kind-up.sh checks the admin console and prints its URL.
    expect(values).toMatch(/^console:\n {2}enabled: true/m);
    const workflow = readFileSync(join(root, ".github/workflows/kind.yml"), "utf8");
    // Every action is pinned by full commit SHA.
    for (const use of workflow.matchAll(/uses: (\S+)/g)) expect(use[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(workflow).toContain("sha256sum --check");
  });
});
