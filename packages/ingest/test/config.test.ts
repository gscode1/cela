import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = { PI_DURABLE_DATABASE_URL: "postgres://x/y", PI_API_TOKENS: "alice:aaaaaaaaaaaaaaaa" };

describe("loadConfig", () => {
  it("defaults the port and orchestrator URL when unset", () => {
    const config = loadConfig(base);
    expect(config.port).toBe(8080);
    expect(config.orchestratorUrl).toBe("http://pi-orchestrator:8081");
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
});
