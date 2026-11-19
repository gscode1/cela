import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { putMcp, shot, signInAndGo, unique } from "./catalogs-support";

interface FakeSession {
  id: string;
  profile: string;
  deleted: boolean;
  watchers: number;
}

/** What the fake session API holds, through its local control (no token). */
async function fakeSessions(request: APIRequestContext, drop = false): Promise<FakeSession[]> {
  const res = await request.get(`/__fake/sessions${drop ? "/drop" : ""}`);
  return ((await res.json()) as { sessions: FakeSession[] }).sessions;
}

async function profileWithServer(request: APIRequestContext, server: string): Promise<string> {
  await putMcp(request, server, { url: "https://demo.example.com/mcp", readOnly: true });
  const profile = unique("pg");
  await request.put(`/__fake/profiles/${profile}`, {
    data: { definition: { mcpServers: [server] } },
  });
  return profile;
}

test.describe("playground", () => {
  test("opens from an MCP server, runs a real-looking turn and shows the MCP tool call", async ({
    page,
    request,
  }) => {
    const server = unique("demo");
    const profile = await profileWithServer(request, server);
    await signInAndGo(page, "/console/mcp-servers");
    await page
      .getByTestId(`mcp-${server}`)
      .getByRole("link", { name: "Try in playground" })
      .click();

    await expect(page.getByRole("heading", { name: "Playground" })).toBeVisible();
    await expect(page.getByText(/spends\s+model tokens/)).toBeVisible();
    await expect(page.getByLabel("Profile")).toHaveValue(profile);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByTestId("session-id")).toBeVisible();
    await expect(page.getByTestId("connection")).toHaveText("connected");

    await page.getByLabel("Message").fill("echo hello");
    await page.getByRole("button", { name: "Send" }).click();
    const call = page.locator(`[data-testid="tool-call"][data-tool="mcp__${server}__echo"]`);
    await expect(call).toContainText(`MCP ${server}`);
    await expect(call).toContainText("ok");
    // The 30-line result is long, so it sits behind a summary.
    await call.getByText(/Result \(\d+ characters\)/).click();
    await expect(call).toContainText("echo: echo hello");
    await expect(page.getByTestId("msg-assistant").last()).toHaveText(/Done: the tool answered/);
    await shot(page, "playground-chat.png");

    await page.getByRole("button", { name: "End session" }).click();
    await expect(page.getByText(/This session has ended/)).toBeVisible();
    const ended = (await fakeSessions(request)).find((s) => s.profile === profile);
    expect(ended?.deleted).toBe(true);
  });

  test("shows a failing tool as an error, stops a running turn and survives a dropped stream", async ({
    page,
    request,
  }) => {
    await signInAndGo(page, "/console/playground");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByTestId("connection")).toHaveText("connected");

    await page.getByLabel("Message").fill("please fail");
    await page.getByRole("button", { name: "Send" }).click();
    const bash = page.locator('[data-testid="tool-call"][data-tool="bash"]');
    await expect(bash).toContainText("error");
    await expect(bash).toContainText("tool failed: simulated error");

    // A proxy drops the stream: the console reconnects and keeps the transcript without a duplicate.
    const before = await page.getByTestId("msg-user").count();
    await fakeSessions(request, true);
    await expect(page.getByTestId("connection")).toHaveText("connected", { timeout: 10_000 });
    await expect(page.getByTestId("msg-user")).toHaveCount(before);

    await page.getByLabel("Message").fill("slow one");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("agent working")).toBeVisible();
    await page.getByRole("button", { name: "Stop turn" }).click();
    await expect(page.getByTestId("run-failure")).toContainText("aborted");
    await expect(page.getByText("agent working")).toHaveCount(0);
    await shot(page, "playground-error.png");
  });

  test("ends the session when the operator leaves the page", async ({ page, request }) => {
    const profile = await profileWithServer(request, unique("leave"));
    await signInAndGo(page, `/console/playground?profile=${profile}`);
    await expect(page.getByLabel("Profile")).toHaveValue(profile);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByTestId("session-id")).toBeVisible();

    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Global settings" })
      .click();
    await expect(page.getByRole("heading", { name: "Global settings" })).toBeVisible();
    await expect
      .poll(async () => (await fakeSessions(request)).find((s) => s.profile === profile)?.deleted)
      .toBe(true);
  });
});
