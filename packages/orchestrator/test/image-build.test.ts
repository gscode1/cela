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
  it.each([
    [
      "egress-proxy",
      /FROM --platform=\$BUILDPLATFORM golang:1\.27\.3@sha256:[a-f0-9]{64} AS build/,
    ],
    ["egress-proxy", /FROM gcr\.io\/distroless\/static:nonroot@sha256:[a-f0-9]{64}/],
    ["sandbox", /FROM registry\.k8s\.io\/agent-sandbox\/sandboxd:v1\.0\.11@sha256:[a-f0-9]{64}/],
    [
      "sandbox-browser",
      /FROM registry\.k8s\.io\/agent-sandbox\/sandboxd:v1\.0\.11@sha256:[a-f0-9]{64}/,
    ],
  ])("pins the %s base image by digest (%s)", (name, reference) => {
    expect(readFileSync(join(root, `images/${name}/Dockerfile`), "utf8")).toMatch(reference);
  });

  it("builds all images for both architectures without publishing by default", () => {
    const result = run(["all"]);
    expect(result.status, result.stderr).toBe(0);
    expect(log().trim().split("\n")).toHaveLength(6);
    expect(log()).toContain("--platform linux/amd64,linux/arm64");
    expect(log()).toContain("type=oci,dest=");
    expect(log()).not.toMatch(/--push|--load/);
    expect(result.stdout.match(/digest:/g)).toHaveLength(6);
  });

  it("builds the browser sandbox image from its own Dockerfile", () => {
    expect(run(["sandbox-browser", "--platform", "linux/arm64"]).status).toBe(0);
    expect(log()).toContain(`-f ${root}/images/sandbox-browser/Dockerfile`);
    expect(log()).toMatch(/-t pi-sandbox-browser:0\.0\.0-[a-f0-9]+/);
  });

  it("ships the default sandbox's tools from pinned sources, as a non-root user (ADR 0048)", () => {
    const base = readFileSync(join(root, "images/sandbox/Dockerfile"), "utf8");
    expect(base.trimEnd().endsWith("USER 1000:1000")).toBe(true);
    // Node from the digest-pinned Node stage: bookworm's own nodejs is v18.
    expect(base).toContain("COPY --from=pi-env /usr/local/bin/node /usr/local/bin/node");
    // uv and yq: one release each, a checksum per architecture.
    expect(
      base.match(
        /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/github\.com\/astral-sh\/uv\/releases\/download\/0\.13\.7\//g,
      ),
    ).toHaveLength(2);
    expect(
      base.match(
        /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/github\.com\/mikefarah\/yq\/releases\/download\/v4\.54\.1\//g,
      ),
    ).toHaveLength(2);
    // helm: one release, a checksum per architecture, caches in the workspace.
    expect(
      base.match(
        /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/get\.helm\.sh\/helm-v4\.3\.2-linux-/g,
      ),
    ).toHaveLength(2);
    expect(base).toContain("HELM_CACHE_HOME=/workspace/.cache/helm");
    expect(base).toContain("ln -s /usr/bin/fdfind /usr/local/bin/fd");
    // gh: one release, a checksum per architecture.
    expect(
      base.match(
        /ADD --checksum=sha256:[a-f0-9]{64} https:\/\/github\.com\/cli\/cli\/releases\/download\/v2\.103\.3\//g,
      ),
    ).toHaveLength(2);
    for (const pkg of [
      "python3-venv",
      "python3-pip",
      "build-essential",
      "curl",
      "jq",
      "ripgrep",
      "fd-find",
      "tree",
      "file",
      "zip",
      "xz-utils",
      "bzip2",
      "sqlite3",
      "shellcheck",
      "git-lfs",
      "unzip",
      "git",
    ]) {
      expect(base).toMatch(new RegExp(`apt-get install[\\s\\S]*\\b${pkg}\\b`));
    }
    // Writable home; caches on the workspace PVC, not the ephemeral-storage-limited root filesystem.
    expect(base).toContain("HOME=/home/pi");
    expect(base).toContain("npm_config_cache=/workspace/.cache/npm");
    expect(base).toContain("COREPACK_HOME=/workspace/.cache/corepack");
  });

  it("keeps the browser image on the sandbox's pi-env, pinned tools and a non-root user", () => {
    const base = readFileSync(join(root, "images/sandbox/Dockerfile"), "utf8");
    const browser = readFileSync(join(root, "images/sandbox-browser/Dockerfile"), "utf8");
    // The pi-env stage (version, checksums) is the same text in both: a bump of one must bump the other.
    const stage = (text: string): string =>
      text.slice(text.indexOf("FROM node"), text.indexOf("\n\n", text.indexOf("FROM node")));
    expect(stage(browser)).toBe(stage(base));
    expect(browser).toMatch(/FROM registry\.k8s\.io\/agent-sandbox\/sandboxd:v1\.0\.11/);
    expect(browser.trimEnd().endsWith("USER 1000:1000")).toBe(true);
    // Exact versions with checksums: agent-browser per architecture, the npm tools from a lockfile.
    expect(
      browser.match(
        /ADD --checksum=sha256:[a-f0-9]{64} .*agent-browser\/releases\/download\/v0\.43\.0\//g,
      ),
    ).toHaveLength(2);
    expect(browser).toContain("npm ci");
    const pkg = JSON.parse(
      readFileSync(join(root, "images/sandbox-browser/package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toEqual({ patchright: "1.64.3" });
    // Both tools drive the one Chromium that Patchright installs, with the flags only the wrapper sets.
    const wrapper = readFileSync(join(root, "images/sandbox-browser/files/pi-browser"), "utf8");
    for (const flag of [
      "--no-sandbox",
      "--disable-quic",
      "--remote-debugging-address=127.0.0.1",
      "--proxy-server=http://127.0.0.1:",
      "--host-resolver-rules=",
    ]) {
      expect(wrapper).toContain(flag);
    }
    expect(wrapper).not.toContain("--remote-debugging-address=0.0.0.0");
    const policy = JSON.parse(
      readFileSync(join(root, "images/sandbox-browser/files/chromium-policy.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(policy.URLBlocklist).toEqual(expect.arrayContaining(["file://*", "chrome://*"]));
    expect(policy.DownloadDirectory).toBe("/workspace/downloads");
    expect(policy.QuicAllowed).toBe(false);
    expect(policy.DnsOverHttpsMode).toBe("off");
  });

  it("runs sandboxd under tini in both sandbox images, so orphans are reaped (issue #327)", () => {
    for (const name of ["sandbox", "sandbox-browser"]) {
      const text = readFileSync(join(root, "images", name, "Dockerfile"), "utf8");
      expect(text, name).toMatch(/apt-get install[^&]*\btini\b/);
      expect(text, name).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/sandboxd"]');
    }
    // The chart must not replace the ENTRYPOINT: sandboxd gets args only.
    const template = readFileSync(
      join(root, "charts/cela/templates/sandbox/template.yaml"),
      "utf8",
    );
    const container = template.slice(template.indexOf("- name: sandboxd"));
    expect(container.slice(0, container.indexOf("ports:"))).not.toMatch(/\bcommand:/);
  });

  it("accepts build flags without an image target", () => {
    const result = run(["--platform", "linux/arm64"]);
    expect(result.status, result.stderr).toBe(0);
    expect(log().trim().split("\n")).toHaveLength(6);
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
      expect(dockerfile).toContain("COPY packages ./packages");
      expect(dockerfile).toContain(" deploy --prod");
      expect(dockerfile).toContain("USER 1000:1000");
      expect(dockerfile).toMatch(/FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
    }
  });

  it("builds the admin console into the ingest image", () => {
    const dockerfile = readFileSync(join(root, "images/ingest/Dockerfile"), "utf8");
    expect(dockerfile).toContain("--filter @cela/admin-ui build");
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
    const deployments = renderDocs("cela", ["--set", "orchestrator.shards=3"]).filter(
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
