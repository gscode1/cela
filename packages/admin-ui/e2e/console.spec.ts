import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { tokens } from "./env";

const { admin, nonAdmin, unknown } = tokens();

async function signIn(page: Page, token: string): Promise<void> {
  await page.getByLabel("Token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
}

test.describe("console enabled", () => {
  test("signs in, loads every asset under the CSP, and shows the shell", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });
    const assets: { url: string; status: number }[] = [];
    page.on("response", (response) => {
      if (response.url().includes("/console/assets/"))
        assets.push({ url: response.url(), status: response.status() });
    });

    await page.goto("/console/");
    await signIn(page, admin);
    const nav = page.getByRole("navigation", { name: "Console" });
    for (const title of [
      "Global settings",
      "Session profiles",
      "MCP servers",
      "Skills",
      "Isolation",
    ])
      await expect(nav.getByRole("link", { name: title })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Global settings" })).toBeVisible();
    // A picker when the orchestrator published a catalog with credentials; without one (a kind cluster without OneCLI)
    // the screen shows the current model as text and says why there is no list. Either is a working Settings screen.
    await expect(
      page.getByLabel("Default model", { exact: true }).or(page.getByTestId("current-model")),
    ).toBeVisible();

    expect(assets.length).toBeGreaterThanOrEqual(2);
    expect(assets.filter((asset) => asset.status !== 200)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("keeps the token out of storage and cookies", async ({ page, context }) => {
    await page.goto("/console/");
    await signIn(page, admin);
    await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage).length,
      session: Object.keys(sessionStorage).length,
    }));
    expect(stored).toEqual({ local: 0, session: 0 });
    expect(await context.cookies()).toEqual([]);
  });

  test("a direct link opens its screen after sign-in, and unknown asset files are 404", async ({
    page,
    request,
  }) => {
    const direct = await page.goto("/console/profiles");
    expect(direct?.status()).toBe(200);
    await signIn(page, admin);
    await expect(page.getByRole("heading", { name: "Session profiles" })).toBeVisible();
    expect(page.url()).toMatch(/\/console\/profiles$/);

    expect((await request.get("/console/assets/missing.js")).status()).toBe(404);
    expect((await request.get("/console/missing.png")).status()).toBe(404);
  });

  test("sign-out clears the session and a reload asks for the token again", async ({ page }) => {
    await page.goto("/console/settings");
    await signIn(page, admin);
    await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Token")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Console" })).toHaveCount(0);

    await signIn(page, admin);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByLabel("Token")).toBeVisible();
    await expect(page.getByLabel("Token")).toHaveValue("");
  });

  test("tells an invalid token from a valid owner without admin access", async ({ page }) => {
    await page.goto("/console/");
    await signIn(page, unknown);
    await expect(page.getByRole("alert")).toHaveText("invalid token");
    await page.getByLabel("Token").fill(nonAdmin);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText("valid owner without admin access");
    await expect(page.getByRole("navigation", { name: "Console" })).toHaveCount(0);
  });

  test("renders HTML-like API data as text", async ({ page }) => {
    const hostile = '<img src=x onerror="window.__xss=1"><b>bold</b>';
    page.on("dialog", (dialog) => {
      throw new Error(`unexpected dialog: ${dialog.message()}`);
    });
    // Only the answers are replaced, so the test needs no hostile data in the deployment.
    await page.route("**/admin/settings", (route) =>
      route.fulfill({
        json: {
          defaultModel: hostile,
          allowlist: [hostile],
          reasoning: null,
          maxReasoning: null,
          defaultProfile: "<script>window.__xss=2</script>",
          turnBudget: 1,
          revision: 1,
          updatedAt: "2026-01-01T00:00:00.000Z",
          updatedBy: hostile,
        },
      }),
    );
    await page.route("**/admin/settings/history*", (route) =>
      route.fulfill({
        json: {
          history: [
            {
              id: "1",
              changedAt: "2026-01-01T00:00:00.000Z",
              changedBy: hostile,
              old: null,
              new: {
                defaultModel: hostile,
                allowlist: [hostile],
                reasoning: null,
                maxReasoning: null,
                defaultProfile: "<script>window.__xss=2</script>",
                turnBudget: 1,
              },
            },
          ],
        },
      }),
    );
    await page.goto("/console/");
    await signIn(page, admin);
    await expect(page.getByText("<script>window.__xss=2</script>").first()).toBeVisible();
    await page.getByRole("button", { name: /set the initial values/ }).click();
    await expect(page.getByText(hostile).first()).toBeVisible();
    await expect(page.locator("main img, main b, main script")).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("serves the console and admin responses with the security headers", async ({ request }) => {
    for (const path of [
      "/console/",
      "/console/profiles",
      "/console/assets/missing.js",
      "/admin/settings",
    ]) {
      const headers = (await request.get(path)).headers();
      expect(headers["cache-control"], path).toBe("no-store");
      expect(headers["content-security-policy"], path).toBe(
        "default-src 'self'; frame-ancestors 'none'",
      );
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["referrer-policy"], path).toBe("no-referrer");
    }
    expect((await request.get("/admin/settings")).status()).toBe(401);
  });
});
