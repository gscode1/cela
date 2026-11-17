import { expect, test } from "@playwright/test";
import { api, resetSettings, shot, signIn, unique } from "./support";

// The fake database is shared by the whole run, so the specs that change global state run one after the other.
test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await resetSettings(request);
});

test.describe("global settings", () => {
  test("shows previous against new values, saves, and lists the change in the history", async ({
    page,
  }) => {
    await signIn(page, "/console/settings");
    await expect(page.getByLabel("Default model")).toHaveValue("scripted/scripted-1");
    await expect(page.getByLabel("Default profile")).toHaveValue("coding");
    await expect(page.getByRole("heading", { name: "Review before saving" })).toHaveCount(0);

    await page.getByLabel("Turn budget").fill("150");
    await page.getByLabel("Reasoning", { exact: true }).selectOption("low");
    await page.getByLabel("Max reasoning").selectOption("high");
    const review = page.getByRole("region", { name: "Review before saving" });
    await expect(review.getByRole("row", { name: /turnBudget\s+100\s+150/ })).toBeVisible();
    await expect(review.getByRole("row", { name: /reasoning\s+\(not set\)\s+low/ })).toBeVisible();
    await expect(page.getByText(/applies to sessions that inherit it/)).toBeVisible();
    await shot(page, "01-settings-pending-diff");

    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toContainText("Settings saved");
    const history = page.getByRole("list", { name: "Settings history" });
    await expect(history.getByRole("listitem").first()).toContainText("alice");
    await expect(history.getByRole("listitem").first()).toContainText("turnBudget");

    const stored = await api(page.request, "GET", "/admin/settings");
    expect(stored).toMatchObject({
      turnBudget: 150,
      reasoning: "low",
      maxReasoning: "high",
      updatedBy: "alice",
    });
  });

  test("clears reasoning and max reasoning with null", async ({ page, request }) => {
    await api(request, "PUT", "/admin/settings", { reasoning: "low", maxReasoning: "high" });
    await signIn(page, "/console/settings");
    await expect(page.getByLabel("Reasoning", { exact: true })).toHaveValue("low");
    await page.getByLabel("Reasoning", { exact: true }).selectOption("");
    await page.getByLabel("Max reasoning").selectOption("");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
    expect(await api(request, "GET", "/admin/settings")).toMatchObject({
      reasoning: null,
      maxReasoning: null,
    });
  });

  test("blocks a default profile that new sessions would be refused for, and warns for the others", async ({
    page,
    request,
  }) => {
    const fast = unique("fast");
    const picky = unique("picky");
    await api(request, "PUT", `/admin/profiles/${fast}`, {
      definition: { defaultModel: "scripted/scripted-2" },
    });
    await api(request, "PUT", `/admin/profiles/${picky}`, {
      definition: { defaultModel: "scripted/scripted-2" },
    });
    await signIn(page, "/console/settings");
    await expect(
      page.getByLabel("Default profile").locator(`option[value="${fast}"]`),
    ).toBeAttached();

    await page.getByLabel("Allowlist").fill("scripted/scripted-1");
    await expect(page.getByTestId("warnings")).toContainText(fast);
    await expect(page.getByTestId("warnings")).toContainText(picky);
    await expect(page.getByRole("button", { name: "Save settings" })).toBeEnabled();

    await page.getByLabel("Default profile").selectOption(fast);
    await expect(page.getByTestId("blocking")).toContainText(
      "model scripted/scripted-2 is not allowed",
    );
    await expect(page.getByTestId("blocking")).toContainText(
      "Add scripted/scripted-2 to the allowlist",
    );
    await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  test("a stale draft gets a 409, keeps its contents, and can be compared and saved on top", async ({
    page,
    request,
  }) => {
    await signIn(page, "/console/settings");
    await expect(page.getByLabel("Turn budget")).toHaveValue("100");
    await page.getByLabel("Turn budget").fill("150");

    // Another admin saves first.
    await api(request, "PUT", "/admin/settings", { turnBudget: 300 });

    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Not saved: the settings changed")).toBeVisible();
    await expect(page.getByLabel("Turn budget")).toHaveValue("150");
    await page.getByRole("button", { name: "Reload and compare" }).click();
    const compare = page.getByTestId("conflict-compare");
    await expect(compare).toContainText("On the server now");
    await expect(compare.getByRole("row", { name: /turnBudget\s+300\s+150/ })).toBeVisible();
    await shot(page, "04-settings-409-conflict");

    expect(await api(request, "GET", "/admin/settings")).toMatchObject({ turnBudget: 300 });
    await page.getByRole("button", { name: "Keep my draft on top of the server version" }).click();
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toBeVisible();
    expect(await api(request, "GET", "/admin/settings")).toMatchObject({ turnBudget: 150 });
  });

  test("keeps a draft when the operator visits another screen", async ({ page }) => {
    await signIn(page, "/console/settings");
    await page.getByLabel("Turn budget").fill("222");
    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Session profiles" })
      .click();
    await expect(page.getByRole("heading", { name: "Session profiles" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Global settings" })
      .click();
    await expect(page.getByLabel("Turn budget")).toHaveValue("222");
  });
});
