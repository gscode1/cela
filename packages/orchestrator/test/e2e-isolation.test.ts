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

interface Mode {
  proxied: boolean;
  /** The probe line of direct public internet (proxied mode must see BLOCKED, direct mode REACHABLE). */
  internet?: string;
  /** The sandbox's DNS lookup (proxied mode must see NONE). */
  dns?: string;
}
const direct: Mode = { proxied: false };

/** Exercise the real shell verdict/control ordering, but never invoke kubectl or make a network connection. */
function run(
  verdict: string,
  enforced: string,
  dead = "",
  missing = false,
  mode: Mode = direct,
): number | null {
  // With the proxy on the gateway is a denied target and the egress proxy is the control (ADR 0038).
  const denied = mode.proxied ? [...labels, "onecli-gateway"] : labels;
  const controls = mode.proxied
    ? [
        "egress-proxy REACHABLE",
        `dns ${mode.dns ?? "NONE"}`,
        `internet-direct ${mode.internet ?? "BLOCKED"}`,
      ]
    : ["onecli-gateway REACHABLE", `internet-direct ${mode.internet ?? "REACHABLE"}`];
  const result = spawnSync(
    "bash",
    [
      "-euc",
      `
    ns=test
    proxied=${mode.proxied ? "1" : "0"}
    note() { :; }
    addr_of() { echo 192.0.2.9; }
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
          ...denied.slice(missing ? 1 : 0).map((label) => `${label} ${verdict}`),
          ...controls,
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
  it("fails the direct mode when direct internet is blocked", () => {
    expect(run("BLOCKED", "1", "", false, { proxied: false, internet: "BLOCKED" })).toBe(1);
  }, 15_000);
});

describe("e2e isolation with the egress proxy", () => {
  const proxied: Mode = { proxied: true };
  it(
    "passes when every target, the gateway included, is blocked, the internet is blocked and there is no DNS",
    () => expect(run("BLOCKED", "1", "", false, proxied)).toBe(0),
    15_000,
  );
  it("fails when the sandbox reaches the public internet directly", () => {
    expect(run("BLOCKED", "1", "", false, { proxied: true, internet: "REACHABLE" })).toBe(1);
  }, 15_000);
  it("fails when the sandbox resolves names", () => {
    expect(run("BLOCKED", "1", "", false, { proxied: true, dns: "RESOLVES" })).toBe(1);
  }, 15_000);
  it("fails on a dead gateway control or a missing verdict", () => {
    expect(run("BLOCKED", "0", "onecli-gateway", false, proxied)).toBe(1);
    expect(run("BLOCKED", "1", "", true, proxied)).toBe(1);
  }, 15_000);
  it("keeps automatic KNOWN-FAIL when nothing is enforced", () => {
    expect(run("REACHABLE", "", "", false, proxied)).toBe(3);
    expect(run("REACHABLE", "1", "", false, proxied)).toBe(1);
  }, 15_000);
});
