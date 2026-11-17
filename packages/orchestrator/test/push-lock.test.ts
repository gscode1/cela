import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Preserves the legacy locking helper regression tests against a stub kubectl that keeps one
// ConfigMap in a temp dir. No cluster is touched.
const lockScript = resolve(import.meta.dirname, "./fixtures/push-lock.sh");

const kubectlStub = `#!/usr/bin/env bash
# state files in $STUB_DIR: holder, expires, rv (absent = no ConfigMap)
d=$STUB_DIR
args="$*"
field() { sed -n "s/^ *$1: \\"\\{0,1\\}\\([^\\"]*\\)\\"\\{0,1\\}$/\\1/p" | head -1; }
write() { printf '%s' "$2" >"$d/$1"; }
case " $args " in
  *" create -f - "*)
    manifest=$(cat)
    if [[ -e $d/rv ]]; then echo 'Error from server (AlreadyExists): configmaps "x" already exists' >&2; exit 1; fi
    write holder "$(field holder <<<"$manifest")"; write expires "$(field expires <<<"$manifest")"; write rv 1 ;;
  *" replace -f - "*)
    manifest=$(cat)
    want=$(field resourceVersion <<<"$manifest")
    if [[ -n \${STUB_RACE:-} ]]; then write rv 99; fi
    if [[ ! -e $d/rv || $(cat "$d/rv") != "$want" ]]; then echo 'Error from server (Conflict): the object has been modified' >&2; exit 1; fi
    write holder "$(field holder <<<"$manifest")"; write expires "$(field expires <<<"$manifest")"; write rv "$((want + 1))" ;;
  *" get configmap "*)
    [[ -e $d/rv ]] || exit 0
    case $args in
      *resourceVersion*) printf '%s %s %s' "$(cat "$d/rv")" "$(cat "$d/expires")" "$(cat "$d/holder")" ;;
      *) cat "$d/holder" ;;
    esac ;;
  *" delete configmap "*)
    if [[ -n \${STUB_FAIL_DELETE:-} ]]; then echo 'Unable to connect to the server: dial tcp: connection refused' >&2; exit 1; fi
    rm -f "$d/rv" "$d/holder" "$d/expires" ;;
  *) echo "stub kubectl: unexpected: $args" >&2; exit 2 ;;
esac
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "push-lock-"));
  writeFileSync(join(dir, "kubectl"), kubectlStub);
  chmodSync(join(dir, "kubectl"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seed = (holder: string, expires: number) => {
  writeFileSync(join(dir, "holder"), holder);
  writeFileSync(join(dir, "expires"), String(expires));
  writeFileSync(join(dir, "rv"), "7");
};
const now = () => Math.floor(Date.now() / 1000);

// Runs the given shell steps with the helper sourced and kubectl stubbed.
const run = (steps: string, env: Record<string, string> = {}) =>
  spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail
ns=test; lock=retired-code-volume-push-lock
k() { kubectl -n "$ns" "$@"; }
. "${lockScript}"
${steps}`,
    ],
    {
      encoding: "utf8",
      timeout: 20_000,
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, STUB_DIR: dir, ...env },
    },
  );

describe("push lock", () => {
  it("is a valid bash script", () => {
    execFileSync("bash", ["-n", lockScript]);
  });

  it("takes a free lock and records holder and expiry", () => {
    const r = run("push_lock_acquire");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "holder"), "utf8")).toMatch(/-\d+-\d+$/);
    expect(Number(readFileSync(join(dir, "expires"), "utf8"))).toBeGreaterThan(now() + 800);
  });

  it("honours PUSH_LOCK_TTL_SECONDS", () => {
    run("push_lock_acquire", { PUSH_LOCK_TTL_SECONDS: "60" });
    expect(Number(readFileSync(join(dir, "expires"), "utf8"))).toBeLessThan(now() + 120);
  });

  it("respects a live lock held by another run", () => {
    seed("other-1-1", now() + 600);
    const r = run("push_lock_acquire");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("another push holds the lock");
    expect(r.stderr).toContain("other-1-1");
    expect(readFileSync(join(dir, "holder"), "utf8")).toBe("other-1-1");
  });

  it("takes over an expired lock and logs it", () => {
    seed("stale-1-1", now() - 60);
    const r = run("push_lock_acquire");
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("took over the expired push lock");
    expect(r.stderr).toContain("stale-1-1");
    expect(readFileSync(join(dir, "holder"), "utf8")).not.toBe("stale-1-1");
    expect(Number(readFileSync(join(dir, "expires"), "utf8"))).toBeGreaterThan(now());
  });

  it("loses a takeover race instead of overwriting the winner", () => {
    seed("stale-1-1", now() - 60);
    const r = run("push_lock_acquire", { STUB_RACE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not take over");
    expect(r.stderr).toContain("Conflict");
    expect(readFileSync(join(dir, "holder"), "utf8")).toBe("stale-1-1");
  });

  it("never takes over a lock without an expiry", () => {
    writeFileSync(join(dir, "holder"), "");
    writeFileSync(join(dir, "expires"), "");
    writeFileSync(join(dir, "rv"), "3");
    const r = run("push_lock_acquire");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no expiry");
  });

  it("releases the lock it holds", () => {
    const r = run("push_lock_acquire; push_lock_release");
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, "rv"))).toBe(false);
  });

  it("reports a failed delete with its real error", () => {
    const r = run("push_lock_acquire; push_lock_release", { STUB_FAIL_DELETE: "1" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not remove the push lock");
    expect(r.stderr).toContain("connection refused");
    expect(existsSync(join(dir, "rv"))).toBe(true);
  });

  it("does not delete a lock another run took over", () => {
    const r = run(
      `push_lock_acquire
printf 'newer-2-2' >"$STUB_DIR/holder"
push_lock_release`,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("now held by newer-2-2");
    expect(readFileSync(join(dir, "holder"), "utf8")).toBe("newer-2-2");
    expect(existsSync(join(dir, "rv"))).toBe(true);
  });
});
