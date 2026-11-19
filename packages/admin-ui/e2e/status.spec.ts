import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { shot, signInAndGo } from "./catalogs-support";

// The Status page against the in-memory fake (fake-admin.mjs): it keeps the shard reports, the egress status and the
// direct session count that `PUT /__fake/status` sets, and leaves the model credentials, MCP catalog and chart facts to
// the real ingest server behind it.
test.describe("status", () => {
  test.describe.configure({ mode: "serial" });

  const report = (over: Record<string, unknown> = {}) => ({
    shard: 0,
    configuredRuntime: "gvisor",
    observedRuntime: "gvisor",
    networkPolicy: "enforced",
    networkPolicyCheckedAt: new Date().toISOString(),
    networkPolicyDetail: { state: "enforced", reason: "every verified denied target was blocked" },
    probeRequestedAt: null,
    updatedAt: new Date().toISOString(),
    ...over,
  });

  const row = (page: Page, id: string) => page.getByTestId(`status-row-${id}`);
  const details = (page: Page, id: string) =>
    row(page, id).getByRole("button", { name: /^Details/ });

  test("no reports yet: the shard rows say so, nothing is called verified", async ({
    page,
    request,
  }) => {
    await request.put("/__fake/status", { data: { shards: [] } });
    await signInAndGo(page, "/console/status");
    await expect(page.getByRole("heading", { name: "Status" })).toBeVisible();
    await expect(row(page, "shards")).toContainText("No shard has reported yet.");
    await expect(row(page, "runtime")).toContainText("No shard has reported yet.");
    await expect(row(page, "network")).toContainText("Not checked since the last start.");
    // Nobody to ask for a re-check before shard 0 has published.
    await expect(page.getByRole("button", { name: "Re-check" })).toHaveCount(0);
    await expect(page.getByTestId("nav-problem")).toHaveCount(0);
  });

  test("healthy: one line per area, details collapsed, no red dot", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [report()] } });
    await signInAndGo(page, "/console/status");
    await expect(row(page, "runtime")).toContainText("Sandboxes run under gVisor.");
    await expect(row(page, "network")).toContainText("Enforced.");
    await expect(row(page, "shards")).toContainText("1 shard reported. last report just now");
    await expect(row(page, "egress")).toContainText("1 replica serving, in sync.");
    await expect(row(page, "onecli")).toContainText("Model credentials configured for");
    await expect(row(page, "deployment")).toContainText("Direct egress not allowed");
    await expect(page.getByTestId("status-row-direct")).toHaveCount(0);
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByTestId("nav-problem")).toHaveCount(0);
    // Wording: a report is a "last report", and OneCLI has no up or down.
    await expect(page.getByText(/\b(up|down)\b/i)).toHaveCount(0);
    await shot(page, "status-healthy.png");

    await details(page, "egress").click();
    await expect(row(page, "egress")).toContainText("Rules revision");
    await expect(row(page, "egress")).toContainText("2 active, 1 with a Pod address, 3 revoked");
    await details(page, "deployment").click();
    await expect(row(page, "deployment")).toContainText("security.allowDirectSandboxEgress");
    await expect(row(page, "deployment")).toContainText("sandbox.flavours.browser.enabled");
    await details(page, "network").click();
    await expect(row(page, "network")).toContainText("every verified denied target was blocked");
    // One verdict for the cluster: no per-shard network column anywhere.
    await expect(page.getByRole("columnheader", { name: /network/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refresh" })).toHaveCount(1);
  });

  test("a problem sorts first and lights the dot in the navigation", async ({ page, request }) => {
    await request.put("/__fake/status", {
      data: {
        shards: [
          report(),
          report({
            shard: 1,
            observedRuntime: "",
            networkPolicy: "not-enforced",
            networkPolicyDetail: { state: "not-enforced", reason: "egress to 10.0.0.1 succeeded" },
          }),
        ],
        directSessions: 2,
        egress: {
          revision: 3,
          ruleSets: 2,
          rules: 4,
          invalid: 0,
          proxy: {
            replicas: [
              { name: "egress-proxy-0", revision: 3, state: "serving" },
              { name: "egress-proxy-1", revision: 2, state: "stale" },
            ],
          },
        },
      },
    });
    await signInAndGo(page, "/console/status");
    await expect(page.getByTestId("nav-problem")).toBeVisible();
    await expect(row(page, "runtime")).toContainText(
      "Shard 1: configured gvisor, observed node default.",
    );
    await expect(row(page, "egress")).toContainText("egress-proxy-1 is stale");
    await expect(row(page, "direct")).toContainText("2 live sessions with open internet.");
    // The problems come before the facts that are fine.
    const ids = await page
      .locator("[data-testid^=status-row-]")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-testid")));
    expect(ids.indexOf("status-row-runtime")).toBeLessThan(ids.indexOf("status-row-shards"));
    expect(ids.indexOf("status-row-egress")).toBeLessThan(ids.indexOf("status-row-shards"));
    expect(ids.indexOf("status-row-direct")).toBeLessThan(ids.indexOf("status-row-shards"));
    await shot(page, "status-problem.png");
  });

  test("right after a restart: runtime not observed yet, no red dot", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [report({ observedRuntime: null })] } });
    await signInAndGo(page, "/console/status");
    await expect(row(page, "runtime")).toContainText("Not observed yet");
    await expect(page.getByTestId("nav-problem")).toHaveCount(0);
  });

  test("Re-check, on the network row, turns not-yet-checked into enforced", async ({
    page,
    request,
  }) => {
    await request.put("/__fake/status", {
      data: { shards: [report({ networkPolicy: "unknown", networkPolicyCheckedAt: null })] },
    });
    await signInAndGo(page, "/console/status");
    await expect(row(page, "network")).toContainText("Not checked since the last start.");
    await row(page, "network").getByRole("button", { name: "Re-check" }).click();
    await expect(row(page, "network")).toContainText("Enforced.");
  });

  test("failing MCP servers are named and link to the MCP page", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [report()] } });
    const server = (name: string, over: Record<string, unknown>) => ({
      name,
      url: `https://${name}.example.com/mcp`,
      transport: "streamable-http",
      enabled: true,
      readOnly: true,
      timeoutMs: 60_000,
      maxOutputBytes: 24_576,
      onecliSecret: null,
      revision: 1,
      source: null,
      reachability: "ok",
      createdAt: new Date().toISOString(),
      createdBy: "alice",
      updatedAt: new Date().toISOString(),
      updatedBy: "alice",
      ...over,
    });
    await page.route("**/admin/mcp-servers", (route) =>
      route.fulfill({
        json: {
          servers: [
            server("search", {}),
            server("github", {
              reachability: "failing",
              discovery: {
                state: "failed",
                tools: 0,
                error: "connection refused",
                checkedAt: new Date().toISOString(),
              },
            }),
          ],
          invalid: [],
        },
      }),
    );
    await signInAndGo(page, "/console/status");
    await expect(row(page, "mcp")).toContainText("1 ready, 1 failing");
    await expect(page.getByTestId("nav-problem")).toBeVisible();
    await details(page, "mcp").click();
    await expect(row(page, "mcp")).toContainText("connection refused");
    await row(page, "mcp").getByRole("link", { name: "github" }).click();
    await expect(page).toHaveURL(/\/console\/mcp-servers$/);
  });

  test("fits a phone: no sideways scrolling", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [report()] } });
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAndGo(page, "/console/status");
    await expect(row(page, "shards")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "status-phone.png");
  });
});
