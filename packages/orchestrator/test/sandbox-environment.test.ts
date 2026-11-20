import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRow } from "@cela/session-core";
import { environmentFacts, FLAVOUR_FACTS, renderEnvironment } from "../src/sandbox-environment.ts";

const root = resolve(import.meta.dirname, "../../..");
const dockerfile = (name: string): string =>
  readFileSync(join(root, "images", name, "Dockerfile"), "utf8");

const row = (over: Partial<SessionRow>): SessionRow =>
  ({
    repo: null,
    networkMode: "proxied",
    sandboxFlavour: "default",
    ...over,
  }) as SessionRow;

describe("the sandbox facts in a session's instructions (ADR 0049)", () => {
  it("say there is no checkout in a session without a repo", () => {
    const text = renderEnvironment(environmentFacts(row({}), true));
    expect(text).toContain("Repository: none is checked out, and /workspace starts empty.");
    expect(text).toContain("through the proxy already set in HTTPS_PROXY");
    expect(text).toContain("HOME (/home/pi)");
  });

  it("name the repository and the branch it was cloned from, not a branch it is on", () => {
    const text = renderEnvironment(
      environmentFacts(row({ repo: { repo: "acme/widgets", branch: "dev" } }), true),
    );
    expect(text).toContain("acme/widgets, cloned into /workspace/repo from branch dev.");
    expect(
      renderEnvironment(environmentFacts(row({ repo: { repo: "acme/widgets" } }), true)),
    ).toContain("from its default branch.");
  });

  it("say direct for a direct session, and for every session when the deployment runs without the proxy", () => {
    expect(environmentFacts(row({ networkMode: "direct" }), true).network).toBe("direct");
    expect(environmentFacts(row({ networkMode: "proxied" }), false).network).toBe("direct");
    expect(renderEnvironment(environmentFacts(row({}), false))).toContain(
      "Network: direct internet",
    );
  });

  it("are the same text for the same session: nothing that changes between calls", () => {
    const session = row({ repo: { repo: "acme/widgets" } });
    expect(renderEnvironment(environmentFacts(session, true))).toBe(
      renderEnvironment(environmentFacts(session, true)),
    );
    expect(renderEnvironment(environmentFacts(session, true))).not.toMatch(
      /token=|https?:\/\/|\d{4}-\d{2}-\d{2}/,
    );
  });

  it("match what each image ships", () => {
    const base = dockerfile("sandbox");
    expect(base).toContain(`HOME=${String(FLAVOUR_FACTS.default.home)}`);
    for (const pkg of [
      "git",
      "curl",
      "jq",
      "unzip",
      "python3-pip",
      "python3-venv",
      "build-essential",
    ]) {
      expect(base).toMatch(new RegExp(`apt-get install[\\s\\S]*\\b${pkg}\\b`));
    }
    expect(base).toContain("/tmp/gh.deb");
    expect(base).toContain("corepack enable --install-directory /usr/local/bin pnpm yarn");
    expect(base).toContain("COPY --from=pi-env /usr/local/bin/node /usr/local/bin/node");

    const browser = dockerfile("sandbox-browser");
    // No HOME of its own: uid 1000 has no passwd entry, so HOME is the unwritable `/`.
    expect(FLAVOUR_FACTS.browser.home).toBeNull();
    expect(browser).not.toMatch(/\bHOME=/);
    expect(browser).not.toMatch(/apt-get install[^&]*\bcurl\b/);
    expect(FLAVOUR_FACTS.browser.tools).not.toMatch(/\b(curl|gh|python3)\b/);
    for (const tool of ["pi-browser", "patchright-run", "agent-browser", "/usr/local/bin/node"]) {
      expect(browser).toContain(tool);
    }
    expect(browser).toContain("/usr/local/share/pi-browser/BROWSER.md");
  });
});
