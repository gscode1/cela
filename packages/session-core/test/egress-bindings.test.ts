import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  bindingCounts,
  bindingKeyId,
  boundSessions,
  deleteBinding,
  hasBinding,
  openBinding,
  parseBindingKey,
  putBinding,
  sealBinding,
} from "../src/egress-bindings.ts";
import {
  ensureSessionOneCliRules,
  removeSessionRules,
  sessionsWithRules,
} from "../src/egress-session-rules.ts";
import { FakeEgressDb } from "./fake-egress-db.ts";

const KEY = Buffer.alloc(32, 7);
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";
const TOKEN = "aoc_the-onecli-agent-token-of-session-a";

describe("binding encryption", () => {
  it("round-trips a token and gives a fresh nonce every time", () => {
    const one = sealBinding(KEY, A, TOKEN);
    const two = sealBinding(KEY, A, TOKEN);
    expect(openBinding(KEY, A, one)).toBe(TOKEN);
    expect(one.nonce.equals(two.nonce)).toBe(false);
    expect(one.ciphertext.equals(two.ciphertext)).toBe(false);
    expect(one.ciphertext.length).toBe(TOKEN.length + 16);
    expect(one.ciphertext.toString("utf8")).not.toContain(TOKEN);
  });

  it("does not open for another session, another key or tampered bytes", () => {
    const sealed = sealBinding(KEY, A, TOKEN);
    // A's ciphertext copied onto B's row.
    expect(() => openBinding(KEY, B, sealed)).toThrow("binding cannot be opened");
    expect(() => openBinding(Buffer.alloc(32, 8), A, sealed)).toThrow("binding cannot be opened");
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => openBinding(KEY, A, { ...sealed, ciphertext: flipped })).toThrow();
    expect(() => openBinding(KEY, A, { ...sealed, ciphertext: Buffer.alloc(3) })).toThrow();
  });

  it("matches the Go side's vector (packages/egress-proxy binding_test.go)", () => {
    // Produced by Node with a fixed nonce; Go opens the same bytes.
    const sealed = {
      keyId: bindingKeyId(KEY),
      nonce: Buffer.from("000102030405060708090a0b", "hex"),
      ciphertext: Buffer.from(VECTOR_CIPHERTEXT, "hex"),
    };
    expect(openBinding(KEY, A, sealed)).toBe("aoc_vector_token");
    expect(bindingKeyId(KEY)).toBe(VECTOR_KEY_ID);
  });

  it("parses the key as base64 of 32 bytes and never quotes a bad one", () => {
    const raw = randomBytes(32);
    expect(parseBindingKey(raw.toString("base64")).equals(raw)).toBe(true);
    expect(parseBindingKey(`${raw.toString("base64url")}\n`).equals(raw)).toBe(true);
    for (const bad of ["", "short", Buffer.alloc(16).toString("base64"), "!!!not base64!!!"]) {
      expect(() => parseBindingKey(bad)).toThrow(/32 bytes/);
      try {
        parseBindingKey(bad);
      } catch (error) {
        expect((error as Error).message).not.toContain(bad || "unreachable-empty");
      }
    }
  });
});

describe("binding store", () => {
  it("stores ciphertext only, notifies the proxy and removes on delete", async () => {
    const db = new FakeEgressDb();
    await putBinding(db.asPool(), KEY, A, TOKEN);
    expect(db.notifications).toEqual(["bindings"]);
    expect(JSON.stringify(db.bindings)).not.toContain(TOKEN);
    const row = db.bindings[0];
    expect(row?.key_id).toBe(bindingKeyId(KEY));
    expect(
      openBinding(KEY, A, {
        keyId: "",
        nonce: row?.nonce ?? Buffer.alloc(0),
        ciphertext: row?.ciphertext ?? Buffer.alloc(0),
      }),
    ).toBe(TOKEN);
    expect(await hasBinding(db.asPool(), A)).toBe(true);
    expect(await bindingCounts(db.asPool())).toEqual({ total: 1 });
    expect(await boundSessions(db.asPool())).toEqual([A]);
    // A new token replaces the row, it does not add one.
    await putBinding(db.asPool(), KEY, A, "aoc_replacement");
    expect(db.bindings).toHaveLength(1);
    expect(await deleteBinding(db.asPool(), A)).toBe(true);
    expect(await deleteBinding(db.asPool(), A)).toBe(false);
    expect(await hasBinding(db.asPool(), A)).toBe(false);
    expect(db.notifications).toEqual(["bindings", "bindings", "bindings"]);
  });
});

describe("session rules of a repo session", () => {
  it("creates one onecli allow per host once, and removes them with the session", async () => {
    const db = new FakeEgressDb();
    const hosts = ["github.com", "api.github.com"];
    const revision = await ensureSessionOneCliRules(db.asPool(), A, hosts);
    expect(revision).toBe(db.revision);
    expect(db.rules.map((r) => [r.session_id, r.host, r.route, r.ports.join(), r.effect])).toEqual([
      [A, "github.com", "onecli", "443", "allow"],
      [A, "api.github.com", "onecli", "443", "allow"],
    ]);
    expect(await ensureSessionOneCliRules(db.asPool(), A, hosts)).toBeUndefined();
    expect(db.rules).toHaveLength(2);
    await ensureSessionOneCliRules(db.asPool(), B, hosts);
    expect(await sessionsWithRules(db.asPool())).toEqual([A, B]);
    expect(await removeSessionRules(db.asPool(), A)).toBe(2);
    expect(await removeSessionRules(db.asPool(), A)).toBe(0);
    expect(db.rules.every((r) => r.session_id === B)).toBe(true);
  });
});

// Produced once with sealBinding's algorithm: AES-256-GCM, key = 32 x 0x07, nonce 000102030405060708090a0b,
// aad "egress-binding:v1:" + A, plaintext "aoc_vector_token".
const VECTOR_CIPHERTEXT = "79ee8a2f6b6cba3d18c0bae88d33099467108198a6479f972b51a1a0cde5971b";
const VECTOR_KEY_ID = "b08d63c5af57a516";
