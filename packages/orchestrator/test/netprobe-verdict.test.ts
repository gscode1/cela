import { describe, expect, it } from "vitest";
import { decide } from "../src/netprobe-verdict.js";
import type { DeniedTarget, Outcome, PodReport } from "../src/netprobe-verdict.js";

const up = (name: string): DeniedTarget => ({
  name,
  address: `${name}:1`,
  upFromOrchestrator: true,
});
const down = (name: string): DeniedTarget => ({
  name,
  address: `${name}:1`,
  upFromOrchestrator: false,
});
const report = (targets: Record<string, Outcome>, over: Partial<PodReport> = {}): PodReport => ({
  dns: true,
  control: "connected",
  targets,
  ...over,
});

describe("isolation probe verdict", () => {
  it("is enforced when every verified denied target is blocked and the allowed controls work", () => {
    const result = decide(
      [up("postgres"), up("kube-api")],
      report({ postgres: "timeout", "kube-api": "refused" }),
    );
    expect(result.state).toBe("enforced");
    expect(result.targets.map((t) => t.verdict)).toEqual(["blocked", "blocked"]);
  }, 1000);

  it("is not-enforced as soon as one denied target accepted a connection", () => {
    const result = decide(
      [up("postgres"), up("kube-api")],
      report({ postgres: "timeout", "kube-api": "connected" }),
    );
    expect(result.state).toBe("not-enforced");
    expect(result.reason).toContain("kube-api");
  }, 1000);

  it("is not-enforced even when the controls failed or the orchestrator could not verify the target", () => {
    expect(
      decide([down("db")], report({ db: "connected" }, { dns: false, control: "timeout" })).state,
    ).toBe("not-enforced");
  }, 1000);

  it.each([
    ["DNS control fails", report({ db: "timeout" }, { dns: false })],
    ["the allowed TCP control fails", report({ db: "timeout" }, { control: "timeout" })],
  ])(
    "is inconclusive when the %s, since blocked then looks the same as broken",
    (_name, r) => {
      const result = decide([up("db")], r);
      expect(result.state).toBe("inconclusive");
      expect(result.targets[0]?.verdict).toBe("blocked");
    },
    1000,
  );

  it("is inconclusive without a report, and says why", () => {
    const result = decide([up("db")], undefined, "the probe Pod failed");
    expect(result).toMatchObject({
      state: "inconclusive",
      reason: "the probe Pod failed",
      controls: null,
    });
  }, 1000);

  it("is inconclusive when no denied target is up from the orchestrator (a timeout from a dead target proves nothing)", () => {
    const result = decide(
      [down("db"), down("kube-api")],
      report({ db: "timeout", "kube-api": "timeout" }),
    );
    expect(result.state).toBe("inconclusive");
    expect(result.targets.every((t) => t.verdict === "unverified")).toBe(true);
  }, 1000);

  it("counts only verified targets: an unverified one does not hide a blocked one, nor make it enforced alone", () => {
    expect(decide([up("a"), down("b")], report({ a: "timeout", b: "timeout" })).state).toBe(
      "enforced",
    );
    expect(decide([], report({})).state).toBe("inconclusive");
  }, 1000);

  it("treats a target missing from the report as unverified", () => {
    const result = decide([up("a"), up("b")], report({ a: "timeout" }));
    expect(result.state).toBe("enforced");
    expect(result.targets[1]).toMatchObject({ verdict: "unverified", outcome: "none" });
  }, 1000);
});
