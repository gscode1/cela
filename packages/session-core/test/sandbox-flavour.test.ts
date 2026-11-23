import { describe, expect, it } from "vitest";
import {
  DESKTOP_NOT_ENABLED,
  SANDBOX_FLAVOURS,
  checkProfileNames,
  isSandboxFlavour,
  untrustedFlavourConflict,
  validateProfileDefinition,
} from "../src/index.js";
import type { EgressData, StoredMcpServer } from "../src/index.js";

const egress: EgressData = { revision: 0, ruleSets: [], rules: [], invalid: [] };
const credentialed = {
  server: { name: "demo", onecliSecret: "demo-key" },
} as unknown as StoredMcpServer;
const state = { mcpServers: [credentialed], egress };
const known = { tools: [], mcpServers: ["demo"], browserFlavourEnabled: true };

describe("the desktop sandbox flavour (ADR 0065)", () => {
  it("is a flavour and a valid profile definition", () => {
    expect(SANDBOX_FLAVOURS).toContain("desktop");
    expect(isSandboxFlavour("desktop")).toBe(true);
    expect(validateProfileDefinition({ sandboxFlavour: "desktop" })).toEqual({
      sandboxFlavour: "desktop",
    });
  });

  it.each(["browser", "desktop"] as const)("refuses a credentialed server for %s", (flavour) => {
    const definition = { sandboxFlavour: flavour, mcpServers: ["demo"] };
    expect(untrustedFlavourConflict(definition, state)).toBe(
      `sandboxFlavour ${flavour} cannot be combined with the credentialed MCP server "demo"`,
    );
    expect(untrustedFlavourConflict({ sandboxFlavour: flavour }, state)).toBeUndefined();
    expect(untrustedFlavourConflict({ mcpServers: ["demo"] }, state)).toBeUndefined();
  });

  it("is refused at profile write unless the deployment enables it", () => {
    expect(checkProfileNames({ sandboxFlavour: "desktop" }, known)).toBe(DESKTOP_NOT_ENABLED);
    expect(
      checkProfileNames({ sandboxFlavour: "desktop" }, { ...known, desktopFlavourEnabled: true }),
    ).toBeUndefined();
    expect(
      checkProfileNames(
        { sandboxFlavour: "desktop", mcpServers: ["demo"] },
        {
          ...known,
          desktopFlavourEnabled: true,
          untrustedConflict: (definition) => untrustedFlavourConflict(definition, state),
        },
      ),
    ).toMatch(/sandboxFlavour desktop cannot be combined with/);
  });
});
