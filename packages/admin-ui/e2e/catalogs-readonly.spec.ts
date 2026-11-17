import { expect, test } from "@playwright/test";
import { bearer, putMcp, signInAndGo, skillMd, unique } from "./catalogs-support";

test.describe("catalogs in readOnly mode", () => {
  test("ingest tells the page, with no token and no secret", async ({ request }) => {
    const res = await request.get("/console/config.json");
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ catalogs: "readOnly" });
  });

  test("the skills screens browse and download but offer no write", async ({ page, request }) => {
    const name = unique("ro-skill");
    const res = await request.post(`/admin/skills/${name}/versions`, {
      headers: bearer,
      data: { files: [{ path: "SKILL.md", content: skillMd(name) }] },
    });
    expect(res.status()).toBe(201);
    await signInAndGo(page, "/console/skills");
    await expect(page.getByText("Skills are read-only in this console")).toBeVisible();
    await expect(page.getByTestId(`skill-${name}`)).toBeVisible();
    await expect(page.getByRole("link", { name: "Publish a skill" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Publish a skill" })).toHaveCount(0);

    await page.getByRole("link", { name }).click();
    await expect(page.getByTestId("version-1")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish a new version" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Publish a new version" })).toHaveCount(0);
    await page.getByRole("button", { name: "Files" }).click();
    await expect(page.getByRole("cell", { name: "SKILL.md", exact: true })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download zip" }).click();
    expect((await download).suggestedFilename()).toBe(`${name}-v1.zip`);

    // A direct link to the publish screen does not bring the controls back.
    const direct = await page.context().newPage();
    await signInAndGo(direct, `/console/skills/${name}/publish`);
    await expect(direct.getByText("Skills are read-only in this console")).toBeVisible();
    await expect(direct.getByLabel("Folder")).toHaveCount(0);
    await expect(direct.getByLabel("Zip")).toHaveCount(0);
    await signInAndGo(direct, "/console/skills/_new/publish");
    await expect(direct.getByText("Skills are read-only in this console")).toBeVisible();
    await expect(direct.getByRole("button", { name: "Choose a folder or a .zip" })).toHaveCount(0);
  });

  test("the MCP screen lists servers and history but offers no write", async ({
    page,
    request,
  }) => {
    const name = unique("ro-mcp");
    await putMcp(request, name, { url: "https://ro.example.com/mcp", readOnly: true });
    await signInAndGo(page, "/console/mcp-servers");
    await expect(page.getByText("MCP servers are read-only in this console")).toBeVisible();
    const row = page.getByTestId(`mcp-${name}`);
    await expect(row).toContainText("ro.example.com");
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Register a server" })).toHaveCount(0);
    await page.getByText("Recent changes").click();
    await expect(page.getByText(new RegExp(`${name} created`))).toBeVisible();
  });
});
