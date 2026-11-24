import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Google's apt repository keeps only the current Chrome, so the image pins one version (ARG CHROME_VERSION) and
// hack/chrome-bump.mjs moves it (docs/decisions/0065-desktop-sandbox.md, "Chrome is pinned"). No test reaches the network.
const root = resolve(import.meta.dirname, "../../..");
const fixtures = join(import.meta.dirname, "fixtures/chrome-packages");
const dockerfilePath = "images/sandbox-desktop/Dockerfile";
const dockerfile = readFileSync(join(root, dockerfilePath), "utf8");
const pin = /^ARG CHROME_VERSION=(\d+(?:\.\d+)+-\d+)$/m.exec(dockerfile)?.[1] ?? "";

const bump = (await import(join(root, "hack/chrome-bump.mjs"))) as {
  chromeVersion(packages: string): string;
  compareVersions(a: string, b: string): number;
  decide(current: string, amd64: string, arm64: string): { bump: boolean; latest: string };
  withPin(dockerfile: string, version: string): string;
};
const fixture = (name: string) => readFileSync(join(fixtures, name), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the desktop image's Chrome pin", () => {
  it("installs google-chrome-stable at the CHROME_VERSION default, from the signed repository", () => {
    expect(pin).not.toBe("");
    expect(dockerfile).toContain('"google-chrome-stable=$CHROME_VERSION"');
    expect(dockerfile).not.toMatch(/install[^\n]*google-chrome-stable \\/);
    expect(dockerfile).toContain("EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796");
    expect(dockerfile).toContain("rm -f /etc/apt/sources.list.d/google-chrome.list");
    expect(dockerfile).toMatch(/no longer served by Google's repository[^\n]*chrome-bump/);
  });
});

describe("hack/chrome-bump.mjs", () => {
  it("reads google-chrome-stable, not the beta or unstable stanzas", () => {
    expect(bump.chromeVersion(fixture("amd64-newer"))).toBe("159.0.8200.10-1");
    expect(() => bump.chromeVersion("Package: other\nVersion: 1-1\n")).toThrow(
      /no google-chrome-stable/,
    );
  });

  it("orders versions numerically", () => {
    expect(bump.compareVersions("158.0.8127.88-1", "158.0.8127.9-1")).toBe(1);
    expect(bump.compareVersions("158.0.8127.88-1", "158.0.8127.88-1")).toBe(0);
    expect(bump.compareVersions("158.0.8127.88-1", "159.0.1.1-1")).toBe(-1);
  });

  it("picks the new version when both architectures list it", () => {
    expect(bump.decide(pin, fixture("amd64-newer"), fixture("arm64-newer"))).toEqual({
      bump: true,
      latest: "159.0.8200.10-1",
    });
  });

  it("refuses when the architectures disagree", () => {
    expect(() => bump.decide(pin, fixture("amd64-newer"), fixture("arm64-lagging"))).toThrow(
      /amd64 lists .* arm64 lists/,
    );
  });

  it("does nothing when the pin is already current", () => {
    expect(bump.decide("158.0.8127.88-1", fixture("amd64-same"), fixture("arm64-same")).bump).toBe(
      false,
    );
  });

  it("rewrites only the ARG default", () => {
    const next = bump.withPin(dockerfile, "159.0.8200.10-1");
    expect(next).toContain("ARG CHROME_VERSION=159.0.8200.10-1\n");
    expect(next.replace("159.0.8200.10-1", pin)).toBe(dockerfile);
  });

  it("run as a command edits a copy of the Dockerfile and reports the bump", () => {
    // The CLI edits the repository's Dockerfile, so run it from a copy of the layout in a temp dir.
    const dir = mkdtempSync(join(tmpdir(), "chrome-bump-"));
    dirs.push(dir);
    spawnSync("mkdir", ["-p", join(dir, "hack"), join(dir, "images/sandbox-desktop")]);
    copyFileSync(join(root, "hack/chrome-bump.mjs"), join(dir, "hack/chrome-bump.mjs"));
    copyFileSync(join(root, dockerfilePath), join(dir, dockerfilePath));
    const run = (a: string, b: string) =>
      spawnSync("node", [join(dir, "hack/chrome-bump.mjs"), join(fixtures, a), join(fixtures, b)], {
        encoding: "utf8",
        timeout: 20_000,
      });
    const same = run("amd64-same", "arm64-same");
    expect(same.stdout).toContain("bump=false");
    expect(readFileSync(join(dir, dockerfilePath), "utf8")).toBe(dockerfile);
    const lag = run("amd64-newer", "arm64-lagging");
    expect(lag.status).toBe(1);
    const up = run("amd64-newer", "arm64-newer");
    expect(up.stdout).toContain("bump=true");
    expect(readFileSync(join(dir, dockerfilePath), "utf8")).toContain(
      "ARG CHROME_VERSION=159.0.8200.10-1\n",
    );
  }, 60_000);
});
