import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { tokens } from "./env";

const { admin } = tokens();

export async function signIn(page: Page, path = "/console/"): Promise<void> {
  await page.goto(path);
  await page.getByLabel("Token").fill(admin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Console" })).toBeVisible();
}

const headers = { authorization: `Bearer ${admin}` };

/** A call to the admin API as the admin, for setting a test up or changing the server behind the page's back. */
export async function api<T = Record<string, unknown>>(
  request: APIRequestContext,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  data?: unknown,
  expectStatus?: number,
): Promise<T> {
  const response = await request.fetch(path, {
    method,
    headers,
    ...(data === undefined ? {} : { data }),
  });
  if (expectStatus !== undefined) expect(response.status(), `${method} ${path}`).toBe(expectStatus);
  else expect(response.ok(), `${method} ${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A name that no other test uses: the fake is shared, and a deleted name is never used again (ADR 0027). */
export function unique(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Puts the global settings back to the seed, so tests do not depend on each other. */
export async function resetSettings(request: APIRequestContext): Promise<void> {
  await api(request, "PUT", "/admin/profiles/coding", { enabledForNew: true });
  await api(request, "PUT", "/admin/settings", {
    defaultModel: "scripted/scripted-1",
    allowlist: ["scripted/scripted-1", "scripted/scripted-2"],
    reasoning: null,
    maxReasoning: null,
    defaultProfile: "coding",
    turnBudget: 100,
    tokenBudget: null,
  });
}

/** Saves a screenshot when `CONSOLE_SHOTS_DIR` is set; otherwise does nothing. */
export async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.CONSOLE_SHOTS_DIR;
  if (dir === undefined || dir === "") return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
