import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const suite = readFileSync(
  resolve(import.meta.dirname, "../../../tests/e2e/run-phase3.sh"),
  "utf8",
);
function extract(pattern: RegExp): string {
  const found = suite.match(pattern)?.[0];
  if (found === undefined) throw new Error(`Missing shell function: ${String(pattern)}`);
  return found;
}
const isolation = extract(/^t_isolation\(\) \{[\s\S]*?^\}/m);
const countDenied = extract(/^count_denied\(\).*$/m);
const labels = [
  "orchestrator",
  "postgres",
  "ingest",
  "other-sandbox-rest",
  "other-sandbox-grpc",
  "kube-api",
  "onecli-api",
  "orchestrator-pod",
  "postgres-pod",
  "ingest-pod",
  "other-sandbox-rest-pod",
  "other-sandbox-grpc-pod",
];

/** Exercise the real shell verdict/control ordering, but never invoke kubectl or make a network connection. */
function run(verdict: string, enforced: string, dead = "", missing = false): number | null {
  const result = spawnSync(
    "bash",
    [
      "-euc",
      `
    ns=test
    note() { :; }
    cni_hint() { echo mock; }
    mkscript() { echo mock-script; }
    new_session() { echo session; }
    wait_session() { :; }
    owner_pod() { echo owner; }
    auth_codes() { echo '{}'; }
    assert_jq() { :; }
    send_input() { :; }
    status() { echo '{}'; }
    jq() { cat >/dev/null; printf '%s\\n' "$PROBE_OUT"; }
    k() { [[ $* == 'get endpoints '* ]] || exit 99; echo 192.0.2.1; }
    assert() {
      local desc=$1; shift
      if [[ $desc == 'positive control '* ]]; then
        [[ -z $DEAD || $desc != *"$DEAD"* ]] || exit 1
      else
        "$@" >/dev/null 2>&1 || exit 1
      fi
    }
    ${countDenied}
    ${isolation}
    t_isolation
  `,
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: process.env.PATH,
        NETPOL_ENFORCED: enforced,
        DEAD: dead,
        PROBE_OUT: [
          ...labels.slice(missing ? 1 : 0).map((label) => `${label} ${verdict}`),
          "onecli-gateway REACHABLE",
          "internet-direct REACHABLE",
        ].join("\n"),
      },
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  return result.status;
}

describe("e2e isolation honesty", () => {
  it(
    "passes verified denials with healthy controls",
    () => expect(run("BLOCKED", "1")).toBe(0),
    15_000,
  );
  it("keeps automatic KNOWN-FAIL but fails it when enforcement is required", () => {
    expect(run("REACHABLE", "")).toBe(3);
    expect(run("REACHABLE", "1")).toBe(1);
  }, 15_000);
  it(
    "fails a dead positive control even when KNOWN-FAIL was requested",
    () => expect(run("BLOCKED", "0", "postgres")).toBe(1),
    15_000,
  );
  it("cannot pass or become KNOWN-FAIL when a probe verdict is missing", () => {
    expect(run("BLOCKED", "1", "", true)).toBe(1);
    expect(run("REACHABLE", "", "", true)).toBe(1);
  }, 15_000);
});
