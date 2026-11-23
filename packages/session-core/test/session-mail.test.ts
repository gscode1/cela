import { describe, expect, it } from "vitest";
import {
  checkProfileNames,
  directModeConflict,
  parseSessionMailServer,
  putMcpServer,
  putProfile,
  untrustedFlavourConflict,
} from "../src/index.js";
import type { EgressData, ProfileDefinition, StoredMcpServer } from "../src/index.js";
import { FakeSettingsDb } from "./fake-settings-db.js";

const egress: EgressData = { revision: 0, ruleSets: [], rules: [], invalid: [] };
const stored = (name: string, onecliSecret: string | null) =>
  ({ server: { name, onecliSecret } }) as unknown as StoredMcpServer;
const state = { mcpServers: [stored("mail", "mail-key"), stored("docs", "docs-key")], egress };

describe("the session mail server and the browser exception (ADR 0067)", () => {
  it("is off unless a valid catalog name is set", () => {
    expect(parseSessionMailServer(undefined)).toBeUndefined();
    expect(parseSessionMailServer("  ")).toBeUndefined();
    expect(parseSessionMailServer("mail")).toBe("mail");
    expect(() => parseSessionMailServer("Not A Name")).toThrow(/PI_SESSION_MAIL_SERVER/);
  });

  it("lets a browser profile name the configured server only", () => {
    const mail: ProfileDefinition = { sandboxFlavour: "browser", mcpServers: ["mail"] };
    expect(untrustedFlavourConflict(mail, state, "mail")).toBeUndefined();
    // Not configured: no exception anywhere.
    expect(untrustedFlavourConflict(mail, state)).toMatch(/credentialed MCP server "mail"/);
    expect(untrustedFlavourConflict(mail, state, "other")).toMatch(/"mail"/);
    // Any other credentialed server is still refused, also next to the mail server.
    expect(
      untrustedFlavourConflict(
        { sandboxFlavour: "browser", mcpServers: ["mail", "docs"] },
        state,
        "mail",
      ),
    ).toMatch(/"docs"/);
  });

  it("keeps refusing the mail server for a desktop profile and for the direct network mode", () => {
    expect(
      untrustedFlavourConflict({ sandboxFlavour: "desktop", mcpServers: ["mail"] }, state, "mail"),
    ).toMatch(/sandboxFlavour desktop cannot be combined with the credentialed MCP server "mail"/);
    expect(directModeConflict({ networkMode: "direct", mcpServers: ["mail"] }, state)).toMatch(
      /networkMode direct cannot be combined with the credentialed MCP server "mail"/,
    );
  });

  it("never excepts a route=onecli rule for a browser profile", () => {
    const withRoute: EgressData = {
      revision: 1,
      ruleSets: [{ name: "all", appliesToAll: true }],
      rules: [{ ruleSet: "all", effect: "allow", route: "onecli", host: "api.example.com" }],
      invalid: [],
    } as unknown as EgressData;
    expect(
      untrustedFlavourConflict(
        { sandboxFlavour: "browser", mcpServers: ["mail"] },
        { mcpServers: state.mcpServers, egress: withRoute },
        "mail",
      ),
    ).toMatch(/route onecli rule/);
  });

  it("is accepted at profile write only when configured, and refused for direct", () => {
    const known = {
      tools: [],
      mcpServers: ["mail"],
      browserFlavourEnabled: true,
      allowDirectEgress: true,
    };
    const browser: ProfileDefinition = { sandboxFlavour: "browser", mcpServers: ["mail"] };
    const withMail = (mailServer: string | undefined) => ({
      ...known,
      untrustedConflict: (d: Parameters<typeof untrustedFlavourConflict>[0]) =>
        untrustedFlavourConflict(d, state, mailServer),
      directConflict: (d: Parameters<typeof directModeConflict>[0]) => directModeConflict(d, state),
    });
    expect(checkProfileNames(browser, withMail("mail"))).toBeUndefined();
    expect(checkProfileNames(browser, withMail(undefined))).toMatch(/cannot be combined/);
    expect(
      checkProfileNames({ networkMode: "direct", mcpServers: ["mail"] }, withMail("mail")),
    ).toMatch(/networkMode direct cannot be combined/);
  });

  describe("the catalog side", () => {
    const KNOWN = {
      tools: ["read"],
      mcpServers: ["mail"],
      browserFlavourEnabled: true,
      desktopFlavourEnabled: true,
      allowDirectEgress: true,
    };
    const BASE = { url: "https://mail.example.com/mcp", readOnly: true };

    async function setUp(extra: Record<string, unknown>) {
      const db = new FakeSettingsDb();
      db.setRow();
      const pool = db.asPool();
      await putMcpServer(pool, "mail", BASE, "alice");
      await putProfile(
        pool,
        "web",
        { definition: { tools: ["read"], mcpServers: ["mail"], ...extra } },
        "alice",
        KNOWN,
      );
      return pool;
    }
    const secret = { onecliSecret: "mail-key" };

    it("accepts a secret on the configured server while a browser profile names it", async () => {
      const pool = await setUp({ sandboxFlavour: "browser" });
      expect(
        await putMcpServer(pool, "mail", secret, "alice", undefined, { mailServer: "mail" }),
      ).toMatchObject({
        stored: { server: { onecliSecret: "mail-key" } },
      });
    });

    it.each([
      ["not configured", undefined, { sandboxFlavour: "browser" }, "sandboxFlavour browser"],
      ["another name", "docs", { sandboxFlavour: "browser" }, "sandboxFlavour browser"],
      ["a desktop profile", "mail", { sandboxFlavour: "desktop" }, "sandboxFlavour desktop"],
      ["a direct profile", "mail", { networkMode: "direct" }, "networkMode direct"],
      [
        "a direct browser profile",
        "mail",
        { sandboxFlavour: "browser", networkMode: "direct" },
        "networkMode direct",
      ],
    ])("refuses a secret: %s", async (_label, mailServer, extra, words) => {
      const pool = await setUp(extra);
      expect(await putMcpServer(pool, "mail", secret, "alice", undefined, { mailServer })).toEqual(
        expect.stringContaining(`web (${words})`),
      );
    });
  });
});
