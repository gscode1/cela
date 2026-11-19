import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeAdmin } from "./fake-admin";
import type { FakeAdmin } from "./fake-admin";
import { renderApp, signIn } from "./render";

afterEach(() => {
  vi.unstubAllGlobals();
});

const NOW = new Date().toISOString();

const shard = (over: Record<string, unknown> = {}) => ({
  shard: 0,
  configuredRuntime: "gvisor",
  observedRuntime: "gvisor",
  networkPolicy: "enforced",
  networkPolicyCheckedAt: NOW,
  networkPolicyDetail: { state: "enforced", reason: "every denied target was blocked" },
  probeRequestedAt: null,
  updatedAt: NOW,
  ...over,
});

interface Answers {
  status: Record<string, unknown>;
  egress: Record<string, unknown>;
}

/** The fake admin plus the status endpoints it does not have, with the calls received. */
function serve(answers: Partial<Answers> = {}): { admin: FakeAdmin; calls: string[] } {
  const admin = createFakeAdmin();
  const calls: string[] = [];
  const status = answers.status ?? { shards: [shard()], networkPolicy: null, directSessions: 0 };
  const egress = answers.egress ?? {
    revision: 3,
    ruleSets: 1,
    rules: 2,
    invalid: 0,
    principals: { active: 2, withPodIp: 1, revoked: 4 },
    proxy: { replicas: [{ name: "proxy-0", revision: 3, state: "serving" }] },
  };
  vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    if (path === "/admin/status" && method === "GET") return Promise.resolve(Response.json(status));
    if (path === "/admin/status/probe")
      return Promise.resolve(Response.json({ requested: true, state: "requested" }, { status: 202 }));
    if (path === "/admin/egress/status") return Promise.resolve(Response.json(egress));
    if (path === "/admin/sandbox-sizes")
      return Promise.resolve(Response.json({ sizes: [{ name: "small" }], defaultSize: "small" }));
    return admin.fetch(path, init);
  });
  return { admin, calls };
}

async function open(): Promise<void> {
  renderApp("/status");
  await signIn("alice-token");
  await screen.findByTestId("status-row-shards");
}

const row = (id: string): HTMLElement => screen.getByTestId(`status-row-${id}`);

describe("Status page", () => {
  it("is one line per area, each with a dot and a Details button", async () => {
    serve();
    await open();
    await waitFor(() => {
      expect(row("mcp")).toHaveTextContent("No MCP server is enabled.");
    });
    for (const id of ["runtime", "network", "shards", "egress", "onecli", "mcp", "deployment"])
      expect(within(row(id)).getAllByRole("img")[0]).toBeInTheDocument();
    expect(row("runtime")).toHaveTextContent("Sandboxes run under gVisor.");
    expect(row("network")).toHaveTextContent("Enforced.");
    expect(row("shards")).toHaveTextContent("1 shard reported. last report just now");
    expect(row("egress")).toHaveTextContent("1 replica serving, in sync.");
    expect(row("onecli")).toHaveTextContent("Model credentials configured for openai");
    expect(screen.queryByTestId("status-row-direct")).toBeNull();
    expect(screen.queryByTestId("nav-problem")).toBeNull();
  });

  it("opens the details of one row only, and shows no per-shard network column", async () => {
    serve({
      status: {
        shards: [shard(), shard({ shard: 1 })],
        networkPolicy: null,
        directSessions: 0,
      },
    });
    await open();
    expect(screen.queryByRole("table")).toBeNull();
    await userEvent.click(within(row("runtime")).getByRole("button", { name: /Details/ }));
    expect(within(row("runtime")).getByTestId("runtime-1")).toHaveTextContent("gvisor");
    expect(screen.queryByRole("columnheader", { name: /network/i })).toBeNull();
    await userEvent.click(within(row("shards")).getByRole("button", { name: /Details/ }));
    expect(screen.getByRole("columnheader", { name: "Last report" })).toBeInTheDocument();
    expect(row("egress")).not.toHaveTextContent("Rules revision");
  });

  it("puts a problem first, shows the nav dot and links the failing MCP servers", async () => {
    const { admin } = serve({
      status: {
        shards: [
          shard({
            networkPolicy: "not-enforced",
            networkPolicyDetail: { state: "not-enforced", reason: "egress to 10.0.0.1 succeeded" },
          }),
        ],
        networkPolicy: {
          state: "not-enforced",
          checkedAt: NOW,
          detail: { state: "not-enforced", reason: "egress to 10.0.0.1 succeeded" },
          requestedAt: null,
        },
        directSessions: 3,
      },
    });
    admin.mcp = [
      {
        name: "github",
        url: "https://github.example.com/mcp",
        enabled: true,
        reachability: "failing",
        discovery: { state: "failed", tools: 0, error: "connection refused", checkedAt: NOW },
      },
    ];
    await open();
    const rows = (await screen.findAllByTestId(/^status-row-/)).map((r) =>
      r.getAttribute("data-testid"),
    );
    expect(rows[0]).toBe("status-row-network");
    expect(screen.getByTestId("status-row-direct")).toHaveTextContent(
      "3 live sessions with open internet.",
    );
    expect(await screen.findByTestId("nav-problem")).toBeInTheDocument();
    const link = await within(row("mcp")).findByRole("link", { name: "github" });
    expect(link).toHaveAttribute("href", "/mcp-servers");
    await userEvent.click(within(row("network")).getByRole("button", { name: /Details/ }));
    expect(row("network")).toHaveTextContent("egress to 10.0.0.1 succeeded");
  });

  it("re-checks network isolation from its own row and refreshes the page", async () => {
    const { calls } = serve();
    await open();
    await userEvent.click(within(row("network")).getByRole("button", { name: "Re-check" }));
    await waitFor(() => {
      expect(calls).toContain("POST /admin/status/probe");
    });
    const before = calls.filter((c) => c === "GET /admin/egress/status").length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(calls.filter((c) => c === "GET /admin/egress/status").length).toBeGreaterThan(before);
    });
    expect(screen.getAllByRole("button", { name: "Refresh" })).toHaveLength(1);
  });

  it("lists the deployment facts under Details", async () => {
    const { admin } = serve();
    admin.browserEnabled = true;
    await open();
    await waitFor(() => {
      expect(row("deployment")).toHaveTextContent("browser image enabled");
    });
    await userEvent.click(within(row("deployment")).getByRole("button", { name: /Details/ }));
    expect(row("deployment")).toHaveTextContent("security.allowDirectSandboxEgress");
    expect(row("deployment")).toHaveTextContent("sandbox.flavours.browser.enabled");
    expect(row("deployment")).toHaveTextContent("small (default)");
  });
});
