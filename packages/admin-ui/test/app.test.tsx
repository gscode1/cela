import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "@/app";
import { AuthProvider } from "@/auth";
import { getDraft, setDraft } from "@/lib/drafts";

const settings = {
  defaultModel: "scripted/scripted-1",
  allowlist: ["scripted/scripted-1"],
  reasoning: null,
  maxReasoning: null,
  defaultProfile: "coding",
  turnBudget: 100,
  updatedAt: "2026-11-17T00:00:00.000Z",
  updatedBy: "alice",
};

/** The API as the tests need it: alice is an admin, bob a valid owner, anything else is unknown. */
function stubApi(data: Record<string, unknown> = settings): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((_path: string, init: RequestInit) => {
    const auth = (init.headers as Record<string, string>).authorization;
    if (auth === "Bearer alice-token") return Promise.resolve(Response.json(data));
    if (auth === "Bearer bob-token")
      return Promise.resolve(Response.json({ error: "forbidden" }, { status: 403 }));
    return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderApp(path = "/"): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

async function signIn(token: string): Promise<void> {
  await userEvent.type(screen.getByLabelText("Token"), token);
  await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
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
      "Global settings",
      "Session profiles",
      "MCP servers",
      "Skills",
      "Shard status",
    ])
      expect(nav).toHaveTextContent(title);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/admin/settings");
    expect(await screen.findByText("Default model")).toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Session profiles" })).toBeInTheDocument();
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
    stubApi({ ...settings, defaultModel: hostile, updatedBy: "<script>alert(2)</script>" });
    renderApp();
    await signIn("alice-token");
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(screen.getByText("<script>alert(2)</script>")).toBeInTheDocument();
    expect(document.querySelector("main img, main b, main script")).toBeNull();
  });
});
