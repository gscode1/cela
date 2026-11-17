import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = {
  PI_ORCH_URL: "http://orchestrator:8081",
  PI_DURABLE_DATABASE_URL: "postgres://x/y",
  PI_API_TOKENS: "alice:aaaaaaaaaaaaaaaa",
};

describe("loadConfig settings", () => {
  it("reads the admins and the env seed", () => {
    const config = loadConfig({
      ...base,
      PI_API_ADMINS: "alice, bob",
      PI_SESSION_TURN_BUDGET: "7",
    });
    expect(config.admins).toEqual(["alice", "bob"]);
    expect(config.seed.turnBudget).toBe(7);
  });

  it("has no admins by default and rejects a malformed name", () => {
    expect(loadConfig(base).admins).toEqual([]);
    expect(() => loadConfig({ ...base, PI_API_ADMINS: "Alice Smith" })).toThrow(/PI_API_ADMINS/);
  });

  it("serves no console unless PI_CONSOLE_DIR is set and not blank", () => {
    expect(loadConfig(base).consoleDir).toBeUndefined();
    expect(loadConfig({ ...base, PI_CONSOLE_DIR: "  " }).consoleDir).toBeUndefined();
    expect(loadConfig({ ...base, PI_CONSOLE_DIR: "/app/console" }).consoleDir).toBe("/app/console");
  });

  it("reads PI_CONSOLE_CATALOGS: manage by default, readOnly on request, nothing else", () => {
    expect(loadConfig(base).consoleCatalogs).toBe("manage");
    expect(loadConfig({ ...base, PI_CONSOLE_CATALOGS: "" }).consoleCatalogs).toBe("manage");
    expect(loadConfig({ ...base, PI_CONSOLE_CATALOGS: "readOnly" }).consoleCatalogs).toBe(
      "readOnly",
    );
    expect(() => loadConfig({ ...base, PI_CONSOLE_CATALOGS: "readonly" })).toThrow(
      /PI_CONSOLE_CATALOGS/,
    );
  });
});
