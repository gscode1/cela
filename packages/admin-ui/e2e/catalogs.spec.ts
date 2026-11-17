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
const confirm = (page: Page) =>
  page.getByLabel("I have reviewed these files and want to publish them");

test.describe("skills", () => {
  test("publishes a folder: review, executable toggle, confirmation, then a pin link", async ({
    page,
  }, info) => {
    const name = unique("folder");
    const root = await mkdtemp(join(tmpdir(), "skill-folder-"));
    const dir = await writeSkillFolder(root, name, {
      "SKILL.md": skillMd(name),
      "scripts/run.sh": SCRIPT,
      "notes.txt": "plain notes\n",
    });
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await page.getByLabel("Folder").setInputFiles(dir);

    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText("Greets the user");
    await expect(page.getByText("This is the first version")).toBeVisible();
    await expect(
      page.getByText("Publishing deploys code that runs in every session that pins"),
    ).toBeVisible();
    // The folder name wrapped every path and is gone; a folder cannot tell the executable bit.
    const script = page.getByTestId("file-scripts/run.sh");
    await expect(script).toContainText("scripts/run.sh");
    await expect(script.getByRole("checkbox")).not.toBeChecked();
    await expect(publishButton(page, name)).toBeDisabled();

    await script.getByRole("checkbox").check();
    await script.getByRole("button", { name: "View" }).click();
    await expect(page.locator("pre").filter({ hasText: "hello from the skill" })).toBeVisible();
    await shot(page, "skill-upload-review.png");
    await confirm(page).check();
    await publishButton(page, name).click();

    await expect(page.getByRole("heading", { name: "Published v1" })).toBeVisible();
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

  test("publishes a zip with a script and a binary, and a zip download keeps the bit", async ({
    page,
  }) => {
    const name = unique("zipped");
    const zip = makeZip({
      "SKILL.md": { data: skillMd(name, "Has a script and a binary") },
      "run.sh": { data: SCRIPT, executable: true },
      "bin/tool.bin": { data: BINARY, executable: true },
    });
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await page
      .getByLabel("Zip")
      .setInputFiles({ name: `${name}.zip`, mimeType: "application/zip", buffer: zip });

    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    // The bit comes from the zip: both are preset.
    await expect(page.getByTestId("file-run.sh").getByRole("checkbox")).toBeChecked();
    const binary = page.getByTestId("file-bin/tool.bin");
    await expect(binary.getByRole("checkbox")).toBeChecked();
    await expect(binary).toContainText("binary: digest only");
    await expect(binary.getByRole("button", { name: "View" })).toHaveCount(0);
    await confirm(page).check();
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: "Published v1" })).toBeVisible();

    const stored = await storedVersion(page.request, name, 1);
    const tool = stored.files.find((f) => f.path === "bin/tool.bin");
    expect(Buffer.from(tool?.contentBase64 ?? "", "base64")).toEqual(Buffer.from(BINARY));
    expect(tool?.executable).toBe(true);

    // Versions screen: manifest, a text file on demand, a binary by digest only, and the zip.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await expect(page.getByTestId("version-1")).toContainText("Has a script and a binary");
    await page.getByRole("button", { name: "Show files" }).click();
    await expect(page.getByRole("cell", { name: "bin/tool.bin" })).toBeVisible();
    await expect(page.getByText("executable").first()).toBeVisible();
    await shot(page, "skill-versions-manifest.png");
    await page
      .getByRole("row", { name: /SKILL\.md/ })
      .getByRole("button", { name: "View" })
      .click();
    await expect(page.locator("pre").filter({ hasText: "Say hello." })).toBeVisible();
    await page
      .getByRole("row", { name: /bin\/tool\.bin/ })
      .getByRole("button", { name: "View" })
      .click();
    await expect(page.getByText(/Binary file, 8 B/)).toBeVisible();
    await expect(page.getByText(tool?.sha256 ?? "missing")).toBeVisible();

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

  test("an identical upload creates no version; a changed one shows a diff and makes v2", async ({
    page,
  }) => {
    const name = unique("again");
    const files = {
      "SKILL.md": { data: skillMd(name) },
      "run.sh": { data: SCRIPT, executable: true },
    };
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await page
      .getByLabel("Zip")
      .setInputFiles({ name: "a.zip", mimeType: "application/zip", buffer: makeZip(files) });
    await confirm(page).check();
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: "Published v1" })).toBeVisible();

    // The same content again: the review says so, and so does the answer.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await page.getByRole("link", { name: "Publish a new version" }).click();
    await page
      .getByLabel("Zip")
      .setInputFiles({ name: "a.zip", mimeType: "application/zip", buffer: makeZip(files) });
    await expect(
      page.getByText("Identical to v1: publishing will create no new version."),
    ).toBeVisible();
    await confirm(page).check();
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: "Nothing was published" })).toBeVisible();
    await expect(page.getByText("the API created no new version")).toBeVisible();
    expect(await versionCount(page.request, name)).toBe(1);

    // A changed script: the diff against v1.
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await page.getByRole("link", { name: "Publish a new version" }).click();
    const changed = {
      ...files,
      "run.sh": { data: `${SCRIPT}echo more\n`, executable: true },
      "new.txt": { data: "n" },
    };
    await page
      .getByLabel("Zip")
      .setInputFiles({ name: "b.zip", mimeType: "application/zip", buffer: makeZip(changed) });
    await expect(page.getByTestId("diff-summary")).toHaveText(
      "Against v1: 1 added, 0 removed, 1 changed, 1 unchanged",
    );
    await page.getByTestId("file-run.sh").getByRole("button", { name: "Diff" }).click();
    await expect(page.locator("pre div", { hasText: "+ echo more" })).toBeVisible();
    await expect(page.locator("pre div", { hasText: "echo hello from the skill" })).toBeVisible();
    await confirm(page).check();
    await publishButton(page, name).click();
    await expect(page.getByRole("heading", { name: "Published v2" })).toBeVisible();
    await page.getByRole("link", { name: `Back to ${name}` }).click();
    await expect(page.getByTestId("version-2")).toContainText("current");
    await expect(page.getByTestId("version-1")).toBeVisible();
  });

  test("a bad frontmatter or an oversized bundle blocks the publish and says why", async ({
    page,
  }) => {
    const name = unique("bad");
    await signInAndGo(page, `/console/skills/${name}/publish`);
    await page.getByLabel("Zip").setInputFiles({
      name: "bad.zip",
      mimeType: "application/zip",
      buffer: makeZip({ "SKILL.md": { data: "# no frontmatter at all\n" } }),
    });
    await expect(page.getByText("SKILL.md must start with a YAML frontmatter block")).toBeVisible();
    await confirm(page).check();
    await expect(publishButton(page, name)).toBeDisabled();

    const many: Record<string, { data: string }> = { "SKILL.md": { data: skillMd(name) } };
    for (let i = 0; i < 128; i++) many[`f${String(i)}.txt`] = { data: "x" };
    await page
      .getByLabel("Zip")
      .setInputFiles({ name: "many.zip", mimeType: "application/zip", buffer: makeZip(many) });
    await expect(
      page.getByText(/a skill may hold at most 128 files \(this has 129\)/),
    ).toBeVisible();
    await expect(publishButton(page, name)).toBeDisabled();

    await page.getByLabel("Zip").setInputFiles({
      name: "name.zip",
      mimeType: "application/zip",
      buffer: makeZip({ "SKILL.md": { data: skillMd("someone-else") } }),
    });
    await expect(page.getByText(/differs from the skill name/)).toBeVisible();
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
    await page.getByLabel("Zip").setInputFiles({
      name: "x.zip",
      mimeType: "application/zip",
      buffer: makeZip({ "SKILL.md": { data: skillMd(name, `"${hostile}"`) } }),
    });
    await expect(page.getByLabel("Parsed SKILL.md")).toContainText(hostile);
    await confirm(page).check();
    await publishButton(page, name).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "The API refused the publish" }),
    ).toContainText('<b>"boom"</b>: files must include SKILL.md');
    await expect(page.locator("main b, main img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  });

  test("lists skills and shows which profiles pin each version", async ({ page, request }) => {
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
    const row = page.getByTestId(`skill-${name}`);
    await expect(row).toContainText("Pinned thing");
    await expect(row).toContainText("not in model catalog");
    await row.getByRole("link", { name }).click();
    await expect(page.getByTestId("version-1")).toContainText("model invocation disabled");
    await expect(page.getByTestId("version-1").getByRole("link", { name: profile })).toBeVisible();
  });
});

test.describe("MCP servers", () => {
  async function register(page: Page, name: string, url: string): Promise<void> {
    await page.getByRole("button", { name: "Register a server" }).click();
    await page.getByLabel("Name", { exact: true }).fill(name);
    await page.getByLabel("URL").fill(url);
  }

  test("registers a server: https only, readOnly declared on purpose, then offers a profile link", async ({
    page,
  }) => {
    const name = unique("reg");
    await signInAndGo(page, "/console/mcp-servers");
    await register(page, name, "http://plain.example.com/mcp");
    const submit = page.getByRole("button", { name: "Register", exact: true });
    await expect(page.getByText("the URL must be https", { exact: true })).toBeVisible();
    await expect(submit).toBeDisabled();
    await page.getByLabel("URL").fill("https://mcp.example.com/mcp");
    // Nothing is preselected: the declaration has to be made.
    await expect(page.getByText("declare whether the server is read-only")).toBeVisible();
    await expect(page.getByRole("radio", { name: /^Read-only/ })).not.toBeChecked();
    await expect(page.getByRole("radio", { name: /^Not read-only/ })).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await page.getByRole("radio", { name: /^Read-only/ }).check();
    await submit.click();

    await expect(page.getByRole("heading", { name: `Saved ${name}` })).toBeVisible();
    await expect(page.getByRole("link", { name: `Add ${name} to a profile` })).toHaveAttribute(
      "href",
      `/console/profiles?addMcp=${name}`,
    );
    await page.getByRole("button", { name: "Done" }).click();
    const card = page.getByTestId(`mcp-${name}`);
    await expect(card).toContainText("https://mcp.example.com/mcp");
    await expect(card).toContainText("unknown");
    await expect(card).toContainText("none (read-only until #42)");
    await expect(card).toContainText("readOnly: true");
    await expect(page.getByText(new RegExp(`${name} created by alice`))).toBeVisible();
    await shot(page, "mcp-list.png");
  });

  test("an edit that changes the URL asks for the readOnly declaration again", async ({
    page,
    request,
  }) => {
    const name = unique("edit");
    await putMcp(request, name, { url: "https://one.example.com/mcp", readOnly: true });
    await signInAndGo(page, "/console/mcp-servers");
    const card = page.getByTestId(`mcp-${name}`);
    await card.getByRole("button", { name: "Edit" }).click();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();

    await page.getByLabel("timeoutMs").fill("90000");
    await expect(save).toBeEnabled();
    await page.getByLabel("URL").fill("https://two.example.com/mcp");
    await expect(page.getByText("The URL changed. Declare read-only again")).toBeVisible();
    await expect(save).toBeDisabled();
    await page.getByRole("radio", { name: /^Read-only/ }).check();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByRole("heading", { name: `Saved ${name}` })).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(card).toContainText("https://two.example.com/mcp");
    await expect(card).toContainText("90000");
    await expect(card).toContainText(/Revision\s*2/);
    await expect(
      page.getByText(/url: https:\/\/one\.example\.com\/mcp -> https:\/\/two\.example\.com\/mcp/),
    ).toBeVisible();

    // The API's own range check is mirrored before the request is made.
    await card.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("maxOutputBytes").fill("99999");
    await expect(page.getByText("maxOutputBytes must be from 1024 to 24576")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("a stale edit keeps the draft, shows the conflict and saves after a reload", async ({
    page,
    request,
  }) => {
    const name = unique("race");
    await putMcp(request, name, { url: "https://race.example.com/mcp", readOnly: true });
    await signInAndGo(page, "/console/mcp-servers");
    const card = page.getByTestId(`mcp-${name}`);
    await card.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("timeoutMs").fill("45000");

    // Someone else changes the server meanwhile.
    await putMcp(request, name, { maxOutputBytes: 2048, expectedRevision: 1 });
    await page.getByRole("button", { name: "Save changes" }).click();
    const alert = page.getByRole("alert").filter({ hasText: "revision 2, not the expected 1" });
    await expect(alert).toBeVisible();
    await expect(page.getByLabel("timeoutMs")).toHaveValue("45000");

    await alert.getByRole("button", { name: "Reload the stored server" }).click();
    await expect(page.getByText(/Stored now \(revision 2, by alice\)/)).toBeVisible();
    await expect(page.getByLabel("timeoutMs")).toHaveValue("45000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: `Saved ${name}` })).toBeVisible();
    const stored = await storedMcp(request, name);
    expect(stored).toMatchObject({ revision: 3, timeoutMs: 45000, maxOutputBytes: 2048 });
  });

  test("disables and enables; a server not declared read-only asks again before it is enabled", async ({
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

    const roCard = page.getByTestId(`mcp-${ro}`);
    await roCard.getByRole("button", { name: "Disable" }).click();
    await expect(roCard.getByText("disabled", { exact: true })).toBeVisible();
    await expect(roCard).toContainText("its tools are unavailable to sessions");
    await roCard.getByRole("button", { name: "Enable" }).click();
    await expect(roCard.getByText("enabled", { exact: true })).toBeVisible();

    const rwCard = page.getByTestId(`mcp-${rw}`);
    await expect(rwCard.getByText("disabled", { exact: true })).toBeVisible();
    await rwCard.getByRole("button", { name: "Enable" }).click();
    const panel = page.getByLabel(`Enable ${rw}`);
    await expect(panel.getByRole("button", { name: "Enable" })).toBeDisabled();
    await panel.getByRole("radio", { name: /^Not read-only/ }).check();
    await panel.getByRole("button", { name: "Enable" }).click();
    await expect(rwCard.getByText("enabled", { exact: true })).toBeVisible();
  });

  test("delete names the referencing profiles, suggests disabling, and removes the server on confirm", async ({
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
    const card = page.getByTestId(`mcp-${name}`);
    await expect(card.getByRole("link", { name: profile })).toBeVisible();
    await card.getByRole("button", { name: "Delete" }).click();
    const panel = page.getByLabel(`Delete ${name}`);
    await expect(panel).toContainText(`Still referenced by ${profile}`);
    await expect(panel).toContainText("Disable the server instead");
    await shot(page, "mcp-delete-confirmation.png");

    await panel.getByRole("button", { name: "Disable instead" }).click();
    await expect(panel).toHaveCount(0);
    await expect(card.getByText("disabled", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Delete" }).click();
    await page
      .getByLabel(`Delete ${name}`)
      .getByRole("button", { name: `Delete ${name}` })
      .click();
    await expect(card).toHaveCount(0);
    await expect(page.getByText(new RegExp(`${name} deleted by alice`))).toBeVisible();
    expect((await request.get(`/admin/mcp-servers/${name}`, { headers: bearer })).status()).toBe(
      404,
    );
  });
});

test.describe("shard status", () => {
  test.describe.configure({ mode: "serial" });

  test("says so when there are no reports", async ({ page, request }) => {
    await request.put("/__fake/status", { data: { shards: [] } });
    await signInAndGo(page, "/console/status");
    await expect(page.getByText("No reports yet.")).toBeVisible();
    await expect(page.getByRole("table")).toHaveCount(0);
    // Nothing to probe yet: the API answers 503 and the console shows it.
    await page.getByRole("button", { name: "Run the isolation probe again" }).click();
    await expect(
      page.getByRole("alert").filter({ hasText: "has not published a status row yet" }),
    ).toBeVisible();
  });

  test("tells null (not observed) from the empty string (node default) and shows unknown policy", async ({
    page,
    request,
  }) => {
    await request.put("/__fake/status", {
      data: {
        shards: [
          {
            shard: 0,
            configuredRuntime: "gvisor",
            observedRuntime: null,
            networkPolicy: "unknown",
            networkPolicyCheckedAt: null,
            networkPolicyDetail: null,
            updatedAt: "2026-11-17T00:00:00.000Z",
          },
          {
            shard: 1,
            configuredRuntime: "",
            observedRuntime: "",
            networkPolicy: "unknown",
            networkPolicyCheckedAt: null,
            networkPolicyDetail: null,
            updatedAt: "2026-11-17T00:01:00.000Z",
          },
        ],
      },
    });
    await signInAndGo(page, "/console/status");
    const first = page.getByTestId("shard-0");
    await expect(first).toContainText("gvisor");
    await expect(first).toContainText("not observed yet");
    await expect(first).toContainText("unknown");
    await expect(first).toContainText("2026-11-17T00:00:00.000Z");
    const second = page.getByTestId("shard-1");
    await expect(second).toContainText("node default (no runtimeClassName)");
    await expect(second).not.toContainText("not observed yet");
    await shot(page, "shard-status.png");

    await page.getByRole("button", { name: "Run the isolation probe again" }).click();
    await expect(page.getByText("Probe requested.")).toBeVisible();
    await expect(first).toContainText("enforced");
    await expect(first).not.toContainText("the isolation probe has not run");
  });
});
