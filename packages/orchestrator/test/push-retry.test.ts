import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Preserves the legacy retry helper regression tests against a stub kubectl on PATH.
// No cluster is touched.
const retryScript = resolve(import.meta.dirname, "./fixtures/push-retry.sh");

// STUB_FAILS failures with STUB_ERR on stderr come first, then success. Each call is counted in $STUB_DIR/calls.
const kubectlStub = `#!/usr/bin/env bash
d=$STUB_DIR
n=$(($(cat "$d/calls" 2>/dev/null || echo 0) + 1))
echo "$n" >"$d/calls"
if [[ $n -le \${STUB_FAILS:-0} ]]; then echo "$STUB_ERR" >&2; exit 1; fi
echo "kubectl ok: $*"
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-retry-"));
  writeFileSync(join(dir, "kubectl"), kubectlStub);
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const calls = () => Number(readFileSync(join(dir, "calls"), "utf8"));

const run = (env: Record<string, string>) =>
  spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
k() { kubectl -n test "$@"; }
. "${retryScript}"
push_retry k cp a b`,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        STUB_DIR: dir,
        PUSH_RETRY_BACKOFF_SECONDS: "0",
        ...env,
      },
    },
  );

describe("push retry", () => {
  it("is a valid bash script, and deployment helpers still parse", () => {
    for (const f of ["push-retry.sh", "push-lock.sh"]) {
      execFileSync("bash", ["-n", resolve(retryScript, "..", f)]);
    }
  });

  it("retries once after a connection reset, then succeeds", () => {
    const r = run({
      STUB_FAILS: "1",
      STUB_ERR:
        "error: error reading from error stream: next reader: read tcp 10.0.0.1:1->10.0.0.2:6443: read: connection reset by peer",
    });
    expect(r.status).toBe(0);
    expect(calls()).toBe(2);
    expect(r.stdout).toContain("kubectl ok: -n test cp a b");
    expect(r.stderr).toContain("retrying");
  });

  it("gives up after 3 attempts on a persistent transient error", () => {
    const r = run({ STUB_FAILS: "9", STUB_ERR: "read tcp: i/o timeout" });
    expect(r.status).toBe(1);
    expect(calls()).toBe(3);
  });

  it("fails at once on a non-transient error", () => {
    const r = run({
      STUB_FAILS: "1",
      STUB_ERR: 'Error from server (NotFound): pods "x" not found',
    });
    expect(r.status).toBe(1);
    expect(calls()).toBe(1);
    expect(r.stderr).toContain("NotFound");
    expect(r.stderr).not.toContain("retrying");
  });
});
