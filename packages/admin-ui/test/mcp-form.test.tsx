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
        const body = JSON.parse(init.body as string) as { expectedRevision?: number };
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

  it("after a reload on conflict, shows and saves only the fields this admin edited", async () => {
    // Bob lowered max output to 2 KB after this form opened; this admin only edits the timeout.
    const latest = server({ maxOutputBytes: 2048, revision: 2, updatedBy: "bob" });
    const puts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((path: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          const body = JSON.parse(init.body as string) as { expectedRevision?: number };
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
      }),
    );
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
    await userEvent.type(timeout, "45");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await userEvent.click(await screen.findByRole("button", { name: "Reload the stored server" }));
    await screen.findByText(/Stored now/);
    expect(timeout).toHaveValue("45");
    expect(screen.getByLabelText("Max output (KB)")).toHaveValue("2");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(puts).toEqual([
      { timeoutMs: 45_000, expectedRevision: 1 },
      { timeoutMs: 45_000, expectedRevision: 2 },
    ]);
  });
});

/** Renders the form against a fetch that records each PUT body and answers it as saved. */
function renderForm(props: { server?: McpServer; secretNames?: readonly string[] }): {
  puts: Record<string, unknown>[];
} {
  const puts: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((_path: string, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(init.body as string) as Record<string, unknown>;
        puts.push(body);
        return Promise.resolve(Response.json({ ...server(), ...body, revision: 2 }));
      }
      return Promise.resolve(Response.json({ error: "not found" }, { status: 404 }));
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AuthProvider>
        <MemoryRouter>
          <McpForm
            server={props.server}
            usedByProfiles={false}
            {...(props.secretNames === undefined ? {} : { secretNames: props.secretNames })}
            onClose={() => undefined}
          />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { puts };
}

const NOT_LISTED = /OneCLI did not list a secret named/;

describe("McpForm OneCLI secret", () => {
  it("offers the published names and registers with the picked one", async () => {
    const { puts } = renderForm({ secretNames: ["github-mcp", "linear-mcp"] });
    const field = screen.getByRole("combobox", { name: "OneCLI secret (optional)" });
    const options = [...screen.getByTestId("onecli-secret-names").querySelectorAll("option")];
    expect(options.map((option) => option.value)).toEqual(["github-mcp", "linear-mcp"]);
    await userEvent.type(screen.getByLabelText("Name"), "github");
    await userEvent.type(screen.getByLabelText("URL"), "mcp.example.com/");
    await userEvent.click(screen.getByLabelText("No, it only reads"));
    await userEvent.type(field, "github-mcp");
    expect(screen.queryByText(NOT_LISTED)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Register" }));
    await screen.findByText("Saved.");
    expect(puts).toEqual([
      {
        url: "https://mcp.example.com/",
        readOnly: true,
        timeoutMs: 60_000,
        maxOutputBytes: 24_576,
        onecliSecret: "github-mcp",
        expectedRevision: 0,
      },
    ]);
  });

  it("warns, but still saves, a typed name the list does not have", async () => {
    const { puts } = renderForm({ server: server(), secretNames: ["github-mcp"] });
    await userEvent.type(screen.getByLabelText("OneCLI secret (optional)"), "brand-new");
    expect(screen.getByText(NOT_LISTED)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    await userEvent.click(save);
    await screen.findByText("Saved.");
    expect(puts).toEqual([{ onecliSecret: "brand-new", expectedRevision: 1 }]);
  });

  it("is a plain text field without a warning while the list is unknown", async () => {
    const { puts } = renderForm({ server: server() });
    const field = screen.getByLabelText("OneCLI secret (optional)");
    expect(field).not.toHaveAttribute("list");
    expect(screen.queryByTestId("onecli-secret-names")).toBeNull();
    expect(screen.getByText(/secret names are not known here/)).toBeInTheDocument();
    await userEvent.type(field, "anything");
    expect(screen.queryByText(NOT_LISTED)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(puts).toEqual([{ onecliSecret: "anything", expectedRevision: 1 }]);
  });

  it("refuses a name the API would refuse", async () => {
    renderForm({ server: server(), secretNames: [] });
    await userEvent.type(screen.getByLabelText("OneCLI secret (optional)"), "has space");
    // The problems show after a save attempt, and nothing is sent.
    expect(screen.queryByText(/the OneCLI secret name has at most 200/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(screen.getByText(/the OneCLI secret name has at most 200/)).toBeInTheDocument();
    expect(screen.queryByText(NOT_LISTED)).toBeNull();
  });

  it("clearing a stored secret sends null; an unchanged one is not sent", async () => {
    const { puts } = renderForm({
      server: server({ onecliSecret: "github-mcp" }),
      secretNames: ["github-mcp"],
    });
    const field = screen.getByLabelText("OneCLI secret (optional)");
    expect(field).toHaveValue("github-mcp");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await userEvent.clear(field);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved.");
    expect(puts).toEqual([{ onecliSecret: null, expectedRevision: 1 }]);
  });
});
