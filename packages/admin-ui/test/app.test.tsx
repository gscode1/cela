import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDraft, setDraft } from "@/lib/drafts";
import { createFakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";
import type { FakeAdmin } from "./fake-admin";

/** The API as the tests need it: alice is an admin, bob a valid owner, anything else is unknown. */
function stubApi(overrides: Partial<FakeAdmin["settings"]> = {}): ReturnType<typeof vi.fn> {
  const admin = createFakeAdmin();
  admin.settings = { ...admin.settings, ...overrides };
  return admin.fetch;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-in", () => {
  it("asks for a token first and shows nothing of the shell", () => {
    stubApi();
    renderApp();
    expect(screen.getByLabelText("Token")).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("says invalid token for a 401", async () => {
    stubApi();
    renderApp();
    await signIn("nope");
    expect(await screen.findByText("invalid token")).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toBeInTheDocument();
  });

  it("says valid owner without admin access for a 403", async () => {
    stubApi();
    renderApp();
    await signIn("bob-token");
    expect(await screen.findByText("valid owner without admin access")).toBeInTheDocument();
  });

  it("opens the shell with every section after a good token", async () => {
    const fetchMock = stubApi();
    renderApp();
    await signIn("alice-token");
    const nav = await screen.findByRole("navigation", { name: "Console" });
    for (const title of [
      "Status",
      "Profiles",
      "Settings",
      "MCP servers",
      "Skills",
      "Egress",
      "Playground",
    ])
      expect(nav).toHaveTextContent(title);
    expect(await screen.findByRole("heading", { name: "Status" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/admin/status", expect.anything());
  });

  it("keeps the token out of browser storage", async () => {
    stubApi();
    renderApp();
    await signIn("alice-token");
    await screen.findByRole("navigation");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
  });

  it("opens the screen of a direct link after sign-in", async () => {
    stubApi();
    renderApp("/profiles");
    await signIn("alice-token");
    expect(await screen.findByRole("heading", { name: "Profiles" })).toBeInTheDocument();
  });
});

describe("sign-out", () => {
  it("drops the token, the query cache and the drafts", async () => {
    stubApi();
    const queryClient = renderApp();
    await signIn("alice-token");
    await screen.findByRole("navigation");
    setDraft("profile:coding", { instructions: "x" });
    await waitFor(() => {
      expect(queryClient.getQueryData(["settings"])).toBeDefined();
    });

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(screen.getByLabelText("Token")).toBeInTheDocument();
    expect(screen.getByLabelText("Token")).toHaveValue("");
    expect(queryClient.getQueryData(["settings"])).toBeUndefined();
    expect(getDraft("profile:coding")).toBeUndefined();
  });
});

describe("API content", () => {
  it("renders HTML-like values as text", async () => {
    const hostile = '<img src=x onerror="alert(1)"><b>bold</b>';
    const admin = createFakeAdmin();
    admin.history = [
      {
        id: "1",
        changedAt: "2026-11-17T00:00:00.000Z",
        changedBy: "<script>alert(2)</script>",
        old: null,
        new: { ...admin.settings, defaultModel: hostile },
      },
    ];
    renderApp("/settings");
    await signIn("alice-token");
    expect(await screen.findByText("<script>alert(2)</script>")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /set the initial values/ }));
    expect(screen.getAllByText(hostile, { selector: "td" }).length).toBeGreaterThan(0);
    expect(document.querySelector("main img, main b, main script")).toBeNull();
  });
});
