import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
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
    await expect(page.getByLabel("Default model", { exact: true })).toHaveValue("scripted-1");
    await expect(page.getByLabel("Default profile")).toHaveValue("coding");
    await expect(page.getByRole("heading", { name: "Review before saving" })).toHaveCount(0);

    await page.getByLabel("Turn budget").fill("150");
    await page.getByLabel("Default reasoning").selectOption("low");
    await page.getByLabel("Highest reasoning allowed").selectOption("high");
    const review = page.getByRole("region", { name: "Review before saving" });
    await expect(review.getByRole("row", { name: /Turn budget\s+100\s+150/ })).toBeVisible();
    await expect(
      review.getByRole("row", { name: /Default reasoning\s+model default\s+low/ }),
    ).toBeVisible();
    await expect(page.getByText(/from their next message/)).toBeVisible();
    await expect(page.getByText("Applies to new sessions only.")).toBeVisible();
    await shot(page, "01-settings-pending-diff");

    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toHaveText("Settings saved.");
    const history = page.getByRole("list", { name: "Settings history" });
    await expect(history.getByRole("listitem").first()).toContainText("alice");
    await expect(history.getByRole("listitem").first()).toContainText("Turn budget");

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
    await expect(page.getByLabel("Default reasoning")).toHaveValue("low");
    await page.getByLabel("Default reasoning").selectOption("");
    await page.getByLabel("Highest reasoning allowed").selectOption("");
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

    await page.getByRole("button", { name: "Remove scripted-2 (scripted)" }).click();
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
    await expect(compare.getByRole("row", { name: /Turn budget\s+300\s+150/ })).toBeVisible();
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
      .getByRole("link", { name: "Profiles" })
      .click();
    await expect(page.getByRole("heading", { name: "Profiles" })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Settings" })
      .click();
    await expect(page.getByLabel("Turn budget")).toHaveValue("222");
  });
});

// The catalog the local server publishes: openai has a credential, anthropic has none, scripted is the test provider.
const setModels = async (
  request: APIRequestContext,
  mode: "default" | "none-configured" | "unknown",
): Promise<void> => {
  expect((await request.post(`/__local/models?mode=${mode}`)).status()).toBe(204);
};

test.describe("model pickers", () => {
  test.afterEach(async ({ request }) => {
    await setModels(request, "default");
  });

  test("offers configured providers only, keeps a scripted current value with its note, and saves a picked model", async ({
    page,
    request,
  }) => {
    await signIn(page, "/console/settings");
    await expect(page.getByLabel("Provider", { exact: true })).toHaveValue("scripted");
    await expect(
      page.getByText("Test model — replays the message as a script, no LLM.").first(),
    ).toBeVisible();
    await expect(page.getByLabel("Provider", { exact: true }).locator("option")).toHaveText([
      "scripted",
      "openai",
      "bulk",
    ]);
    await shot(page, "cleanup-profiles-settings-scripted");

    // While only scripted models are allowed they are listed, with their note, and can be removed.
    const allowed = page.getByRole("group", { name: "Allowed models" });
    await expect(allowed.getByText("default")).toBeVisible();
    await expect(
      allowed.getByText("Test model — replays the message as a script, no LLM."),
    ).toHaveCount(1);
    await allowed.getByRole("button", { name: "Remove scripted-2 (scripted)" }).click();

    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    const model = page.getByLabel("Default model", { exact: true });
    await expect(model).toHaveValue("GPT Fast");
    await model.click();
    // A row is the model's key alone.
    await expect(page.getByRole("listbox").getByRole("option")).toHaveText([
      "openai/gpt-fast",
      "openai/gpt-think",
    ]);
    await page.getByRole("option", { name: "openai/gpt-think" }).click();
    await expect(model).toHaveValue("GPT Think");
    await expect(page.getByLabel("Default reasoning")).toBeVisible();
    // Never offered: the unconfigured provider and the test provider's models.
    await expect(page.getByText("Claude X")).toHaveCount(0);

    await allowed.getByLabel("Provider to add from").selectOption("openai");
    await allowed.getByLabel("Add a model").fill("fast");
    await allowed.getByRole("option", { name: "openai/gpt-fast" }).click();
    await expect(allowed.getByRole("list").getByText("GPT Fast")).toBeVisible();
    // A real model is allowed now: scripted-1 drops out of the list, but stays in the saved allowlist (below).
    await expect(allowed.getByRole("list").getByText("scripted-1")).toHaveCount(0);
    await shot(page, "cleanup-profiles-settings-pickers");

    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toHaveText("Settings saved.");
    const stored = await api<{ defaultModel: string; allowlist: string[] }>(
      request,
      "GET",
      "/admin/settings",
    );
    expect(stored.defaultModel).toBe("openai/gpt-think");
    expect([...stored.allowlist].sort()).toEqual([
      "openai/gpt-fast",
      "openai/gpt-think",
      "scripted/scripted-1",
    ]);

    // The saved allowlist comes back as entries.
    await page.reload();
    await page.getByLabel("Token").fill((await import("./env")).tokens().admin);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("group", { name: "Allowed models" }).getByText("GPT Fast"),
    ).toBeVisible();
  });

  test("stays short with a provider of 300 models, and adds one by searching", async ({
    page,
    request,
  }) => {
    await signIn(page, "/console/settings");
    await page.getByLabel("Provider", { exact: true }).selectOption("bulk");
    const model = page.getByLabel("Default model", { exact: true });
    await model.click();
    await model.fill("model-2 vendor-3");
    const options = page.getByRole("listbox").getByRole("option");
    expect(await options.count()).toBeLessThanOrEqual(20);
    await shot(page, "picker-scale-default-combobox");
    await page.keyboard.press("Enter");
    await expect(model).toHaveValue(/Bulk Model 2\d\d/);

    const allowed = page.getByRole("group", { name: "Allowed models" });
    await allowed.getByLabel("Provider to add from").selectOption("bulk");
    const add = allowed.getByLabel("Add a model");
    await add.click();
    await expect(allowed.getByRole("listbox").getByRole("option")).toHaveCount(20);
    await expect(allowed.getByText(/^279 more/)).toBeVisible();
    await add.fill("Bulk Model 150");
    await allowed
      .getByRole("listbox")
      .getByRole("option", { name: /\/model-150$/ })
      .click();
    await expect(allowed.getByRole("list").getByText("Bulk Model 150")).toBeVisible();
    await shot(page, "picker-scale-allowed-added");

    // The page stays a screenful: no list of the catalog anywhere.
    expect(await page.getByRole("listitem").count()).toBeLessThan(50);
    expect(await page.locator("input[type=checkbox]").count()).toBeLessThan(50);
    expect(await page.evaluate(() => document.body.scrollHeight)).toBeLessThan(3000);

    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByTestId("saved")).toHaveText("Settings saved.");
    const stored = await api<{ allowlist: string[] }>(request, "GET", "/admin/settings");
    expect(stored.allowlist.some((key) => key.includes("model-150"))).toBe(true);
  });

  test("says so when no model credential is configured, and takes a typed model id", async ({
    page,
    request,
  }) => {
    await setModels(request, "none-configured");
    await signIn(page, "/console/settings");
    await expect(page.getByTestId("models-notice")).toHaveText(
      "No model credentials are configured in OneCLI yet.",
    );
    await expect(page.getByTestId("current-model")).toHaveText("scripted/scripted-1");
    await expect(page.getByLabel("Provider", { exact: true })).toHaveCount(0);
    await shot(page, "cleanup-profiles-settings-none-configured");

    await page.locator("#default-model-custom").fill("openai/typed-model");
    await page.getByRole("button", { name: "Use" }).first().click();
    await expect(page.getByTestId("current-model")).toHaveText("openai/typed-model");
    await page.locator("#allowed-custom").fill("openai/also-typed");
    await page.getByRole("button", { name: "Use" }).nth(1).click();
    await expect(page.getByTestId("allowed-models").getByText("also-typed")).toBeVisible();
    await page.getByRole("button", { name: "Save settings" }).click();
    // The server checks the id against its full catalog.
    await expect(
      page.getByRole("alert").filter({ hasText: "is not in the model catalog" }),
    ).toBeVisible();
  });

  test("says so when OneCLI could not be checked", async ({ page, request }) => {
    await setModels(request, "unknown");
    await signIn(page, "/console/settings");
    const notice = page.getByTestId("models-notice");
    await expect(notice).toHaveText("Could not check OneCLI for model credentials.");
    await expect(notice).toHaveAttribute("title", /OneCLI could not be checked/);
  });

  test("shows one line per history entry and expands it", async ({ page, request }) => {
    await api(request, "PUT", "/admin/settings", { turnBudget: 120 });
    await signIn(page, "/console/settings");
    const entry = page.getByRole("list", { name: "Settings history" }).getByRole("button").first();
    await expect(entry).toContainText("alice changed Turn budget");
    await entry.click();
    await expect(page.getByRole("row", { name: /Turn budget\s+100\s+120/ })).toBeVisible();
    await shot(page, "cleanup-profiles-settings-history-expanded");
  });
});
