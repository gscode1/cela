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
    // A server without a secret has no such row in its Details.
    await userEvent.click(
      within(screen.getByTestId("mcp-plain")).getByRole("button", { name: "Details" }),
    );
    expect(screen.queryByText("OneCLI secret")).toBeNull();
    await userEvent.click(
      within(screen.getByTestId("mcp-plain")).getByRole("button", { name: "Details" }),
    );
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

describe("MCP servers page, discovery status", () => {
  const checkedAt = new Date(Date.now() - 5 * 60_000).toISOString();

  it("shows ok with the tool count and names, failing with the error, and unknown", async () => {
    const admin = createFakeAdmin();
    admin.mcp = [
      {
        ...stored("good", null),
        reachability: "ok",
        discovery: {
          state: "ready",
          tools: 3,
          toolNames: ["search", "fetch"],
          checkedAt,
          shard: 0,
        },
      },
      {
        ...stored("bad", null),
        reachability: "failing",
        discovery: {
          state: "failed",
          tools: 0,
          error: "mcp bad connect timed out after 15000 ms",
          checkedAt,
          shard: 0,
        },
      },
      { ...stored("silent", null), discovery: { state: "unknown", tools: 0, checkedAt: null } },
      {
        ...stored("off", null),
        enabled: false,
        discovery: { state: "disabled", tools: 0, checkedAt: null },
      },
    ];
    serve(admin);
    renderApp("/mcp-servers");
    await signIn("alice-token");
    const good = await screen.findByTestId("mcp-good");
    expect(within(good).getByText("ready \u00b7 3 tools")).toBeInTheDocument();
    await userEvent.click(within(good).getByRole("button", { name: "Details" }));
    expect(screen.getByText("5 min ago")).toBeInTheDocument();
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getByText("search")).toBeInTheDocument();
    expect(screen.getByText("and 1 more")).toBeInTheDocument();

    const bad = screen.getByTestId("mcp-bad");
    expect(within(bad).getByText("failing")).toBeInTheDocument();
    // The error is in the Details, not in the row.
    expect(screen.queryByText("mcp bad connect timed out after 15000 ms")).toBeNull();
    await userEvent.click(within(bad).getByRole("button", { name: "Details" }));
    expect(screen.getByText("mcp bad connect timed out after 15000 ms")).toBeInTheDocument();
    expect(within(screen.getByTestId("mcp-silent")).getByText("unknown")).toBeInTheDocument();
    const off = screen.getByTestId("mcp-off");
    expect(within(off).getByText("disabled")).toBeInTheDocument();
    expect(within(off).queryByText("unknown")).toBeNull();
    expect(within(off).queryByText(/tools?$/)).toBeNull();
  });

  it("treats an answer without discovery (an older ingest) as unknown", async () => {
    const admin = createFakeAdmin();
    admin.mcp = [stored("old", null)];
    serve(admin);
    renderApp("/mcp-servers");
    await signIn("alice-token");
    const row = await screen.findByTestId("mcp-old");
    expect(within(row).getByText("unknown")).toBeInTheDocument();
    expect(within(row).queryByText("failing")).toBeNull();
  });
});
