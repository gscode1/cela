import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@cela/session-core";
import { describe, expect, it } from "vitest";

// The skills shipped next to a sandbox image are published through the skills API by the seed scripts
// (hack/seed-*-profile.mjs). Run them through the same frontmatter reader the API uses, so a skill the API would refuse
// fails here instead of at seed time on a live install (issue #410).
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const images = join(root, "images");

const skills = readdirSync(images, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((image) => {
    const dir = join(images, image.name, "skills");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    return names.map((name) => ({ image: image.name, name, path: join(dir, name, "SKILL.md") }));
  });

describe("skills shipped with the sandbox images", () => {
  it("finds the browser and desktop skills", { timeout: 10_000 }, () => {
    expect(skills.map((skill) => `${skill.image}/${skill.name}`)).toEqual(
      expect.arrayContaining([
        "sandbox-browser/agent-browser",
        "sandbox-desktop/agent-desktop",
        "sandbox-desktop/desktop-sandbox",
      ]),
    );
  });

  it.each(skills)(
    "$image/$name has frontmatter the skills API accepts",
    { timeout: 10_000 },
    ({ name, path }) => {
      const result = parseFrontmatter(readFileSync(path, "utf8"));
      if (result.kind !== "ok") {
        throw new Error(`${path}: ${result.kind === "error" ? result.message : "no frontmatter"}`);
      }
      expect(result.fields.get("name")).toBe(name);
      expect(result.fields.get("description")?.trim()).not.toBe("");
    },
  );
});
