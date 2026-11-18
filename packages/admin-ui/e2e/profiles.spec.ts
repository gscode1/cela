import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { api, resetSettings, shot, signIn, unique } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ request }) => {
  await resetSettings(request);
});

interface Profile {
  currentVersion: number;
  revision: number;
  enabledForNew: boolean;
  definition: Record<string, unknown>;
}

const getProfile = (page: Page, name: string): Promise<Profile> =>
  api<Profile>(page.request, "GET", `/admin/profiles/${name}`);

const publish = (page: Page) => page.getByRole("button", { name: "Publish new version" });

test.describe("session profiles", () => {
  test("creates a profile, lists it, and publishes a new version with overrides", async ({
    page,
  }) => {
    const name = unique("review");
    await signIn(page, "/console/profiles");
    await page.getByRole("link", { name: "New profile" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("Instructions", { exact: true }).fill("Review the diff and list risks.");
    await page.getByLabel("Default model", { exact: true }).selectOption("scripted/scripted-2");
    await page.getByLabel("Default reasoning").selectOption("off");
    await page.getByLabel("Turn budget").fill("12");
    await expect(page.getByRole("region", { name: "What a new session gets" })).toContainText(
      "scripted/scripted-2 (from this profile)",
    );
    await page.getByRole("button", { name: "Create profile" }).click();
    await expect(page.getByTestId("saved")).toHaveText(`Published version 1 of ${name}.`);
    expect(await getProfile(page, name)).toMatchObject({
      currentVersion: 1,
      definition: {
        instructions: "Review the diff and list risks.",
        defaultModel: "scripted/scripted-2",
        reasoning: "off",
        turnBudget: 12,
      },
    });

    // Explicit off survives an edit elsewhere; clearing the model override omits the field.
    await expect(page.getByLabel("Default reasoning")).toHaveValue("off");
    await page.getByLabel("Default model", { exact: true }).selectOption("");
    await shot(page, "cleanup-profiles-editor");
    await publish(page).click();
    await expect(page.getByTestId("saved")).toHaveText(`Published version 2 of ${name}.`);
    const stored = await getProfile(page, name);
    expect(stored.definition).toEqual({
      instructions: "Review the diff and list risks.",
      reasoning: "off",
      turnBudget: 12,
    });
    expect("defaultModel" in stored.definition).toBe(false);

    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Session profiles" })
      .click();
    const row = page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(row).toContainText("by alice");
    await shot(page, "cleanup-profiles-list");
    await expect(row).not.toContainText("v2");
  });

  test("tells omitted tool lists from empty ones and diffs stored versions", async ({
    page,
    request,
  }) => {
    const name = unique("tools");
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { instructions: "x" } });
    await signIn(page, `/console/profiles/${name}`);
    await page.locator("#tools-all").uncheck();
    await expect(page.getByText("Read files")).toBeVisible();
    for (const tool of ["read", "write", "edit", "bash"])
      await page.locator(`#tools-${tool}`).uncheck();
    await expect(page.getByText("No tools.")).toBeVisible();
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 2");
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "x", tools: [] });

    await page.getByRole("tab", { name: "Versions" }).click();
    const diff = page.getByLabel("Version diff");
    await expect(diff.getByRole("row", { name: /Tools\s+all tools\s+no tools/ })).toBeVisible();
    await shot(page, "cleanup-profiles-versions");
    await page.getByLabel("From").selectOption("2");
    await page.getByLabel("To").selectOption("1");
    await expect(diff.getByRole("row", { name: /Tools\s+no tools\s+all tools/ })).toBeVisible();
  });

  test("pins an exact skill version and explains read and bash without changing tools", async ({
    page,
    request,
  }) => {
    const skill = unique("lint");
    await api(
      request,
      "POST",
      `/admin/skills/${skill}/versions`,
      {
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${skill}\ndescription: Lints things\n---\nRun run.sh.\n`,
          },
          { path: "run.sh", content: "#!/bin/sh\necho ok\n", executable: true },
        ],
      },
      201,
    );
    const name = unique("skilled");
    await api(request, "PUT", `/admin/profiles/${name}`, {
      definition: { tools: ["write", "edit"] },
    });
    await signIn(page, `/console/profiles/${name}`);
    await page.getByLabel("Skill", { exact: true }).selectOption(skill);
    await page.getByRole("button", { name: "Pin version" }).click();
    await expect(page.getByTestId("skill-pin")).toContainText(`${skill}@v1`);
    await expect(page.getByTestId("skill-pin")).toContainText("executable files");
    await expect(page.getByTestId("read-dependency")).toBeVisible();
    await expect(page.getByText("Skills need the read tool.")).toBeVisible();
    await expect(publish(page)).toBeDisabled();
    await expect(page.locator("#tools-read")).not.toBeChecked();

    await page.locator("#tools-read").check();
    await expect(page.getByTestId("bash-warning")).toContainText("executable files");
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 2");
    const stored = await getProfile(page, name);
    expect(stored.definition).toMatchObject({ tools: ["write", "edit", "read"] });
    expect(stored.definition.skills).toMatchObject([{ name: skill, version: 1 }]);
  });

  test("refuses to delete an MCP server a profile names, and never creates the name again", async ({
    request,
  }) => {
    // A profile can no longer point at a deleted server (ADR 0027); the editor's marking of such a reference, left by
    // older data, is covered by the unit tests.
    const server = unique("docs");
    const name = unique("mcp");
    const body = { url: "https://mcp.example.com/mcp", readOnly: true };
    await api(request, "PUT", `/admin/mcp-servers/${server}`, body, 201);
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { mcpServers: [server] } });
    const refused = await api<{ blockedBy: unknown }>(
      request,
      "DELETE",
      `/admin/mcp-servers/${server}?expectedRevision=1`,
      undefined,
      409,
    );
    expect(refused.blockedBy).toEqual({ profiles: [{ name, version: 1 }] });
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: {} });
    await api(request, "DELETE", `/admin/mcp-servers/${server}?expectedRevision=1`);
    await api(request, "PUT", `/admin/mcp-servers/${server}`, body, 409);
  });

  test("blocks the default profile when it would be refused, and warns for another", async ({
    page,
    request,
  }) => {
    const other = unique("other");
    await api(request, "PUT", "/admin/settings", { maxReasoning: "low" });
    await api(request, "PUT", `/admin/profiles/${other}`, { definition: {} });
    await signIn(page, `/console/profiles/${other}`);
    await page.getByLabel("Default reasoning").selectOption("high");
    await expect(page.getByTestId("warnings")).toContainText(
      "reasoning high is above the allowed maximum low",
    );
    await expect(publish(page)).toBeEnabled();

    await signIn(page, "/console/profiles/coding");
    await page.getByLabel("Default reasoning").selectOption("high");
    await expect(page.getByTestId("blocking")).toContainText(
      "reasoning high is above the allowed maximum low",
    );
    await expect(publish(page)).toBeDisabled();
  });

  test("disables a profile without a new version, and refuses to disable the default with the fix", async ({
    page,
    request,
  }) => {
    const name = unique("temp");
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { instructions: "x" } });
    await signIn(page, `/console/profiles/${name}`);
    await page.getByRole("button", { name: "Disable for new sessions" }).click();
    await expect(page.getByTestId("saved")).toHaveText(`${name} is disabled for new sessions.`);
    expect(await getProfile(page, name)).toMatchObject({ currentVersion: 1, enabledForNew: false });
    await page.getByRole("button", { name: "Enable for new sessions" }).click();
    await expect(page.getByTestId("saved")).toHaveText(`${name} is enabled for new sessions.`);

    await signIn(page, "/console/profiles/coding");
    const disable = page.getByRole("button", { name: "Disable for new sessions" });
    await expect(disable).toBeDisabled();
    await expect(disable).toHaveAttribute("title", /Select another default/);
    expect(await getProfile(page, "coding")).toMatchObject({ enabledForNew: true });
  });

  test("a stale profile draft gets a 409 and keeps its contents", async ({ page, request }) => {
    const name = unique("race");
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { instructions: "first" } });
    await signIn(page, `/console/profiles/${name}`);
    await page.getByLabel("Instructions", { exact: true }).fill("mine");
    await api(request, "PUT", `/admin/profiles/${name}`, {
      definition: { instructions: "theirs" },
    });

    await publish(page).click();
    await expect(page.getByText("Not saved: this profile changed")).toBeVisible();
    await expect(page.getByLabel("Instructions", { exact: true })).toHaveValue("mine");
    await page.getByRole("button", { name: "Reload and compare" }).click();
    const compare = page.getByTestId("conflict-compare");
    await expect(compare.getByRole("row", { name: /Instructions\s+theirs\s+mine/ })).toBeVisible();
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "theirs" });

    await page.getByRole("button", { name: "Keep my draft on top of the server version" }).click();
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 3");
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "mine" });
  });

  test("opens a profile from the pinSkill and addMcp links with a draft, and saves nothing", async ({
    page,
    request,
  }) => {
    const skill = unique("link");
    const server = unique("linked");
    const name = unique("target");
    await api(
      request,
      "POST",
      `/admin/skills/${skill}/versions`,
      {
        files: [
          {
            path: "SKILL.md",
            content: `---\nname: ${skill}\ndescription: Linked\n---\nText.\n`,
          },
        ],
      },
      201,
    );
    await api(
      request,
      "PUT",
      `/admin/mcp-servers/${server}`,
      { url: "https://mcp.example.com/mcp", readOnly: true },
      201,
    );
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { instructions: "x" } });

    // The operator chooses the profile; the link's parameters travel on to it.
    await signIn(page, `/console/profiles?pinSkill=${skill}@1&addMcp=${server}`);
    await expect(page.getByTestId("choose-profile")).toContainText(`pin ${skill} v1`);
    await page.getByRole("link", { name }).click();
    await expect(page).toHaveURL(new RegExp(`/console/profiles/${name}$`));
    await expect(page.getByTestId("skill-pin")).toContainText(`${skill}@v1`);
    await expect(page.locator(`#mcp-${server}`)).toBeChecked();
    await expect(publish(page)).toBeEnabled();
    await shot(page, "profile-editor-from-pinskill-link");
    // Nothing is written until the operator publishes.
    expect((await getProfile(page, name)).currentVersion).toBe(1);

    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 2");
    const stored = await getProfile(page, name);
    expect(stored.definition).toMatchObject({ mcpServers: [server] });
    expect(stored.definition.skills).toMatchObject([{ name: skill, version: 1 }]);
  });
});
