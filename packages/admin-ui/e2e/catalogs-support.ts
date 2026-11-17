import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { zipSync } from "fflate";
import { tokens } from "./env";

export const { admin } = tokens();

/** A name that no other test of the run uses: the specs share one fake install and run in parallel. */
export function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function signInAndGo(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Token").fill(admin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();
}

export const skillMd = (name: string, description = "Greets the user", extra = ""): string =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n# ${name}\n\nSay hello.\n`;

export const SCRIPT = "#!/bin/sh\necho hello from the skill\n";
/** Bytes that are not text: a NUL, a high byte and a PNG-like signature. */
export const BINARY = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x80]);

/** Writes a folder of files (a folder picker's input) and returns its path; the folder name is the skill's. */
export async function writeSkillFolder(
  root: string,
  name: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  const dir = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}

/** A zip with Unix modes, as `zip` on Linux or macOS writes it: the executable bit is in the external attributes. */
export function makeZip(
  files: Record<string, { data: string | Uint8Array; executable?: boolean }>,
): Buffer {
  const input: Record<string, [Uint8Array, { os: number; attrs: number }]> = {};
  for (const [path, { data, executable }] of Object.entries(files)) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    input[path] = [
      bytes,
      { os: 3, attrs: ((executable === true ? 0o100755 : 0o100644) << 16) >>> 0 },
    ];
  }
  return Buffer.from(zipSync(input));
}

export const bearer = { authorization: `Bearer ${admin}` };

/** A write through the API, as an automation would do it (the console is not the only writer). */
export async function putMcp(
  request: APIRequestContext,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await request.put(`/admin/mcp-servers/${name}`, { headers: bearer, data: body });
  expect(res.ok(), await res.text()).toBe(true);
}

export function shot(page: Page, file: string): Promise<unknown> {
  const dir = process.env.SHOTS_DIR;
  return dir === undefined
    ? Promise.resolve()
    : page.screenshot({ path: join(dir, file), fullPage: true });
}

interface StoredFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
  contentBase64: string;
}

/** What `GET /admin/skills/{name}/versions/{v}?content=true` says, typed. */
export async function storedVersion(
  request: APIRequestContext,
  name: string,
  version: number,
): Promise<{ files: StoredFile[] }> {
  const res = await request.get(`/admin/skills/${name}/versions/${String(version)}?content=true`, {
    headers: bearer,
  });
  expect(res.status()).toBe(200);
  return (await res.json()) as { files: StoredFile[] };
}

export async function versionCount(request: APIRequestContext, name: string): Promise<number> {
  const res = await request.get(`/admin/skills/${name}`, { headers: bearer });
  return ((await res.json()) as { versions: unknown[] }).versions.length;
}

export async function storedMcp(
  request: APIRequestContext,
  name: string,
): Promise<Record<string, unknown>> {
  const res = await request.get(`/admin/mcp-servers/${name}`, { headers: bearer });
  return (await res.json()) as Record<string, unknown>;
}
