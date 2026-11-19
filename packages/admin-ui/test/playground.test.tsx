import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";

const entry = (id: number, messages: unknown[]): string =>
  `id: ${String(id)}\nevent: entry\ndata: ${JSON.stringify({ id, kind: "message", messages })}\n\n`;
const live = (state: Record<string, unknown>): string =>
  `event: live\ndata: ${JSON.stringify(state)}\n\n`;

function setup(path = "/playground"): FakeAdmin {
  const admin = createFakeAdmin();
  admin.profiles.push({
    name: "research",
    currentVersion: 1,
    revision: 1,
    enabledForNew: true,
    versions: [{ version: 1, definition: { mcpServers: ["demo"] }, createdBy: "alice" }],
  });
  admin.mcp.push({ name: "demo", url: "https://demo.example/mcp", enabled: true });
  renderApp(path);
  return admin;
}

async function toolCall(name: string): Promise<HTMLElement> {
  return waitFor(() => {
    const found = document.querySelector<HTMLElement>(
      `[data-testid="tool-call"][data-tool="${name}"]`,
    );
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
}

async function start(admin: FakeAdmin): Promise<void> {
  await signIn("alice-token");
  await userEvent.click(await screen.findByRole("button", { name: "Start session" }));
  await waitFor(() => {
    expect(admin.streams).toHaveLength(1);
  });
  await screen.findByTestId("session-id");
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Playground", () => {
  it("is in the navigation and says it spends real tokens", async () => {
    setup();
    await signIn("alice-token");
    expect(await screen.findByRole("link", { name: "Playground" })).toBeInTheDocument();
    expect(screen.getByText(/spends\s+model tokens/)).toBeInTheDocument();
  });

  it("preselects the default profile, and the profile that uses the server of the link", async () => {
    const admin = setup();
    await signIn("alice-token");
    const select = await screen.findByLabelText("Profile");
    await waitFor(() => {
      expect(select).toHaveValue("coding");
    });
    expect(admin.sessions).toHaveLength(0);
  });

  it("opens with the profile that names the MCP server from the link", async () => {
    setup("/playground?mcp=demo");
    await signIn("alice-token");
    const select = await screen.findByLabelText("Profile");
    await waitFor(() => {
      expect(select).toHaveValue("research");
    });
    expect(screen.getByTestId("profile-servers")).toHaveTextContent("MCP servers: demo");
  });

  it("starts a session, sends a message and shows tool calls with their results", async () => {
    const admin = setup();
    await start(admin);
    expect(admin.sessions[0]?.body).toEqual({ profile: "coding" });

    await userEvent.type(screen.getByLabelText("Message"), "echo hi");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => {
      expect(admin.sent).toEqual([
        { id: admin.sessions[0]?.id, body: { kind: "message", text: "echo hi" } },
      ]);
    });

    admin.emit(
      entry(1, [{ role: "user", text: "echo hi" }]) +
        entry(2, [
          {
            role: "assistant",
            text: "Calling the tool <img src=x onerror=alert(1)>",
            calls: ['mcp__demo__echo({"text":"hi"})', "bash(false)"],
          },
        ]) +
        entry(3, [{ role: "toolResult", text: "hi", isError: false }]) +
        entry(4, [{ role: "toolResult", text: "exit 1", isError: true }]) +
        live({ running: false, queued: 0 }),
    );

    const mcp = await toolCall("mcp__demo__echo");
    expect(within(mcp).getByText("MCP demo")).toBeInTheDocument();
    expect(within(mcp).getByText("echo")).toBeInTheDocument();
    expect(within(mcp).getByText("hi")).toBeInTheDocument();
    expect(within(mcp).getByText("ok")).toBeInTheDocument();
    const bash = await toolCall("bash");
    expect(within(bash).getByText("error")).toBeInTheDocument();
    expect(within(bash).getByText("exit 1")).toBeInTheDocument();
    // Model text is text, never markup.
    expect(screen.getByText(/Calling the tool <img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("folds a long result and keeps the answer in progress apart", async () => {
    const admin = setup();
    await start(admin);
    admin.emit(
      entry(1, [{ role: "assistant", text: "", calls: ["bash(cat big)"] }]) +
        entry(2, [{ role: "toolResult", text: "x".repeat(2000), isError: false }]) +
        live({ running: true, queued: 0, partial: "Working on it" }),
    );
    const tool = await screen.findByTestId("tool-call");
    expect(within(tool).getByText(/Result \(2000 characters\)/)).toBeInTheDocument();
    expect(
      within(tool)
        .getByText(/^x{2000}$/)
        .closest("details"),
    ).not.toHaveAttribute("open");
    expect(await screen.findByTestId("msg-partial")).toHaveTextContent("Working on it");
    expect(screen.getByText("agent working")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop turn" }));
    await waitFor(() => {
      expect(admin.sent.at(-1)?.body).toEqual({ kind: "cancel" });
    });
  });

  it("reconnects after the stream ends and resumes after the last entry", async () => {
    const admin = setup();
    await start(admin);
    admin.emit(entry(7, [{ role: "user", text: "first" }]));
    await screen.findByText("first");
    admin.closeStream();
    await waitFor(
      () => {
        expect(admin.streams).toHaveLength(2);
      },
      { timeout: 3000 },
    );
    expect(admin.streams[1]?.lastEventId).toBe("7");
    admin.emit(
      entry(7, [{ role: "user", text: "first" }]) + entry(8, [{ role: "user", text: "second" }]),
    );
    await screen.findByText("second");
    expect(screen.getAllByText("first")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByTestId("connection")).toHaveTextContent("connected");
    });
  });

  it("warns before the tab closes while a session is live, and ends it with End session", async () => {
    const admin = setup();
    await start(admin);
    const warn = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(warn);
    expect(warn.defaultPrevented).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "End session" }));
    await waitFor(() => {
      expect(admin.sessions[0]?.deleted).toBe(true);
    });
    expect(await screen.findByText(/This session has ended/)).toBeInTheDocument();
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(localStorage.getItem("playground-sessions")).toBeNull();
  });

  it("lists sessions that are still open, and ends one", async () => {
    const admin = setup();
    await start(admin);
    const id = admin.sessions[0]?.id ?? "";
    expect(localStorage.getItem("playground-sessions")).toContain(id);
    // A reload forgets the page state but not the browser's list.
    document.body.innerHTML = "";
    const again = setup();
    again.sessions.push({ id, body: {}, deleted: false });
    await signIn("alice-token");
    const open = await screen.findByTestId("open-sessions");
    await userEvent.click(within(open).getByRole("button", { name: "End" }));
    await waitFor(() => {
      expect(again.sessions[0]?.deleted).toBe(true);
    });
    await waitFor(() => {
      expect(screen.queryByTestId("open-sessions")).not.toBeInTheDocument();
    });
  });

  it("drops a remembered session the server no longer knows", async () => {
    localStorage.setItem(
      "playground-sessions",
      JSON.stringify([
        {
          id: "11111111-1111-4111-8111-111111111111",
          profile: "coding",
          startedAt: "2026-11-17T00:00:00.000Z",
        },
      ]),
    );
    setup();
    await signIn("alice-token");
    await screen.findByRole("button", { name: "Start session" });
    await waitFor(() => {
      expect(localStorage.getItem("playground-sessions")).toBeNull();
    });
    expect(screen.queryByTestId("open-sessions")).not.toBeInTheDocument();
  });
});

describe("MCP servers page", () => {
  it("links each server to the playground with that server", async () => {
    const admin = createFakeAdmin();
    admin.mcp.push({
      name: "demo",
      url: "https://demo.example/mcp",
      transport: "streamable-http",
      enabled: true,
      readOnly: true,
      timeoutMs: 60000,
      maxOutputBytes: 24576,
      onecliSecret: null,
      revision: 1,
      source: null,
      reachability: "unknown",
      createdAt: "2026-11-17T00:00:00.000Z",
      createdBy: "alice",
      updatedAt: "2026-11-17T00:00:00.000Z",
      updatedBy: "alice",
    });
    renderApp("/mcp-servers");
    await signIn("alice-token");
    const link = await screen.findByRole("link", { name: "Try in playground" });
    expect(link).toHaveAttribute("href", "/playground?mcp=demo");
  });
});
