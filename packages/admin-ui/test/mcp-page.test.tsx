import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";

afterEach(() => {
  vi.unstubAllGlobals();
});

const stored = (name: string, onecliSecret: string | null) => ({
  name,
  url: `https://${name}.example.com/mcp`,
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret,
  revision: 1,
  source: null,
  reachability: "unknown",
  createdAt: "2026-11-17T00:00:00.000Z",
  createdBy: "alice",
  updatedAt: "2026-11-17T00:00:00.000Z",
  updatedBy: "alice",
});

/** The fake admin, plus the console configuration that turns on the catalog writes. */
function serve(admin: FakeAdmin): void {
  vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
    path === "/console/config.json"
      ? Promise.resolve(Response.json({ catalogs: "manage" }))
      : admin.fetch(path, init),
  );
}

describe("MCP servers page, OneCLI secret", () => {
  it("shows a server's secret name under Details and offers the published names when editing", async () => {
    const admin = createFakeAdmin();
    admin.mcp = [stored("github", "github-mcp"), stored("plain", null)];
    admin.mcpSecrets = { names: ["github-mcp", "linear-mcp"], source: "orchestrator" };
    serve(admin);
    renderApp("/mcp-servers");
    await signIn("alice-token");
    const row = await screen.findByTestId("mcp-github");
    // A server without a secret and with default limits has nothing to expand.
    expect(
      within(screen.getByTestId("mcp-plain")).queryByRole("button", { name: "Details" }),
    ).toBeNull();
    await userEvent.click(within(row).getByRole("button", { name: "Details" }));
    expect(screen.getByText("OneCLI secret")).toBeInTheDocument();
    expect(screen.getByText("github-mcp")).toBeInTheDocument();
    await userEvent.click(await within(row).findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("OneCLI secret (optional)")).toHaveValue("github-mcp");
    const options = [...screen.getByTestId("onecli-secret-names").querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["github-mcp", "linear-mcp"]);
  });

  it("an unknown list leaves a plain text field", async () => {
    const admin = createFakeAdmin();
    admin.mcp = [stored("github", null)];
    admin.mcpSecrets = { names: [], source: "none" };
    serve(admin);
    renderApp("/mcp-servers");
    await signIn("alice-token");
    const row = await screen.findByTestId("mcp-github");
    await userEvent.click(await within(row).findByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("OneCLI secret (optional)")).not.toHaveAttribute("list");
    expect(screen.getByText(/secret names are not known here/)).toBeInTheDocument();
  });
});
