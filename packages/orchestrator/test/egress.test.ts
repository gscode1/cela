import { describe, expect, it } from "vitest";
import { inspect } from "node:util";
import type { SessionRow } from "@pi-durable-k8s/session-core";
import { buildShellEnv } from "../src/workspace.ts";
import {
  buildEgressEnv,
  EgressPrincipals,
  POD_IP_RECHECK_MS,
  usesEgressProxy,
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

function setup(now: () => number = () => 0) {
  const db = new FakeEgressDb();
  const egress = new EgressPrincipals({
    pool: db.asPool(),
    proxyUrl: PROXY,
    master: () => MASTER,
    now,
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
  it("serves plain sessions only: a repo session keeps the OneCLI environment until slice 5", async () => {
    const { egress, db } = setup();
    expect(usesEgressProxy({ repo: null })).toBe(true);
    expect(usesEgressProxy({ repo: { repo: "o/r" } })).toBe(false);
    const repo = session(A, { repo: { repo: "o/r" } });
    expect(await egress.shellEnv(repo)).toBeUndefined();
    await egress.attached(repo, "10.244.0.9");
    expect(db.principals).toHaveLength(0);
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
    expect(env?.HTTPS_PROXY).toMatch(
      /^http:\/\/x:[A-Za-z0-9_-]{43}@pi-egress-proxy\.ns\.svc:3128$/,
    );
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

  it("never prints the token: not in JSON, inspect or a thrown error of the env builder", () => {
    const token = new Redacted("super-secret-egress-token");
    for (const text of [JSON.stringify({ token }), inspect(token), token.toString()]) {
      expect(text).not.toContain("super-secret-egress-token");
    }
  });
});
