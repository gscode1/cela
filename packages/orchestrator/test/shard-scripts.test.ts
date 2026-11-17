import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Drives shard creation against a stub kubectl. Image delivery is tested in image-build.test.ts.
const deploy = resolve(import.meta.dirname, "../../../deploy");

// Logs every call to $STUB_DIR/log. `get` of a name in $STUB_MISSING fails NotFound; STUB_LIST_FAIL makes a Deployment
// listing fail with a connection reset; STUB_LIST is what a successful listing prints.
const kubectlStub = `#!/usr/bin/env bash
echo "$*" >>"$STUB_DIR/log"
args=" $* "
if [[ $args == *" get deployment -l "* ]]; then
  if [[ -n \${STUB_LIST_FAIL:-} ]]; then echo "read tcp: connection reset by peer" >&2; exit 1; fi
  printf '%s' "\${STUB_LIST:-}"; exit 0
fi
for m in \${STUB_MISSING:-}; do
  if [[ $args == *" get deployment $m "* || $args == *" get service $m "* ]]; then echo "NotFound" >&2; exit 1; fi
done
if [[ $args == *" get deployment "* ]]; then echo '{"spec":{"template":{"metadata":{"labels":{}},"spec":{"containers":[{"env":[]}]}}}}'; fi
if [[ $args == *" apply "* ]]; then cat >/dev/null; fi
exit 0
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "shard-scripts-"));
  writeFileSync(join(dir, "kubectl"), kubectlStub);
  chmodSync(join(dir, "kubectl"), 0o755);
  writeFileSync(join(dir, "log"), "");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const log = () => readFileSync(join(dir, "log"), "utf8");
const run = (script: string, args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [join(deploy, script), ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_DIR: dir,
      NAMESPACE: "test-ns",
      PUSH_RETRY_BACKOFF_SECONDS: "0",
      ...env,
    },
  });

describe("add-shard.sh", () => {
  it("refuses to add shard 2 when shard 1 does not exist, and changes nothing", () => {
    const r = run("add-shard.sh", ["2"], { STUB_MISSING: "pi-orchestrator-1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("shard 1");
    expect(log()).not.toMatch(/ apply | set env /);
  });

  it("refuses when the Service of a lower shard is missing", () => {
    // The stub's NotFound applies to `get service <name>` too.
    const r = run("add-shard.sh", ["3"], { STUB_MISSING: "pi-orchestrator-2" });
    expect(r.status).not.toBe(0);
    expect(log()).not.toMatch(/ apply | set env /);
  });

  it("adds the next shard in order and sets PI_ORCH_SHARDS to k+1", () => {
    const r = run("add-shard.sh", ["2"]);
    expect(r.status, r.stderr).toBe(0);
    expect(log()).toContain("PI_ORCH_SHARDS=3");
  });

  it("adds shard 1 with no lower shard to check", () => {
    const r = run("add-shard.sh", ["1"]);
    expect(r.status, r.stderr).toBe(0);
    expect(log()).toContain("PI_ORCH_SHARDS=2");
  });
});
