import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/auth";
import type { McpServer } from "@/lib/api/mcp";
import { McpForm } from "@/pages/mcp-form";

const server = (over: Partial<McpServer> = {}): McpServer => ({
  name: "github",
  url: "https://mcp.example.com/",
  transport: "streamable-http",
  enabled: true,
  readOnly: true,
  timeoutMs: 60_000,
  maxOutputBytes: 24_576,
  onecliSecret: null,
  revision: 1,
  source: null,
  reachability: "unknown",
  createdAt: "2026-11-17T00:00:00.000Z",
  createdBy: "alice",
  updatedAt: "2026-11-17T00:00:00.000Z",
  updatedBy: "alice",
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("McpForm", () => {
  it("after a reload on conflict, saves a value set back to what the form opened with", async () => {
    // Another admin raised the timeout to 120 s after this form opened at 60 s.
    const latest = server({ timeoutMs: 120_000, revision: 2, updatedBy: "bob" });
    const puts: unknown[] = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { expectedRevision?: number };
        puts.push(body);
        return Promise.resolve(
          body.expectedRevision === 2
            ? Response.json({ ...latest, ...body, revision: 3 })
            : Response.json({ error: "stale" }, { status: 409 }),
        );
      }
      if (path === "/admin/mcp-servers")
        return Promise.resolve(Response.json({ servers: [latest], invalid: [] }));
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AuthProvider>
          <MemoryRouter>
            <McpForm server={server()} usedByProfiles={false} onClose={() => undefined} />
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    );
    const timeout = screen.getByLabelText("Timeout (seconds)");
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "90");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reload the stored server" }));
    await screen.findByText(/Stored now/);
    // Back to the value the form opened with: still a change from the stored 120 s.
    await userEvent.clear(timeout);
    await userEvent.type(timeout, "60");
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await screen.findByText("Saved.");
    expect(puts).toEqual([
      { timeoutMs: 90_000, expectedRevision: 1 },
      { timeoutMs: 60_000, expectedRevision: 2 },
    ]);
  });
});
