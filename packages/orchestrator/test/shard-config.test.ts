import { describe, expect, it } from "vitest";
import { loadConfig, shardSchema } from "../src/config.ts";

const env = {
  PI_ORCH_NAMESPACE: "test-ns",
  PI_ORCH_WARMPOOL: "test-pool",
  PI_ONECLI_GATEWAY: "http://gateway:10255",
  PI_ONECLI_API: "http://gateway-api:10256",
  PI_DURABLE_DATABASE_URL: "postgres://u:p@db:5432/app",
  PI_API_TOKENS: "alice:0123456789abcdef0123",
};

describe("shard schema", () => {
  it("keeps today's schema for shard 0 and derives <schema>_s<k> for the others", () => {
    expect(shardSchema("pi_durable", 0)).toBe("pi_durable");
    expect(shardSchema("pi_durable", 1)).toBe("pi_durable_s1");
    expect(shardSchema("public", 12)).toBe("public_s12");
  });

  it("rejects a schema name that is not a plain identifier, and a bad shard", () => {
    for (const name of ["Pi", "a-b", "1a", "a;b", 'a"b', ""]) {
      expect(() => shardSchema(name, 0), name).toThrow(/PI_DURABLE_SCHEMA/);
    }
    for (const shard of [-1, 1.5, Number.NaN]) {
      expect(() => shardSchema("pi", shard), String(shard)).toThrow(/PI_ORCH_SHARD/);
    }
    expect(() => shardSchema("a".repeat(62), 1)).toThrow(/63/);
  });

  it("reads PI_ORCH_SHARD, default 0, into the shard and its schema", () => {
    expect(loadConfig({ ...env, PI_DURABLE_SCHEMA: "pi" })).toMatchObject({
      shard: 0,
      schema: "pi",
    });
    expect(loadConfig({ ...env, PI_DURABLE_SCHEMA: "pi", PI_ORCH_SHARD: "2" })).toMatchObject({
      shard: 2,
      schema: "pi_s2",
    });
    expect(() => loadConfig({ ...env, PI_ORCH_SHARD: "x" })).toThrow(/PI_ORCH_SHARD/);
  });
});
