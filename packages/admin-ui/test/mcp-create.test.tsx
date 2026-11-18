import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/auth";
import { McpForm } from "@/pages/mcp-form";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpForm create", () => {
  it("registers with the create-only expectedRevision, so an existing server is not overwritten", async () => {
    const puts: { path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          puts.push({ path, body: JSON.parse(init.body as string) });
          return Promise.resolve(
            Response.json(
              { error: "MCP server github already exists: choose another name" },
              { status: 409 },
            ),
          );
        }
        return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <MemoryRouter>
            <McpForm server={undefined} usedByProfiles={false} onClose={() => undefined} />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    await userEvent.type(screen.getByLabelText("Name"), "github");
    await userEvent.type(screen.getByLabelText("URL"), "mcp.example.com/");
    await userEvent.click(screen.getByLabelText("No, it only reads"));
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(
      await screen.findByText(
        /Not registered: MCP server github already exists: choose another name\. Nothing was written\./,
      ),
    ).toBeInTheDocument();
    // A create has no stored server to reload.
    expect(screen.queryByRole("button", { name: "Reload the stored server" })).toBeNull();
    expect(puts).toEqual([
      {
        path: "/admin/mcp-servers/github",
        body: {
          url: "https://mcp.example.com/",
          readOnly: true,
          enabled: true,
          timeoutMs: 60_000,
          maxOutputBytes: 24_576,
          expectedRevision: 0,
        },
      },
    ]);
  });
});
