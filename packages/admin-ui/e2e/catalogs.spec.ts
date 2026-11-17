import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { unpackZip } from "../src/lib/skills/zip";
import {
  BINARY,
  bearer,
  makeZip,
  putMcp,
  storedMcp,
  storedVersion,
  SCRIPT,
  shot,
  signInAndGo,
  skillMd,
  unique,
  versionCount,
  writeSkillFolder,
} from "./catalogs-support";

const publishButton = (page: Page, name: string) =>
  page.getByRole("button", { name: `Publish ${name}` });
const chooseZip = (page: Page, name: string, buffer: Buffer) =>
  page.getByLabel("Zip").setInputFiles({ name, mimeType: "application/zip", buffer });

test.describe("skills", () => {
  test("publishes a folder from the list: the name comes from SKILL.md, no confirmation, then a pin link", async ({
    page,
  }, info) => {
    const name = unique("folder");
    const root = await mkdtemp(join(tmpdir(), "skill-folder-"));
    const dir = await writeSkillFolder(root, name, {
      "SKILL.md": skillMd(name),
      "scripts/run.sh": SCRIPT,
      "notes.txt": "plain notes\n",
    });
    await signInAndGo(page, "/console/skills");
    await page.getByRole("link", { name: "Publish a skill" }).click();
    // One control, no name to type first, no confirmation, no limits text.
    await expect(page.getByRole("button", { name: "Choose a folder or a .zip" })).toBeVisible();
    await expect(page.getByLabel("Skill name")).toHaveCount(0);
    // The one button offers both kinds of source.
    await page.getByRole("button", { name: "Choose a folder or a .zip" }).click();
    await expect(page.getByText("Folder", { exact: true })).toBeVisible();
    await expect(page.getByText("Zip file", { exact: true })).toBeVisible();
    await expect(page.getByText(/at most 128 files/)).toHaveCount(0);
    await page.getByLabel("Folder").setInputFiles(dir);

    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText(name);
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText("Greets the user");
    await expect(page.getByText("This is the first version")).toBeVisible();
    await expect(page.getByLabel(/I have reviewed/)).toHaveCount(0);
    await expect(page.getByText("sha256")).toHaveCount(0);
    // The folder name wrapped every path and is gone; a folder cannot tell the executable bit.
    const script = page.getByTestId("file-scripts/run.sh");
    await expect(script).toContainText("scripts/run.sh");
    await expect(script.getByRole("checkbox")).not.toBeChecked();
    await expect(script.getByText("executable")).toBeVisible();
    await expect(publishButton(page, name)).toBeEnabled();

    await script.getByRole("checkbox").check();
    await script.getByRole("button", { name: "View" }).click();
    await expect(page.locator("pre").filter({ hasText: "hello from the skill" })).toBeVisible();
    await shot(page, "skill-publish-review.png");
    await publishButton(page, name).click();

    await expect(page.getByRole("heading", { name: `Published ${name} v1.` })).toBeVisible();
    await expect(page.getByText(/digest/i)).toHaveCount(0);
    const pin = page.getByRole("link", { name: `Pin ${name} v1 in a profile` });
    await expect(pin).toHaveAttribute("href", `/console/profiles?pinSkill=${name}@1`);

    // The API got the executable bit and the text as text.
    const stored = await storedVersion(page.request, name, 1);
    const file = stored.files.find((f) => f.path === "scripts/run.sh");
    expect(file?.executable).toBe(true);
    expect(Buffer.from(file?.contentBase64 ?? "", "base64").toString()).toBe(SCRIPT);
    await page
      .getByRole("navigation", { name: "Console" })
      .getByRole("link", { name: "Skills" })
      .click();
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
    await shot(page, "skills-list.png");
    expect(info.errors).toEqual([]);
  });

  test("without a name in SKILL.md the folder or the zip names the skill", async ({ page }) => {
    const name = unique("named");
    const noName = `---\ndescription: No name inside\n---\n# x\n`;
    await signInAndGo(page, `/console/skills/_new/publish`);
    await chooseZip(page, `${name}.zip`, makeZip({ "SKILL.md": { data: noName } }));
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText(name);
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: `Published ${name} v1.` })).toBeVisible();

    // A name that cannot be a skill's: the page says where to put one.
    await signInAndGo(page, "/console/skills/_new/publish");
    await chooseZip(page, "Bad_Name.zip", makeZip({ "SKILL.md": { data: noName } }));
    await expect(
      page.getByRole("alert").filter({ hasText: "is not a valid skill name" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review" })).toHaveCount(0);
  });

  test("publishes a zip with a script and a binary, and a zip download keeps the bit", async ({
    page,
  }) => {
    const name = unique("zipped");
    const zip = makeZip({
      "SKILL.md": { data: skillMd(name, "Has a script and a binary") },
      "run.sh": { data: SCRIPT, executable: true },
      "bin/tool.bin": { data: BINARY, executable: true },
    });
    await signInAndGo(page, `/console/skills/_new/publish`);
    await chooseZip(page, `${name}.zip`, zip);

    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    // The bit comes from the zip: both are preset.
    await expect(page.getByTestId("file-run.sh").getByRole("checkbox")).toBeChecked();
    const binary = page.getByTestId("file-bin/tool.bin");
    await expect(binary.getByRole("checkbox")).toBeChecked();
    await expect(binary).toContainText("Binary file (8 B), not shown.");
    await expect(binary.getByRole("button", { name: "View" })).toHaveCount(0);
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: `Published ${name} v1.` })).toBeVisible();

    const stored = await storedVersion(page.request, name, 1);
    const tool = stored.files.find((f) => f.path === "bin/tool.bin");
    expect(Buffer.from(tool?.contentBase64 ?? "", "base64")).toEqual(Buffer.from(BINARY));
    expect(tool?.executable).toBe(true);

    // Version table: files behind an expander, hashes only in Details and on hover.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    const row = page.getByTestId("version-1");
    await expect(row).toContainText("Has a script and a binary");
    await expect(row).toContainText("3 files");
    await expect(page.getByText(tool?.sha256 ?? "missing")).toHaveCount(0);
    await row.getByRole("button", { name: "Files" }).click();
    await expect(page.getByText("sha256", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("cell", { name: "bin/tool.bin executable", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("bin/tool.bin")).toHaveAttribute(
      "title",
      `sha256 ${tool?.sha256 ?? "missing"}`,
    );
    await shot(page, "skill-detail.png");
    await page
      .getByRole("row", { name: /^SKILL\.md/ })
      .getByRole("button", { name: "View" })
      .click();
    await expect(page.locator("pre").filter({ hasText: "Say hello." })).toBeVisible();
    await page
      .getByRole("row", { name: /^bin\/tool\.bin/ })
      .getByRole("button", { name: "View" })
      .click();
    await expect(page.getByText("Binary file (8 B), not shown.")).toBeVisible();
    await row.getByRole("button", { name: "Details" }).click();
    await expect(page.getByText(/^[0-9a-f]{64}$/)).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download zip" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`${name}-v1.zip`);
    const path = await file.path();
    const entries = unpackZip(new Uint8Array(await readFile(path)), 1024 * 1024);
    expect(Object.fromEntries(entries.map((e) => [e.path, e.executable]))).toEqual({
      "SKILL.md": false,
      "bin/tool.bin": true,
      "run.sh": true,
    });
  });

  test("an identical upload cannot be published; a changed one shows a diff and makes v2", async ({
    page,
  }) => {
    const name = unique("again");
    const files = {
      "SKILL.md": { data: skillMd(name) },
      "run.sh": { data: SCRIPT, executable: true },
    };
    await signInAndGo(page, `/console/skills/_new/publish`);
    await chooseZip(page, "a.zip", makeZip(files));
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: `Published ${name} v1.` })).toBeVisible();

    // The same content again: the review says so and there is nothing to press.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await page.getByRole("link", { name: "Publish a new version" }).click();
    await chooseZip(page, "a.zip", makeZip(files));
    await expect(page.getByTestId("identical")).toHaveText("No changes \u2014 nothing to publish.");
    await expect(publishButton(page, name)).toBeDisabled();
    await expect(page.getByTestId("diff-summary")).toHaveCount(0);
    expect(await versionCount(page.request, name)).toBe(1);

    // A changed script: only the non-zero counts, and the diff without a click.
    const changed = {
      ...files,
      "run.sh": { data: `${SCRIPT}echo more\n`, executable: true },
      "new.txt": { data: "n" },
    };
    await chooseZip(page, "b.zip", makeZip(changed));
    await expect(page.getByTestId("diff-summary")).toHaveText("Against v1: 1 added, 1 changed");
    await expect(page.locator("pre div", { hasText: "+ echo more" })).toBeVisible();
    await expect(page.locator("pre div", { hasText: "echo hello from the skill" })).toBeVisible();
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: `Published ${name} v2.` })).toBeVisible();

    // The detail page lists the current version and keeps the older one behind a button.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await expect(page.getByTestId("version-2")).toContainText("current");
    await expect(page.getByTestId("version-1")).toHaveCount(0);
    await page.getByRole("button", { name: "Show 1 older version" }).click();
    await expect(page.getByTestId("version-1")).toBeVisible();
  });

  test("a bad frontmatter or an oversized bundle blocks the publish and says why; another skill's name is refused", async ({
    page,
  }) => {
    const name = unique("bad");
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await chooseZip(
      page,
      "bad.zip",
      makeZip({ "SKILL.md": { data: "# no frontmatter at all\n" } }),
    );
    await expect(page.getByText("SKILL.md must start with a YAML frontmatter block")).toBeVisible();
    await expect(publishButton(page, name)).toBeDisabled();

    const many: Record<string, { data: string }> = { "SKILL.md": { data: skillMd(name) } };
    for (let i = 0; i < 128; i++) many[`f${String(i)}.txt`] = { data: "x" };
    await chooseZip(page, "many.zip", makeZip(many));
    await expect(
      page.getByText(/a skill may hold at most 128 files \(this has 129\)/),
    ).toBeVisible();
    await expect(publishButton(page, name)).toBeDisabled();

    await chooseZip(page, "name.zip", makeZip({ "SKILL.md": { data: skillMd("someone-else") } }));
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: `names the skill "someone-else", but this page publishes "${name}"` }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review" })).toHaveCount(0);
    expect((await page.request.get(`/admin/skills/${name}`, { headers: bearer })).status()).toBe(
      404,
    );
  });

  test("shows an API error as text, verbatim, and renders hostile descriptions as text", async ({
    page,
  }) => {
    const name = unique("api");
    const hostile = "<img src=x onerror=window.__xss=1>";
    page.on("dialog", (dialog) => {
      throw new Error(`unexpected dialog: ${dialog.message()}`);
    });
    await page.route(`**/admin/skills/${name}/versions`, (route) =>
      route.fulfill({ status: 400, json: { error: '<b>"boom"</b>: files must include SKILL.md' } }),
    );
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await chooseZip(
      page,
      "x.zip",
      makeZip({ "SKILL.md": { data: skillMd(name, `"${hostile}"`) } }),
    );
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText(hostile);
    await publishButton(page, name).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "The API refused the publish" }),
    ).toContainText('<b>"boom"</b>: files must include SKILL.md');
    await expect(page.locator("main b, main img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("lists skills with who uses them, and shows which profiles pin each version", async ({
    page,
    request,
  }) => {
    const name = unique("pinned");
    const profile = unique("prof");
    const res = await request.post(`/admin/skills/${name}/versions`, {
      headers: bearer,
      data: {
        files: [
          {
            path: "SKILL.md",
            content: skillMd(name, "Pinned thing", "disable-model-invocation: true\n"),
          },
        ],
      },
    });
    expect(res.status()).toBe(201);
    await request.put(`/__fake/profiles/${profile}`, {
      data: { definition: { skills: [{ name, version: 1 }] } },
    });
    await signInAndGo(page, "/console/skills");
    await expect(
      page.getByText("A profile uses a skill only when it pins a version."),
    ).toBeVisible();
    const row = page.getByTestId(`skill-${name}`);
    await expect(row).toContainText("Pinned thing");
    await expect(row).toContainText("manual only");
    await expect(row.getByRole("link", { name: profile })).toBeVisible();
    await row.getByRole("link", { name }).click();
    await expect(page.getByTestId("version-1")).toContainText("manual only");
    await expect(page.getByTestId("version-1").getByRole("link", { name: profile })).toBeVisible();
  });
});

test.describe("MCP servers", () => {
  async function register(page: Page, name: string, url: string): Promise<void> {
    await page.getByRole("button", { name: "Register a server" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("URL").fill(url);
  }

  test("registers a server: https only, the declaration made on purpose, then offers a profile link", async ({
    page,
  }) => {
    const name = unique("reg");
    await signInAndGo(page, "/console/mcp-servers");
    await register(page, name, "http://plain.example.com/mcp");
    await expect(
      page.getByText("The host must be allowed in OneCLI's egress rules."),
    ).toBeVisible();
    const submit = page.getByRole("button", { name: "Register", exact: true });
    await expect(page.getByText("the URL must be https", { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByLabel("URL").fill("https://mcp.example.com/mcp");
    // Nothing is preselected: the answer has to be given.
    await expect(page.getByText("Does this server change anything?")).toBeVisible();
    await expect(page.getByRole("radio", { name: /^No, it only reads/ })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: /^Yes, it can change state/ })).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await page.getByRole("radio", { name: /^No, it only reads/ }).check();
    await submit.click();

    await expect(page.getByRole("heading", { name: "Saved." })).toBeVisible();
    // A new server is used by nobody: no sentence about sessions.
    await expect(page.getByText("Sessions using it pick up the change.")).toHaveCount(0);
    await expect(page.getByRole("link", { name: `Add ${name} to a profile` })).toHaveAttribute(
      "href",
      `/console/profiles?addMcp=${name}`,
    );
    await page.getByRole("button", { name: "Done" }).click();
    const row = page.getByTestId(`mcp-${name}`);
    await expect(row).toContainText("mcp.example.com");
    await expect(row.getByText("mcp.example.com")).toHaveAttribute(
      "title",
      "https://mcp.example.com/mcp",
    );
    await expect(row).toContainText("Read-only");
    await expect(row).toContainText("enabled");
    // Defaults and no source: nothing to expand, and none of the removed fields anywhere.
    await expect(row.getByRole("button", { name: "Details" })).toHaveCount(0);
    for (const gone of ["Transport", "Reachability", "onecliSecret", "#42", "Revision"])
      await expect(page.getByText(gone)).toHaveCount(0);
    await page.getByText("Recent changes").click();
    await expect(page.getByText(new RegExp(`${name} created`))).toBeVisible();
    await shot(page, "mcp-list.png");
  });

  test("shows timeout and max output only when they differ, inside Details", async ({
    page,
    request,
  }) => {
    const name = unique("limits");
    await putMcp(request, name, {
      url: "https://limits.example.com/mcp",
      readOnly: false,
      timeoutMs: 90_000,
      maxOutputBytes: 12 * 1024,
    });
    await signInAndGo(page, "/console/mcp-servers");
    const row = page.getByTestId(`mcp-${name}`);
    await expect(row).toContainText("Can change state");
    await expect(row).not.toContainText("90 s");
    await row.getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("row").filter({ hasText: "Timeout" });
    await expect(details).toContainText("90 s");
    await expect(details).toContainText("12 KB");
    await shot(page, "mcp-details.png");
    await row.getByRole("button", { name: "Details" }).click();
    await expect(page.getByRole("definition")).toHaveCount(0);
  });

  test("an edit that changes the URL asks the declaration again, in seconds and KB", async ({
    page,
    request,
  }) => {
    const name = unique("edit");
    await putMcp(request, name, { url: "https://one.example.com/mcp", readOnly: true });
    await request.put(`/__fake/profiles/${unique("user")}`, {
      data: { definition: { mcpServers: [name] } },
    });
    await signInAndGo(page, "/console/mcp-servers");
    const row = page.getByTestId(`mcp-${name}`);
    await row.getByRole("button", { name: "Edit" }).click();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await expect(page.getByLabel("Timeout (seconds)")).toHaveValue("60");
    await expect(page.getByLabel("Max output (KB)")).toHaveValue("24");

    await page.getByLabel("Timeout (seconds)").fill("90");
    await expect(save).toBeEnabled();
    await page.getByLabel("URL").fill("https://two.example.com/mcp");
    await expect(page.getByText("The URL changed. Answer again")).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByRole("radio", { name: /^No, it only reads/ }).check();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("heading", { name: "Saved." })).toBeVisible();
    // Used by a profile: the edit reaches its sessions.
    await expect(page.getByText("Sessions using it pick up the change.")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(row).toContainText("two.example.com");
    await row.getByRole("button", { name: "Details" }).click();
    await expect(page.getByRole("definition").filter({ hasText: "90 s" })).toBeVisible();
    expect(await storedMcp(request, name)).toMatchObject({ timeoutMs: 90_000 });
    await page.getByText("Recent changes").click();
    await expect(
      page.getByText(/URL: https:\/\/one\.example\.com\/mcp \u2192 https:\/\/two/),
    ).toBeVisible();
    await expect(page.getByText(/Timeout: 60 s \u2192 90 s/)).toBeVisible();

    // The API's own range check is mirrored before the request is made.
    await row.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Max output (KB)").fill("99");
    await expect(page.getByText("Max output must be from 1 to 24 KB")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("a stale edit keeps the draft, says who changed it and saves after a reload", async ({
    page,
    request,
  }) => {
    const name = unique("race");
    await putMcp(request, name, { url: "https://race.example.com/mcp", readOnly: true });
    await signInAndGo(page, "/console/mcp-servers");
    const row = page.getByTestId(`mcp-${name}`);
    await row.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Timeout (seconds)").fill("45");

    // Someone else changes the server meanwhile.
    await putMcp(request, name, { maxOutputBytes: 2048, expectedRevision: 1 });
    await page.getByRole("button", { name: "Save changes" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "Someone else changed" });
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText("revision");
    await expect(page.getByLabel("Timeout (seconds)")).toHaveValue("45");

    await alert.getByRole("button", { name: "Reload the stored server" }).click();
    await expect(page.getByText(/Changed by alice .* since you opened it/)).toBeVisible();
    await expect(page.getByText(/revision/i)).toHaveCount(0);
    await expect(page.getByLabel("Timeout (seconds)")).toHaveValue("45");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Saved." })).toBeVisible();
    const stored = await storedMcp(request, name);
    expect(stored).toMatchObject({ revision: 3, timeoutMs: 45000, maxOutputBytes: 2048 });
  });

  test("disables and enables; a server that changes state asks again before it is enabled", async ({
    page,
    request,
  }) => {
    const ro = unique("ro");
    const rw = unique("rw");
    await putMcp(request, ro, { url: "https://ro.example.com/mcp", readOnly: true });
    await putMcp(request, rw, {
      url: "https://rw.example.com/mcp",
      readOnly: false,
      enabled: false,
    });
    await signInAndGo(page, "/console/mcp-servers");

    const roRow = page.getByTestId(`mcp-${ro}`);
    await roRow.getByRole("button", { name: "Disable" }).click();
    await expect(roRow.getByText("disabled", { exact: true })).toBeVisible();
    // The badge says it all: no paragraph about disabled servers.
    await expect(page.getByText("its tools are unavailable")).toHaveCount(0);
    await roRow.getByRole("button", { name: "Enable" }).click();
    await expect(roRow.getByText("enabled", { exact: true })).toBeVisible();

    const rwRow = page.getByTestId(`mcp-${rw}`);
    await expect(rwRow.getByText("disabled", { exact: true })).toBeVisible();
    await rwRow.getByRole("button", { name: "Enable" }).click();
    const panel = page.getByLabel(`Enable ${rw}`);
    await expect(panel.getByText("Does this server change anything?")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Enable" })).toBeDisabled();
    await panel.getByRole("radio", { name: /^Yes, it can change state/ }).check();
    await panel.getByRole("button", { name: "Enable" }).click();
    await expect(rwRow.getByText("enabled", { exact: true })).toBeVisible();
  });

  test("delete names the profiles that use the server and suggests disabling; unused ones get no such alert", async ({
    page,
    request,
  }) => {
    const name = unique("gone");
    const profile = unique("user");
    await putMcp(request, name, { url: "https://gone.example.com/mcp", readOnly: true });
    await request.put(`/__fake/profiles/${profile}`, {
      data: { definition: { mcpServers: [name] } },
    });
    await signInAndGo(page, "/console/mcp-servers");
    const row = page.getByTestId(`mcp-${name}`);
    await expect(row.getByRole("link", { name: profile })).toBeVisible();
    await row.getByRole("button", { name: "Delete" }).click();
    const panel = page.getByLabel(`Delete ${name}`);
    await expect(panel).toContainText(`Still used by ${profile}`);
    await expect(panel).toContainText("Disable it instead");
    await expect(panel).not.toContainText("removes the row");
    await shot(page, "mcp-delete-confirmation.png");

    await panel.getByRole("button", { name: "Disable instead" }).click();
    await expect(panel).toHaveCount(0);
    await expect(row.getByText("disabled", { exact: true })).toBeVisible();

    // Free the server: no profile names it any more, so the panel has no alert and no positive-only line.
    await request.put(`/__fake/profiles/${profile}`, { data: { definition: {} } });
    await signInAndGo(page, "/console/mcp-servers");
    await row.getByRole("button", { name: "Delete" }).click();
    const free = page.getByLabel(`Delete ${name}`);
    await expect(free.getByRole("button", { name: `Delete ${name}` })).toBeEnabled();
    await expect(free).not.toContainText("Still used by");
    await expect(free).not.toContainText("No profile");
    await free.getByRole("button", { name: `Delete ${name}` }).click();
    await expect(row).toHaveCount(0);
    expect((await request.get(`/admin/mcp-servers/${name}`, { headers: bearer })).status()).toBe(
      404,
    );
  });

  test("recent changes are collapsed, show five lines and then more on request", async ({
    page,
    request,
  }) => {
    const name = unique("hist");
    await putMcp(request, name, { url: "https://hist.example.com/mcp", readOnly: true });
    for (let i = 1; i <= 7; i++) await putMcp(request, name, { timeoutMs: 1000 * (i + 1) });
    await signInAndGo(page, "/console/mcp-servers");
    const section = page.locator("details", { hasText: "Recent changes" });
    await expect(section).not.toHaveAttribute("open", "");
    await section.getByText("Recent changes").click();
    await expect(section.getByRole("listitem")).toHaveCount(5);
    await expect(section).not.toContainText("The newest 20");
    await section.getByRole("button", { name: "Show more" }).click();
    expect(await section.getByRole("listitem").count()).toBeGreaterThan(5);
  });
});

test.describe("isolation", () => {
  test.describe.configure({ mode: "serial" });

  const report = (over: Record<string, unknown> = {}) => ({
    shard: 0,
    configuredRuntime: "gvisor",
    observedRuntime: "gvisor",
    networkPolicy: "enforced",
    networkPolicyCheckedAt: new Date().toISOString(),
    networkPolicyDetail: null,
    updatedAt: new Date().toISOString(),
    ...over,
  });

  test("says so in one sentence when there are no reports", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [] } });
    await signInAndGo(page, "/console/status");
    await expect(page.getByRole("heading", { name: "Isolation" })).toBeVisible();
    await expect(page.getByText("No report yet \u2014 the runtime has not started.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Re-check network isolation" })).toHaveCount(0);
  });

  test("healthy: one green line, the table collapsed under Details and no Shard column for one shard", async ({
    page,
    request,
  }) => {
    await request.put("/__fake/status", { data: { shards: [report()] } });
    await signInAndGo(page, "/console/status");
    await expect(page.getByTestId("isolation-ok")).toHaveText(
      "Sandboxes run under gVisor and network isolation is enforced.",
    );
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("table")).toBeHidden();
    await shot(page, "isolation-healthy.png");
    await page.getByText("Details", { exact: true }).click();
    const row = page.getByTestId("shard-0");
    await expect(row).toBeVisible();
    await expect(row).toContainText("gvisor");
    await expect(row).toContainText("just now");
    await expect(page.getByRole("columnheader", { name: "Shard" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Last report" })).toBeVisible();
    // A fresh check needs no timestamp of its own.
    await expect(row).not.toContainText("checked");
    await expect(page.getByRole("button", { name: "Re-check network isolation" })).toHaveAttribute(
      "title",
      "Takes up to a minute.",
    );
    for (const gone of ["Asks shard 0", "This page follows", "runtimeClassName"])
      await expect(page.getByText(gone)).toHaveCount(0);
  });

  test("a problem: the alert names the shard, the table is open and mismatches read plainly", async ({
    page,
    request,
  }) => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await request.put("/__fake/status", {
      data: {
        shards: [
          report({ networkPolicyCheckedAt: old }),
          report({
            shard: 1,
            observedRuntime: "",
            networkPolicy: "not-enforced",
            networkPolicyDetail: { state: "not-enforced", reason: "egress to 10.0.0.1 succeeded" },
          }),
          report({
            shard: 2,
            configuredRuntime: "",
            observedRuntime: null,
            networkPolicy: "unknown",
          }),
        ],
      },
    });
    await signInAndGo(page, "/console/status");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("Shard 1: configured gvisor, observed node default.");
    await expect(alert).toContainText("Shard 1: network isolation is not enforced.");
    await expect(alert).toContainText("Shard 2: no sandbox has started yet");
    await expect(page.getByTestId("isolation-ok")).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Shard" })).toBeVisible();
    const first = page.getByTestId("shard-0");
    await expect(first).toContainText("enforced");
    // An old check shows when it ran.
    await expect(first).toContainText("checked");
    const second = page.getByTestId("shard-1");
    await expect(second).toContainText("configured gvisor, observed node default");
    await expect(second).toContainText("not enforced");
    await expect(second).toContainText("egress to 10.0.0.1 succeeded");
    const third = page.getByTestId("shard-2");
    await expect(third).toContainText("not observed yet");
    await expect(third).toContainText("not checked yet");
    await expect(page.getByText("runtimeClassName")).toHaveCount(0);
    await shot(page, "isolation-problem.png");
  });

  test("re-checking turns a not-yet-checked report into the healthy line", async ({
    page,
    request,
  }) => {
    await request.put("/__fake/status", {
      data: { shards: [report({ networkPolicy: "unknown", networkPolicyCheckedAt: null })] },
    });
    await signInAndGo(page, "/console/status");
    await expect(page.getByRole("alert")).toContainText(
      "network isolation has not been checked since the last start.",
    );
    await page.getByRole("button", { name: "Re-check network isolation" }).click();
    await expect(page.getByTestId("isolation-ok")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
