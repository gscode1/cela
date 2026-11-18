import { describe, expect, it } from "vitest";
import {
  deriveEgressToken,
  ensurePrincipal,
  hashEgressToken,
  livePrincipalSessions,
  principalCounts,
  principalRuleSets,
  revokePrincipal,
  setPrincipalPodIp,
} from "../src/egress-principals.ts";
import { FakeEgressDb } from "./fake-egress-db.ts";

const MASTER = "master-key-for-tests";
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const spec = (sessionId: string, ruleSets: string[] = ["npm"]) => ({
  sessionId,
  profile: { name: "coding", version: 3 },
  ruleSets,
});

describe("egress principals", () => {
  it("derives a long, distinct, deterministic token per session and salt", () => {
    const token = deriveEgressToken(MASTER, A, "00".repeat(32));
    expect(Buffer.from(token, "base64url").length).toBe(32);
    expect(deriveEgressToken(MASTER, A, "00".repeat(32))).toBe(token);
    expect(deriveEgressToken(MASTER, B, "00".repeat(32))).not.toBe(token);
    expect(deriveEgressToken(MASTER, A, "11".repeat(32))).not.toBe(token);
    expect(deriveEgressToken("another-master", A, "00".repeat(32))).not.toBe(token);
    expect(() => deriveEgressToken("", A, "00")).toThrow(/empty/);
  });

  it("hashes with sha256 hex and stores the hash, the salt and the profile's rule sets, never the token", async () => {
    const db = new FakeEgressDb();
    const made = await ensurePrincipal(db.asPool(), spec(A), MASTER);
    expect(made).toBeDefined();
    const row = db.principals[0];
    expect(row?.token_hash).toBe(hashEgressToken(made?.token ?? ""));
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.rule_sets).toEqual(["npm"]);
    expect(row?.profile_name).toBe("coding");
    expect(JSON.stringify(db.principals)).not.toContain(made?.token ?? "unreachable");
  });

  it("gives the same token again without writing, so reopening an env does not notify the proxy", async () => {
    const db = new FakeEgressDb();
    const first = await ensurePrincipal(db.asPool(), spec(A), MASTER);
    expect(db.notifications).toEqual(["principals"]);
    const again = await ensurePrincipal(db.asPool(), spec(A, ["other"]), MASTER);
    expect(again?.token).toBe(first?.token);
    expect(db.notifications).toHaveLength(1);
    // The rule sets stay as they were at creation.
    expect(db.principals[0]?.rule_sets).toEqual(["npm"]);
    const second = await ensurePrincipal(db.asPool(), spec(B), MASTER);
    expect(second?.token).not.toBe(first?.token);
  });

  it("records the Pod address, notifying only when it changes", async () => {
    const db = new FakeEgressDb();
    await ensurePrincipal(db.asPool(), spec(A), MASTER);
    expect(await setPrincipalPodIp(db.asPool(), A, "10.244.1.7")).toBe(true);
    expect(await setPrincipalPodIp(db.asPool(), A, "10.244.1.7")).toBe(false);
    expect(await setPrincipalPodIp(db.asPool(), A, "10.244.2.9")).toBe(true);
    expect(db.principals[0]?.pod_ip).toBe("10.244.2.9");
    expect(await setPrincipalPodIp(db.asPool(), B, "10.244.2.10")).toBe(false);
    expect(db.notifications).toHaveLength(3);
  });

  it("revokes: the row stays, the address goes, no token is handed out again, a second revoke is a no-op", async () => {
    const db = new FakeEgressDb();
    await ensurePrincipal(db.asPool(), spec(A), MASTER);
    await setPrincipalPodIp(db.asPool(), A, "10.244.1.7");
    expect(await revokePrincipal(db.asPool(), A)).toBe(true);
    expect(await revokePrincipal(db.asPool(), A)).toBe(false);
    expect(db.principals[0]?.revoked_at).not.toBeNull();
    expect(db.principals[0]?.pod_ip).toBeNull();
    expect(await ensurePrincipal(db.asPool(), spec(A), MASTER)).toBeUndefined();
    expect(await setPrincipalPodIp(db.asPool(), A, "10.244.1.8")).toBe(false);
    expect(await livePrincipalSessions(db.asPool())).toEqual([]);
  });

  it("counts and reads back the stored rule sets", async () => {
    const db = new FakeEgressDb();
    await ensurePrincipal(db.asPool(), spec(A, ["npm", "pypi"]), MASTER);
    await ensurePrincipal(db.asPool(), spec(B), MASTER);
    await setPrincipalPodIp(db.asPool(), A, "10.244.1.7");
    await revokePrincipal(db.asPool(), B);
    expect(await principalCounts(db.asPool())).toEqual({ active: 1, withPodIp: 1, revoked: 1 });
    expect(await principalRuleSets(db.asPool(), A)).toEqual({
      profile: "coding",
      ruleSets: ["npm", "pypi"],
      revoked: false,
    });
    expect((await principalRuleSets(db.asPool(), B))?.revoked).toBe(true);
    expect(
      await principalRuleSets(db.asPool(), "cccccccc-3333-4333-8333-333333333333"),
    ).toBeUndefined();
  });
});
