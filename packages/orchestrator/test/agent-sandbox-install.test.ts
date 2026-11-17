import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "hack/agent-sandbox.sh");
const pinnedUrl =
  "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.11/sandbox-with-extensions.yaml";
const pinnedSha = "6c749a5b667ccc533d6ee8a593ea5a5ded37bca90fff0e9ed64c69973609e236";
const crds = [
  "sandboxes.agents.x-k8s.io",
  "sandboxclaims.extensions.agents.x-k8s.io",
  "sandboxtemplates.extensions.agents.x-k8s.io",
  "sandboxwarmpools.extensions.agents.x-k8s.io",
];
const manifest = "kind: Namespace\nmetadata:\n  name: agent-sandbox-system\n";
const manifestSha = createHash("sha256").update(manifest).digest("hex");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-sandbox-"));
  // FAKE_CRDS: space-separated CRD names that exist. FAKE_SERVED: "group:plural" pairs that
  // the API server serves at v1beta1. FAKE_AVAILABLE: availableReplicas of controllers.
  writeFileSync(
    join(dir, "kubectl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_LOG"
if [[ $1 == --context ]]; then shift 2; fi
case "$1 $2" in
  "get crd")
    for c in $FAKE_CRDS; do [[ $c == "$3" ]] && echo "customresourcedefinition.apiextensions.k8s.io/$c"; done
    exit 0 ;;
  "get --raw")
    group=\${3#/apis/}; group=\${group%/v1beta1}; out=""
    for p in $FAKE_SERVED; do
      [[ \${p%%:*} == "$group" ]] && out="$out{\\"name\\":\\"\${p#*:}\\"},"
    done
    [[ -n $out ]] || exit 1
    echo "{\\"resources\\":[\${out%,}]}"; exit 0 ;;
  "get deployments")
    [[ -n \${FAKE_AVAILABLE:-} ]] && echo "$FAKE_AVAILABLE"
    exit 0 ;;
esac
exit 0
`,
  );
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf 'curl %s\\n' "$*" >>"$FAKE_LOG"
while [[ $# -gt 0 ]]; do
  if [[ $1 == -o ]]; then printf '%s' "$FAKE_MANIFEST" >"$2"; fi
  shift
done
`,
  );
  chmodSync(join(dir, "kubectl"), 0o755);
  chmodSync(join(dir, "curl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const served = [
  "agents.x-k8s.io:sandboxes",
  "extensions.agents.x-k8s.io:sandboxclaims",
  "extensions.agents.x-k8s.io:sandboxtemplates",
  "extensions.agents.x-k8s.io:sandboxwarmpools",
];
interface Opts {
  crds?: string[];
  served?: string[];
  available?: string;
  env?: Record<string, string>;
}
const run = (args: string[], o: Opts = {}) =>
  spawnSync("bash", [script, ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      FAKE_LOG: join(dir, "log"),
      FAKE_CRDS: (o.crds ?? []).join(" "),
      FAKE_SERVED: (o.served ?? []).join(" "),
      FAKE_AVAILABLE: o.available ?? "",
      FAKE_MANIFEST: manifest,
      KUBE_CONTEXT: "",
      ...o.env,
    },
  });
const log = () => (existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "");
const testEnv = { AGENT_SANDBOX_MANIFEST_SHA256: manifestSha };

describe("hack/agent-sandbox.sh", () => {
  it("pins the release asset by URL and sha256", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toContain(pinnedUrl.replace("v1.0.11", "$VERSION"));
    expect(text).toContain("VERSION=v1.0.11");
    expect(text).toContain(pinnedSha);
  }, 10_000);

  it("bundled on an empty cluster downloads the pinned URL and applies server-side", () => {
    const result = run(["bundled"], { env: testEnv });
    expect(result.status, result.stderr).toBe(0);
    expect(log()).toContain(`curl -fsSL --retry 3 -o`);
    expect(log()).toContain(pinnedUrl);
    expect(log()).toMatch(/^apply --server-side .*-f .*manifest\.yaml$/m);
    for (const crd of crds)
      expect(log()).toContain(`wait --for=condition=Established --timeout=60s crd/${crd}`);
    expect(log()).toContain(
      "-n agent-sandbox-system wait --for=condition=Available --timeout=300s deployment/agent-sandbox-controller",
    );
  }, 30_000);

  it("passes KUBE_CONTEXT to every kubectl call", () => {
    const result = run(["bundled"], { env: { ...testEnv, KUBE_CONTEXT: "ctx-a" } });
    expect(result.status, result.stderr).toBe(0);
    const calls = log()
      .split("\n")
      .filter((l) => l && !l.startsWith("curl"));
    expect(calls.length).toBeGreaterThan(4);
    for (const l of calls) expect(l).toMatch(/^--context ctx-a /);
  }, 30_000);

  it.each(crds)(
    "bundled refuses when only %s exists and applies nothing",
    (crd) => {
      const result = run(["bundled"], { crds: [crd], env: testEnv });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("refusing to install");
      expect(result.stderr).toContain(crd);
      expect(result.stderr).toContain("external");
      expect(log()).not.toMatch(/apply|delete|patch|curl/);
    },
    30_000,
  );

  it("aborts on a checksum mismatch before applying", () => {
    const result = run(["bundled"], { env: { FAKE_MANIFEST: "tampered\n" } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checksum mismatch");
    expect(log()).toContain(pinnedUrl);
    expect(log()).not.toMatch(/apply/);
  }, 30_000);

  it("external passes when v1beta1 is served for all four kinds", () => {
    const result = run(["external"], { served, available: "1" });
    expect(result.status, result.stderr).toBe(0);
    expect(log()).not.toMatch(/apply|delete|patch|create|curl/);
  }, 30_000);

  it("external lists the kinds that are not served", () => {
    const result = run(["external"], { served: served.slice(0, 2), available: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SandboxTemplate (extensions.agents.x-k8s.io/v1beta1)");
    expect(result.stderr).toContain("SandboxWarmPool (extensions.agents.x-k8s.io/v1beta1)");
    expect(result.stderr).not.toMatch(/ {2}SandboxClaim /);
    expect(log()).not.toMatch(/apply|delete|patch|create/);
  }, 30_000);

  it("external fails when the controller has no available replicas", () => {
    const result = run(["external"], { served, available: "0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no available replicas");
  }, 30_000);

  it("rejects bad usage with exit 64", () => {
    for (const args of [[], ["nope"], ["bundled", "extra"]]) {
      const result = run(args);
      expect(result.status).toBe(64);
      expect(result.stderr).toContain("usage:");
    }
    expect(log()).toBe("");
  }, 30_000);
});
