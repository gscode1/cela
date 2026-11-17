import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// tests/e2e/run-phase3.sh netpol_probe_check against a stubbed kubectl: NETPOL_ENFORCED=1 turns `not-enforced` into a
// failure; without it the verdict is only printed, and `inconclusive` never fails.
const suite = readFileSync(
  resolve(import.meta.dirname, "../../../tests/e2e/run-phase3.sh"),
  "utf8",
);
const fn = suite.match(/^netpol_probe_check\(\) \{[\s\S]*?^\}/m)?.[0];
if (fn === undefined) throw new Error("netpol_probe_check is missing from run-phase3.sh");
const script: string = fn;

function check(state: string, netpol: string): { status: number | null; out: string } {
  const body = JSON.stringify({
    status: 200,
    body: { networkPolicy: { state, detail: { reason: "because" } } },
  });
  const result = spawnSync(
    "bash",
    [
      "-euc",
      `
    here="$E2E_DIR"
    note() { printf '%s\\n' "$*"; }
    sleep() { :; }
    k() { if [[ $1 == get ]]; then echo '{"items":[{"metadata":{"name":"ingest-0"},"status":{"phase":"Running"}}]}'; else printf '%s\\n' "$BODY"; fi; }
    ${script}
    netpol_probe_check`,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "",
        BODY: body,
        NETPOL_ENFORCED: netpol,
        E2E_DIR: resolve(import.meta.dirname, "../../../tests/e2e"),
      },
    },
  );
  return { status: result.status, out: result.stdout + result.stderr };
}

describe("e2e isolation probe check", () => {
  it("fails on not-enforced only with NETPOL_ENFORCED=1", () => {
    expect(check("not-enforced", "1").status).toBe(1);
    expect(check("not-enforced", "").status).toBe(0);
    expect(check("not-enforced", "0").status).toBe(0);
  }, 20_000);

  it("never fails on enforced or inconclusive, and prints the verdict and the reason", () => {
    for (const state of ["enforced", "inconclusive"]) {
      const result = check(state, "1");
      expect(result.status).toBe(0);
      expect(result.out).toContain(`isolation-probe: ${state} (because)`);
    }
  }, 20_000);
});
