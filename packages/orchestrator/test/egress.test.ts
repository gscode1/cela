import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import { openBinding } from "@cela/session-core";
import type { SessionRow } from "@cela/session-core";
import { buildShellEnv } from "../src/workspace.ts";
import {
  buildEgressEnv,
  EgressPrincipals,
  POD_IP_RECHECK_MS,
  PROPAGATION_WAIT_MS,
} from "../src/egress.ts";
import { Redacted } from "../src/onecli.ts";
import { FakeEgressDb } from "../../session-core/test/fake-egress-db.ts";

const MASTER = "master-key-for-tests";
const PROXY = "http://pi-egress-proxy.ns.svc:3128";
const A = "aaaaaaaa-1111-4111-8111-111111111111";
const B = "bbbbbbbb-2222-4222-8222-222222222222";

function session(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    status: "active",
    repo: null,
    profile: {
      name: "coding",
      version: 2,
      snapshot: { instructions: "x", egressRuleSets: ["npm", "pypi"] },
    },
    ...over,
  } as SessionRow;
}

const BINDING_KEY = Buffer.alloc(32, 9);
const repoSession = (id: string) => session(id, { repo: { repo: "o/r" } });

function setup(now: () => number = () => 0, bindingKey: Buffer | null = BINDING_KEY) {
  const db = new FakeEgressDb();
  const egress = new EgressPrincipals({
    pool: db.asPool(),
    proxyUrl: PROXY,
    resolve: () => Promise.resolve("10.96.1.2"),
    bindingKey: bindingKey ?? undefined,
    master: () => MASTER,
    now,
    sleep: () => Promise.resolve(),
  });
  return { db, egress };
}

describe("buildEgressEnv", () => {
  it("sets the proxy variables in both cases, the exclusions, Node's switch and git's basic auth", () => {
    const env = buildEgressEnv({ proxy: PROXY, token: new Redacted("tok-123") });
    const url = "http://x:tok-123@pi-egress-proxy.ns.svc:3128";
    expect(env).toMatchObject({
      HTTP_PROXY: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      https_proxy: url,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.proxyAuthMethod",
      GIT_CONFIG_VALUE_0: "basic",
    });
  });

  it("does not look like the OneCLI environment: no CA variables, no OneCLI gateway", () => {
    const egress = buildEgressEnv({ proxy: PROXY, token: new Redacted("tok") });
    const onecli = buildShellEnv({ gateway: "http://gw:10255", token: new Redacted("tok") });
    expect(egress).not.toHaveProperty("SSL_CERT_FILE");
    expect(egress).not.toHaveProperty("NODE_EXTRA_CA_CERTS");
    expect(onecli.HTTPS_PROXY).toContain("gw:10255");
    expect(egress.HTTPS_PROXY).not.toContain("gw:10255");
  });
});

describe("EgressPrincipals", () => {
  it("gives the sandbox the proxy's address, not its name: a proxied sandbox has no DNS (ADR 0038)", async () => {
    let lookups = 0;
    let clock = 0;
    const db = new FakeEgressDb();
    const egress = new EgressPrincipals({
      pool: db.asPool(),
      proxyUrl: PROXY,
      master: () => MASTER,
      now: () => clock,
      resolve: (host) => {
        lookups += 1;
        return Promise.resolve(host === "pi-egress-proxy.ns.svc" ? "10.96.1.2" : undefined);
      },
    });
    const env = await egress.shellEnv(session(A));
    expect(env?.HTTPS_PROXY).toMatch(/^http:\/\/x:[^@]+@10\.96\.1\.2:3128$/);
    expect(env?.HTTPS_PROXY).not.toContain("pi-egress-proxy");
    await egress.shellEnv(session(B));
    expect(lookups).toBe(1);
    clock += 61_000;
    await egress.shellEnv(session(A));
    expect(lookups).toBe(2);
  });

  it("fails the call when the proxy name does not resolve, rather than hand out an unusable proxy", async () => {
    const db = new FakeEgressDb();
    const egress = new EgressPrincipals({
      pool: db.asPool(),
      proxyUrl: PROXY,
      master: () => MASTER,
      resolve: () => Promise.resolve(undefined),
    });
    await expect(egress.shellEnv(session(A))).rejects.toThrow(/does not resolve/);
  });

  it("gives a direct session no principal, no token and no proxy environment (ADR 0038)", async () => {
    const { egress, db } = setup();
    const direct = session(A, { networkMode: "direct", profile: null });
    expect(await egress.shellEnv(direct)).toBeUndefined();
    await egress.attached(direct, "10.1.2.3");
    expect(db.principals).toHaveLength(0);
    // The same session as proxied does get one.
    expect(await egress.shellEnv(session(A, { networkMode: "proxied" }))).toBeDefined();
  });

  it("serves repo sessions too: a principal and the proxy environment, no OneCLI variable", async () => {
    const { egress, db } = setup();
    const repo = repoSession(A);
    await egress.attached(repo, "10.244.0.9");
    expect(db.principals).toHaveLength(1);
    const env = await egress.shellEnv(repo);
    expect(env?.HTTPS_PROXY).toContain("@10.96.1.2:3128");
  });

  it("creates the principal on attach with the profile's rule sets and the Pod address, then hands out the env", async () => {
    const { egress, db } = setup();
    await egress.attached(session(A), "10.244.0.9");
    expect(db.principals[0]).toMatchObject({
      session_id: A,
      profile_name: "coding",
      profile_version: 2,
      rule_sets: ["npm", "pypi"],
      pod_ip: "10.244.0.9",
    });
    const env = await egress.shellEnv(session(A));
    expect(env?.HTTPS_PROXY).toMatch(/^http:\/\/x:[A-Za-z0-9_-]{43}@10\.96\.1\.2:3128$/);
    // The password is the token whose hash the principal holds, and never the hash or the salt.
    const token = new URL(env?.HTTPS_PROXY ?? "").password;
    expect(db.principals[0]?.token_hash).not.toContain(token);
    expect(JSON.stringify(db.principals)).not.toContain(token);
    // Another session's token differs.
    const other = await egress.shellEnv(session(B));
    expect(new URL(other?.HTTPS_PROXY ?? "").password).not.toBe(token);
  });

  it("hands out the same token after a restart (a new instance over the same rows)", async () => {
    const { egress, db } = setup();
    const first = await egress.shellEnv(session(A));
    const restarted = new EgressPrincipals({
      pool: db.asPool(),
      proxyUrl: PROXY,
      resolve: () => Promise.resolve("10.96.1.2"),
      master: () => MASTER,
    });
    expect((await restarted.shellEnv(session(A)))?.HTTPS_PROXY).toBe(first?.HTTPS_PROXY);
  });

  it("falls back to no rule sets when the profile snapshot does not validate", async () => {
    const { egress, db } = setup();
    await egress.shellEnv(session(A, { profile: { name: "p", version: 1, snapshot: "nonsense" } }));
    expect(db.principals[0]?.rule_sets).toEqual([]);
    await egress.shellEnv(session(B, { profile: null }));
    expect(db.principals[1]).toMatchObject({ profile_name: null, rule_sets: [] });
  });

  it("revokes on delete: no env after, no address, idempotent", async () => {
    const { egress, db } = setup();
    await egress.attached(session(A), "10.244.0.9");
    await egress.revoke(A);
    await egress.revoke(A);
    expect(db.principals[0]?.revoked_at).not.toBeNull();
    expect(db.principals[0]?.pod_ip).toBeNull();
    expect(await egress.shellEnv(session(A))).toBeUndefined();
    await egress.attached(session(A), "10.244.0.10");
    expect(db.principals[0]?.pod_ip).toBeNull();
    expect(await egress.shellEnv(session(B, { status: "deleting" }))).toBeUndefined();
  });

  it("re-reads a replaced Pod's address, at most every 10 s", async () => {
    let now = 1_000;
    const { egress, db } = setup(() => now);
    await egress.attached(session(A), "10.244.0.9");
    let reads = 0;
    let ip: string | undefined = "10.244.0.9";
    const read = () => {
      reads++;
      return Promise.resolve(ip);
    };
    await egress.beforeUse(session(A), read);
    expect(reads).toBe(0);
    now += POD_IP_RECHECK_MS;
    await egress.beforeUse(session(A), read);
    expect(reads).toBe(1);
    ip = "10.244.1.1";
    await egress.beforeUse(session(A), read);
    expect(reads).toBe(1); // checked a moment ago
    now += POD_IP_RECHECK_MS;
    await egress.beforeUse(session(A), read);
    expect(db.principals[0]?.pod_ip).toBe("10.244.1.1");
  });

  it("seals the repo session's OneCLI token, then creates the onecli rules, and writes neither twice", async () => {
    const { egress, db } = setup();
    await egress.bindOneCli(repoSession(A), new Redacted("aoc_a"), [
      "github.com",
      "api.github.com",
    ]);
    expect(db.bindings).toHaveLength(1);
    const row = db.bindings[0];
    expect(JSON.stringify(db.bindings)).not.toContain("aoc_a");
    expect(
      openBinding(BINDING_KEY, A, {
        keyId: row?.key_id ?? "",
        nonce: row?.nonce ?? Buffer.alloc(0),
        ciphertext: row?.ciphertext ?? Buffer.alloc(0),
      }),
    ).toBe("aoc_a");
    expect(db.rules.map((r) => [r.session_id, r.host, r.route])).toEqual([
      [A, "github.com", "onecli"],
      [A, "api.github.com", "onecli"],
    ]);
    const writes = db.notifications.length;
    await egress.bindOneCli(repoSession(A), new Redacted("aoc_a"), [
      "github.com",
      "api.github.com",
    ]);
    expect(db.notifications.length).toBe(writes);
    // A replaced agent has a new token: the binding is rewritten, the rules stay.
    await egress.bindOneCli(repoSession(A), new Redacted("aoc_a2"), [
      "github.com",
      "api.github.com",
    ]);
    expect(db.bindings).toHaveLength(1);
    expect(db.rules).toHaveLength(2);
    expect(db.notifications.length).toBe(writes + 1);
  });

  it("refuses to bind without a key, and says so up front", async () => {
    const { egress, db } = setup(() => 0, null);
    expect(egress.canBind()).toBe(false);
    await expect(
      egress.bindOneCli(repoSession(A), new Redacted("aoc_a"), ["github.com"]),
    ).rejects.toThrow(/binding key/);
    expect(db.bindings).toHaveLength(0);
    expect(db.rules).toHaveLength(0);
  });

  it("waits for every serving proxy to read the rule's revision, and for nobody else", async () => {
    let now = 0;
    const { db } = setup(() => now);
    const status = (replica: string, revision: number | null, state: string, silent = 1) =>
      db.proxyStatus.push({
        replica,
        revision,
        state,
        last_read_at: null,
        started_at: new Date(0),
        version: "t",
        updated_at: new Date(0),
        silent_seconds: silent,
      });
    status("up-to-date", 1, "serving");
    status("behind", 0, "serving");
    status("stale", 0, "stale");
    status("gone", 0, "serving", 600);
    const sleeps: number[] = [];
    const slow = new EgressPrincipals({
      pool: db.asPool(),
      proxyUrl: PROXY,
      resolve: () => Promise.resolve("10.96.1.2"),
      bindingKey: BINDING_KEY,
      master: () => MASTER,
      now: () => now,
      sleep: (ms) => {
        sleeps.push(ms);
        now += ms;
        if (sleeps.length === 3) {
          const behind = db.proxyStatus.find((r) => r.replica === "behind");
          if (behind !== undefined) behind.revision = db.revision;
        }
        return Promise.resolve();
      },
    });
    await slow.bindOneCli(repoSession(A), new Redacted("aoc_a"), ["github.com"]);
    expect(sleeps).toHaveLength(3);
    // A replica that never catches up does not hold the session forever.
    const stuck = setup(() => now);
    stuck.db.proxyStatus.push({
      replica: "behind",
      revision: 0,
      state: "serving",
      silent_seconds: 1,
    } as never);
    const before = now;
    const waiting = new EgressPrincipals({
      pool: stuck.db.asPool(),
      proxyUrl: PROXY,
      resolve: () => Promise.resolve("10.96.1.2"),
      bindingKey: BINDING_KEY,
      master: () => MASTER,
      now: () => now,
      sleep: (ms) => {
        now += ms;
        return Promise.resolve();
      },
    });
    await waiting.bindOneCli(repoSession(B), new Redacted("aoc_b"), ["github.com"]);
    expect(now - before).toBeGreaterThanOrEqual(PROPAGATION_WAIT_MS);
    expect(stuck.db.bindings).toHaveLength(1);
  });

  it("revokes principal, binding and session rules together, idempotently, and lists what is left for the sweep", async () => {
    const { egress, db } = setup();
    await egress.attached(repoSession(A), "10.244.0.9");
    await egress.bindOneCli(repoSession(A), new Redacted("aoc_a"), ["github.com"]);
    await egress.attached(repoSession(B), "10.244.0.10");
    await egress.bindOneCli(repoSession(B), new Redacted("aoc_b"), ["github.com"]);
    expect(await egress.live()).toEqual([A, B]);
    await egress.revoke(A);
    await egress.revoke(A);
    expect(db.principals.find((p) => p.session_id === A)?.revoked_at).not.toBeNull();
    expect(db.bindings.map((b) => b.session_id)).toEqual([B]);
    expect(db.rules.map((r) => r.session_id)).toEqual([B]);
    expect(await egress.live()).toEqual([B]);
    // A binding or rule left behind without a live principal is still listed for the sweep.
    await egress.revoke(B);
    db.bindings.push({
      session_id: A,
      key_id: "0".repeat(16),
      nonce: Buffer.alloc(12),
      ciphertext: Buffer.alloc(20),
    });
    expect(await egress.live()).toEqual([A]);
  });

  it("never prints the token: not in JSON, inspect or a thrown error of the env builder", () => {
    const token = new Redacted("super-secret-egress-token");
    for (const text of [JSON.stringify({ token }), inspect(token), token.toString()]) {
      expect(text).not.toContain("super-secret-egress-token");
    }
  });
});
