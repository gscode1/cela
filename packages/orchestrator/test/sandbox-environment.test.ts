import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionRow } from "@cela/session-core";
import {
  environmentFacts,
  FLAVOUR_FACTS,
  renderEnvironment,
  SANDBOX_HOME,
} from "../src/sandbox-environment.ts";

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
    // The date itself is never in the instructions (ADR 0057), only where to find it.
    expect(text).toContain("each user message starts with <current_date>");
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
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

  it("name the egress rule sets of the profile and what a refusal looks like (ADR 0052)", () => {
    const text = renderEnvironment(environmentFacts(row({}), true, ["packages", "github-public"]));
    expect(text).toContain("egress rule sets packages, github-public.");
    expect(text).toContain("407 Request rejected by proxy: <host> is not allowed");
    expect(renderEnvironment(environmentFacts(row({}), true))).toContain(
      "names no egress rule set",
    );
    // A direct session has no rules to name.
    expect(
      renderEnvironment(environmentFacts(row({ networkMode: "direct" }), true, ["packages"])),
    ).not.toContain("rule set");
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
    for (const pkg of [
      "git",
      "curl",
      "jq",
      "ripgrep",
      "fd-find",
      "tree",
      "file",
      "zip",
      "xz-utils",
      "bzip2",
      "sqlite3",
      "shellcheck",
      "git-lfs",
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
    expect(browser).not.toMatch(/apt-get install[^&]*\bcurl\b/);
    expect(FLAVOUR_FACTS.browser.tools).not.toMatch(/\b(curl|gh|python3)\b/);
    for (const tool of ["pi-browser", "patchright-run", "agent-browser", "/usr/local/bin/node"]) {
      expect(browser).toContain(tool);
    }
    expect(browser).toContain("/usr/local/share/pi-browser/BROWSER.md");
  });

  it("match the user both images run as: pi, uid and gid 1000, with a writable home (issue #324)", () => {
    for (const name of ["sandbox", "sandbox-browser"]) {
      const text = dockerfile(name);
      expect(text, name).toContain(`HOME=${SANDBOX_HOME}`);
      expect(text, name).toContain(`useradd -U -u 1000 -d ${SANDBOX_HOME} -M -s /bin/bash pi`);
      expect(text, name).toContain('test "$(id -u pi):$(id -g pi)" = 1000:1000');
      expect(text, name).toContain(`install -d -o 1000 -g 1000 ${SANDBOX_HOME}`);
      expect(text.trimEnd().endsWith("USER 1000:1000"), name).toBe(true);
    }
    expect(renderEnvironment({ flavour: "browser", repo: null, network: "proxied" })).toContain(
      `HOME (${SANDBOX_HOME})`,
    );
  });
});
