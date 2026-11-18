import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  evaluateEgress,
  type EgressReasonKind,
  type EgressRoute,
  type EvaluableRule,
  type EvaluableRuleSet,
} from "../src/egress-rules.ts";

interface Vector {
  name: string;
  rules: (Omit<EvaluableRule, "expiresAt"> & { expiresAt: string | null })[];
  request: {
    host: string;
    port: number;
    sessionId?: string;
    profileRuleSets?: string[];
    addresses?: string[];
  };
  expect: {
    decision: "allow" | "deny";
    route: EgressRoute | null;
    reasonKind: EgressReasonKind;
    matchedRuleId: string | null;
    conflictingRuleIds?: string[];
    needsPrivate?: true;
  };
}
interface Vectors {
  now: string;
  ruleSets: EvaluableRuleSet[];
  cases: Vector[];
}

/**
 * The shared vectors of the evaluator: the Go evaluator of the proxy (packages/egress-proxy, rules_vectors_test.go)
 * reads the same file, so the admin API's `explain` and the proxy cannot decide differently (ADR 0034, 0035). A change
 * to the rules of evaluation changes this file, and both implementations then have to agree with it.
 */
const vectors = JSON.parse(
  await readFile(new URL("./egress-vectors.json", import.meta.url), "utf8"),
) as Vectors;

describe("egress evaluation vectors (shared with the Go proxy)", () => {
  it("has a useful number of vectors", () => {
    expect(vectors.cases.length).toBeGreaterThanOrEqual(60);
    const names = vectors.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const vector of vectors.cases) {
    it(vector.name, () => {
      const decision = evaluateEgress(
        vectors.ruleSets,
        vector.rules.map((rule) => ({
          ...rule,
          expiresAt: rule.expiresAt === null ? null : new Date(rule.expiresAt),
        })),
        { ...vector.request, now: new Date(vectors.now) },
      );
      expect({
        decision: decision.decision,
        route: decision.route,
        reasonKind: decision.reasonKind,
        matchedRuleId: decision.matchedRuleId,
        ...(decision.conflictingRuleIds === undefined
          ? {}
          : { conflictingRuleIds: decision.conflictingRuleIds }),
        ...(decision.needsPrivate === true ? { needsPrivate: true } : {}),
      }).toEqual(vector.expect);
    });
  }
});
