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
    await page.getByLabel("Model", { exact: true }).selectOption("scripted/scripted-2");
    await page.getByLabel("Reasoning", { exact: true }).selectOption("off");
    await page.getByLabel("Turn budget").fill("12");
    await expect(page.getByRole("region", { name: "Admission preview" })).toContainText(
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
    await expect(page.getByLabel("Reasoning", { exact: true })).toHaveValue("off");
    await page.getByLabel("Model", { exact: true }).selectOption("");
    await shot(page, "02-profile-editor");
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
    await expect(row).toContainText("v2");
    await expect(row).toContainText("alice");
  });

  test("tells omitted tool lists from empty ones and diffs stored versions", async ({
    page,
    request,
  }) => {
    const name = unique("tools");
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { instructions: "x" } });
    await signIn(page, `/console/profiles/${name}`);
    await page.locator("#tools-all").uncheck();
    for (const tool of ["read", "write", "edit", "bash"])
      await page.locator(`#tools-${tool}`).uncheck();
    await expect(page.getByText("No tools: an empty list.")).toBeVisible();
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 2");
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "x", tools: [] });

    await page.getByRole("tab", { name: "Versions" }).click();
    const diff = page.getByLabel("Version diff");
    await expect(
      diff.getByRole("row", { name: /tools\s+\(omitted\)\s+\(empty list\)/ }),
    ).toBeVisible();
    await shot(page, "03-profile-version-diff");
    await page.getByLabel("From").selectOption("2");
    await page.getByLabel("To").selectOption("1");
    await expect(
      diff.getByRole("row", { name: /tools\s+\(empty list\)\s+\(omitted\)/ }),
    ).toBeVisible();
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
    await expect(
      page.getByText("skills need the read tool, but tools does not include it"),
    ).toBeVisible();
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

  test("marks a reference to a deleted MCP server and offers to remove it", async ({
    page,
    request,
  }) => {
    const server = unique("docs");
    const name = unique("mcp");
    await api(
      request,
      "PUT",
      `/admin/mcp-servers/${server}`,
      { url: "https://mcp.example.com/mcp", readOnly: true },
      201,
    );
    await api(request, "PUT", `/admin/profiles/${name}`, { definition: { mcpServers: [server] } });
    await api(request, "DELETE", `/admin/mcp-servers/${server}`);

    await signIn(page, `/console/profiles/${name}`);
    await expect(page.getByTestId("missing-server")).toContainText(server);
    await page.getByLabel("Instructions", { exact: true }).fill("Edited while the server is gone.");
    await expect(publish(page)).toBeDisabled();
    await page.getByRole("button", { name: "Remove all broken references" }).click();
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 2");
    expect((await getProfile(page, name)).definition).toEqual({
      instructions: "Edited while the server is gone.",
      mcpServers: [],
    });
  });

  test("blocks the default profile when it would be refused, and warns for another", async ({
    page,
    request,
  }) => {
    const other = unique("other");
    await api(request, "PUT", "/admin/settings", { maxReasoning: "low" });
    await api(request, "PUT", `/admin/profiles/${other}`, { definition: {} });
    await signIn(page, `/console/profiles/${other}`);
    await page.getByLabel("Reasoning", { exact: true }).selectOption("high");
    await expect(page.getByTestId("warnings")).toContainText(
      "reasoning high is above the allowed maximum low",
    );
    await expect(publish(page)).toBeEnabled();

    await signIn(page, "/console/profiles/coding");
    await page.getByLabel("Reasoning", { exact: true }).selectOption("high");
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
    await page.getByRole("button", { name: "Disable for new sessions" }).click();
    const conflict = page.getByTestId("toggle-conflict");
    await expect(conflict).toContainText(
      'profile "coding" is the default profile for new sessions',
    );
    await expect(conflict.getByRole("link", { name: "Global settings" })).toBeVisible();
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
    await expect(compare.getByRole("row", { name: /instructions\s+theirs\s+mine/ })).toBeVisible();
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "theirs" });

    await page.getByRole("button", { name: "Keep my draft on top of the server version" }).click();
    await publish(page).click();
    await expect(page.getByTestId("saved")).toContainText("Published version 3");
    expect((await getProfile(page, name)).definition).toEqual({ instructions: "mine" });
  });
});
