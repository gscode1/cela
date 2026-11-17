import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Obj, renderDocs } from "./support/helm.js";

const root = resolve(import.meta.dirname, "../../..");
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "image-build-"));
  writeFileSync(
    join(dir, "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$IMAGE_TEST_LOG"
while [[ $# -gt 0 ]]; do
  if [[ $1 == --metadata-file ]]; then
    printf '{"containerimage.digest":"sha256:test"}' >"$2"
    break
  fi
  shift
done
`,
  );
  chmodSync(join(dir, "docker"), 0o755);
  writeFileSync(join(dir, "uname"), "#!/usr/bin/env bash\necho aarch64\n");
  chmodSync(join(dir, "uname"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const run = (args: string[], repo = "") =>
  spawnSync("bash", [join(root, "images/build.sh"), ...args], {
    cwd: dir,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      IMAGE_TEST_LOG: join(dir, "log"),
      IMAGE_REPO: repo,
    },
  });
const log = () => readFileSync(join(dir, "log"), "utf8");

describe("image delivery replaces mutable code uploads", () => {
  it("builds all images for both architectures without publishing by default", () => {
    const result = run(["all"]);
    expect(result.status, result.stderr).toBe(0);
    expect(log().trim().split("\n")).toHaveLength(4);
    expect(log()).toContain("--platform linux/amd64,linux/arm64");
    expect(log()).toContain("type=oci,dest=");
    expect(log()).not.toMatch(/--push|--load/);
    expect(result.stdout.match(/digest:/g)).toHaveLength(4);
  });

  it("accepts build flags without an image target", () => {
    const result = run(["--platform", "linux/arm64"]);
    expect(result.status, result.stderr).toBe(0);
    expect(log().trim().split("\n")).toHaveLength(4);
    expect(log()).toContain("--load");
  });

  it("publishes only with explicit opt-in and uses IMAGE_REPO as a prefix", () => {
    const result = run(["ingest", "--push"], "registry.example.com/team/");
    expect(result.status, result.stderr).toBe(0);
    expect(log()).toContain("--push");
    expect(log()).toMatch(/-t registry.example.com\/team\/pi-ingest:0\.0\.0-[a-f0-9]+/);
    expect(result.stdout).toContain("registry.example.com/team/pi-ingest@sha256:test");
  });

  it("loads a single native platform", () => {
    expect(run(["sandbox", "--platform", "linux/arm64"]).status).toBe(0);
    expect(log()).toContain("--load");
  });

  it("exports a non-native single platform without attempting a load", () => {
    expect(run(["sandbox", "--platform", "linux/amd64"]).status).toBe(0);
    expect(log()).toContain("type=oci");
    expect(log()).not.toContain("--load");
  });

  it("rejects unknown images, flags and architectures", () => {
    for (const args of [
      ["other"],
      ["ingest", "--platform"],
      ["ingest", "--platform", "linux/386"],
      ["all", "--wat"],
    ]) {
      expect(run(args).status).toBe(64);
    }
  });

  it("uses the repository root as every Dockerfile's context", () => {
    expect(run(["orchestrator"]).status).toBe(0);
    expect(log().trim()).toContain(`-f ${root}/images/orchestrator/Dockerfile`);
    expect(log().trim().endsWith(root)).toBe(true);
  });

  it("packages workspace dependencies, migrations and the SDK through pnpm deploy", () => {
    for (const image of ["orchestrator", "ingest", "e2e-driver"]) {
      const dockerfile = readFileSync(join(root, "images", image, "Dockerfile"), "utf8");
      expect(dockerfile).toContain("pnpm install --frozen-lockfile");
      expect(dockerfile).toContain("COPY vendor ./vendor");
      expect(dockerfile).toContain("COPY packages ./packages");
      expect(dockerfile).toContain(" deploy --prod");
      expect(dockerfile).toContain("USER 1000:1000");
      expect(dockerfile).toMatch(/FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
    }
  });

  it("builds the admin console into the ingest image", () => {
    const dockerfile = readFileSync(join(root, "images/ingest/Dockerfile"), "utf8");
    expect(dockerfile).toContain("--filter @pi-durable-k8s/admin-ui build");
    expect(dockerfile).toContain("/src/packages/admin-ui/dist ./console");
  });

  it("bakes driver scripts and Phase 1 test dependencies into the driver image", () => {
    const dockerfile = readFileSync(join(root, "images/e2e-driver/Dockerfile"), "utf8");
    expect(dockerfile).toContain("deploy --prod=false");
    expect(dockerfile).toContain("/opt/phase1");
    expect(dockerfile).toContain("COPY tests/e2e /driver/tests/e2e");
    expect(readFileSync(join(root, "tests/e2e/job.yaml.tpl"), "utf8")).not.toContain(
      "persistentVolumeClaim",
    );
  });

  it("uses immutable app images without init containers, shared code volumes or shard affinity", () => {
    // Rendered chart with three shards, so the shard Deployments are checked too.
    const deployments = renderDocs("pi-durable", ["--set", "orchestrator.shards=3"]).filter(
      (d) => d.kind === "Deployment",
    );
    const nameOf = (d: Obj): string => String((d.metadata as Obj).name);
    expect(deployments.map(nameOf)).toEqual(
      expect.arrayContaining([
        "pi-orchestrator",
        "pi-orchestrator-1",
        "pi-orchestrator-2",
        "pi-ingest",
      ]),
    );
    for (const d of deployments) {
      const manifest = JSON.stringify(d);
      expect(manifest, nameOf(d)).not.toMatch(
        /initContainers|"mountPath":"\/code"|claimName|"podAffinity"/,
      );
    }
  });
});
