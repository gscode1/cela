import { describe, expect, it } from "vitest";
import { loadConfig, orchestratorUrlFor } from "../src/config.ts";

const base = {
  PI_ORCH_URL: "http://orchestrator:8081",
  PI_DURABLE_DATABASE_URL: "postgres://x/y",
  PI_API_TOKENS: "alice:aaaaaaaaaaaaaaaa",
};

describe("loadConfig", () => {
  it("defaults the port and uses the configured orchestrator URL", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.orchestratorUrl).toBe(base.PI_ORCH_URL);
  });

  it("reads the database TLS settings, unset by default", () => {
    expect(loadConfig(base).databaseTls).toBeUndefined();
    expect(
      loadConfig({ ...base, PI_DURABLE_DATABASE_TLS_MODE: "verify-full" }).databaseTls,
    ).toEqual({ mode: "verify-full" });
    expect(() => loadConfig({ ...base, PI_DURABLE_DATABASE_TLS_MODE: "verify-ca" })).toThrow(
      /TLS_CA_FILE/,
    );
  });

  it("rejects an empty, blank, zero or malformed port instead of binding a random one", () => {
    for (const port of ["", "  ", "0", "65536", "80x", "-1", "8.5"]) {
      expect(() => loadConfig({ ...base, PI_INGEST_PORT: port }), port).toThrow(/PI_INGEST_PORT/);
    }
    expect(loadConfig({ ...base, PI_INGEST_PORT: "9090" }).port).toBe(9090);
  });

  it("rejects an orchestrator URL the stream proxy cannot use", () => {
    for (const url of ["", "pi-orchestrator:8081", "ftp://h/", "not a url", "http://"]) {
      expect(() => loadConfig({ ...base, PI_ORCH_URL: url }), url).toThrow(/PI_ORCH_URL/);
    }
    expect(loadConfig({ ...base, PI_ORCH_URL: "https://orch.example:8443" }).orchestratorUrl).toBe(
      "https://orch.example:8443",
    );
  });

  it("takes the shard count and the {shard} URL template", () => {
    expect(loadConfig(base).shards).toBe(1);
    const url = "http://pi-orchestrator-{shard}:8081";
    const config = loadConfig({ ...base, PI_ORCH_URL: url, PI_ORCH_SHARDS: "3" });
    expect(config.shards).toBe(3);
    expect(orchestratorUrlFor(config.orchestratorUrl, 2)).toBe("http://pi-orchestrator-2:8081");
    expect(orchestratorUrlFor("http://pi-orchestrator:8081", 2)).toBe(
      "http://pi-orchestrator:8081",
    );
  });

  it("rejects a bad shard count, and several shards behind one fixed URL", () => {
    for (const shards of ["", "0", "-1", "1.5", "x"]) {
      expect(() => loadConfig({ ...base, PI_ORCH_SHARDS: shards }), shards).toThrow(
        /PI_ORCH_SHARDS/,
      );
    }
    expect(() => loadConfig({ ...base, PI_ORCH_SHARDS: "2" })).toThrow(/\{shard\}/);
  });
});

it("requires an explicit shard route", () => {
  expect(() => loadConfig({ ...base, PI_ORCH_URL: undefined })).toThrow("PI_ORCH_URL is required");
}, 5_000);
