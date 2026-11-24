import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// desktop-page (images/sandbox-desktop/files) copies the focused app's text through agent-desktop-run. A stand-in
// agent-desktop-run on PATH plays a small desktop: keyboard selection, the clipboard and the focused document, all in a JSON
// file. Nothing here names a real site.
const root = resolve(import.meta.dirname, "../../..");
const files = join(root, "images/sandbox-desktop/files");

interface State {
  // the focused document's text
  doc: string;
  selected: boolean;
  clip: string;
}

const fake = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.FAKE_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const log = (l) => fs.appendFileSync(process.env.FAKE_LOG, l + "\\n");
const a = process.argv.slice(2);
log(a.join(" "));
if (a[0] === "--exec") {
  const c = a.slice(1);
  if (c[0] === "xdotool" && c[1] === "key") {
    for (const k of c.slice(3)) {
      if (k === "ctrl+a") s.selected = true;
      else if (k === "ctrl+c" && s.selected) s.clip = s.doc;
    }
  } else if (c[0] === "xclip" && c.includes("-o")) process.stdout.write(s.clip);
  else if (c[0] === "xclip" && c.includes("-i")) s.clip = fs.readFileSync(0, "utf8");
}
fs.writeFileSync(file, JSON.stringify(s));
`;

let dir: string;
let bin: string;

function state(overrides: Partial<State> = {}): void {
  const base: State = {
    doc: "Shopping list\nhoney 250 g\nbread\nTODO call Alice",
    selected: false,
    clip: "agent's own clipboard",
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...base, ...overrides }));
}

const readState = (): State => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State;
const calls = (): string[] => readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n");

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-helpers-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "agent-desktop-run"), fake);
  chmodSync(join(bin, "agent-desktop-run"), 0o755);
  writeFileSync(join(dir, "calls.log"), "");
  state();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function helper(
  name: string,
  ...args: string[]
): { out: string[]; status: number | null; stderr: string } {
  const r = spawnSync("node", [join(files, name), ...args], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FAKE_STATE: join(dir, "state.json"),
      FAKE_LOG: join(dir, "calls.log"),
      AGENT_DESKTOP_SESSION_DIR: join(dir, "session"),
    },
  });
  return { out: r.stdout.trim().split("\n"), status: r.status, stderr: r.stderr };
}

const keys = (): string[] =>
  calls()
    .map((l) => /^--exec xdotool key --clearmodifiers (.+)$/.exec(l)?.[1])
    .filter((k): k is string => k !== undefined);

describe("desktop-page", () => {
  it(
    "prints matching lines of the focused document and saves the text",
    { timeout: 40_000 },
    () => {
      const { out, status } = helper("desktop-page", "--focused", "TODO|honey");
      expect(status).toBe(0);
      expect(out[0]).toBe(`text: ${join(dir, "session", "last-page.txt")} (4 lines)`);
      expect(out).toEqual(expect.arrayContaining(["2: honey 250 g", "4: TODO call Alice"]));
      expect(readFileSync(join(dir, "session", "last-page.txt"), "utf8")).toContain("bread");
    },
  );

  it(
    "presses select all and copy only, and puts the agent's clipboard back",
    { timeout: 40_000 },
    () => {
      helper("desktop-page", "--focused", "bread");
      expect(keys()).toEqual(["ctrl+a", "ctrl+c"]);
      expect(readState().clip).toBe("agent's own clipboard");
    },
  );

  it("prints the first lines without a regex", { timeout: 40_000 }, () => {
    const { out, status } = helper("desktop-page", "--focused");
    expect(status).toBe(0);
    expect(out).toContain("1: Shopping list");
  });

  it("filters the saved text again with --from, without pressing keys", { timeout: 40_000 }, () => {
    helper("desktop-page", "--focused");
    const keysBefore = keys().length;
    const again = helper("desktop-page", "--from", join(dir, "session", "last-page.txt"), "bread");
    expect(again.status).toBe(0);
    expect(again.out).toContain("3: bread");
    expect(keys()).toHaveLength(keysBefore);
  });

  it("refuses to copy without --focused and points at desktop-web", { timeout: 40_000 }, () => {
    const { status, stderr } = helper("desktop-page", "price");
    expect(status).toBe(64);
    expect(stderr).toContain("desktop-web");
    expect(keys()).toEqual([]);
  });

  it("fails when the focused window has no text", { timeout: 40_000 }, () => {
    state({ doc: "" });
    const { status, stderr } = helper("desktop-page", "--focused", "x");
    expect(status).toBe(1);
    expect(stderr).toContain("copied nothing");
  });

  it("no longer takes the Firefox-only --links flag", { timeout: 40_000 }, () => {
    const { status, stderr } = helper("desktop-page", "--focused", "x", "--links");
    expect(status).toBe(64);
    expect(stderr).toContain("unknown flag --links");
  });
});

describe("desktop image settings", () => {
  it("installs Google Chrome from a signed repository and no Firefox", { timeout: 10_000 }, () => {
    const dockerfile = readFileSync(join(root, "images/sandbox-desktop/Dockerfile"), "utf8");
    expect(dockerfile).toContain(
      'apt-get install -y --no-install-recommends "google-chrome-stable=$CHROME_VERSION"',
    );
    expect(dockerfile).toContain("signed-by=/etc/apt/keyrings/google-chrome.gpg");
    expect(dockerfile).toContain("arch=$TARGETARCH");
    expect(dockerfile).toContain("https://dl.google.com/linux/chrome/deb/ stable main");
    // The key is checked against a pinned fingerprint before it becomes a trusted key.
    expect(dockerfile).toMatch(/test "\$fpr" = [0-9A-F]{40}/);
    expect(dockerfile.indexOf('test "$fpr"')).toBeLessThan(dockerfile.indexOf("gpg --dearmor"));
    // The Google source is removed after the install, so later apt-get update runs do not use it.
    expect(dockerfile).toContain("rm -f /etc/apt/sources.list.d/google-chrome.list");
    expect(dockerfile).not.toMatch(/firefox/i);
    expect(dockerfile).toContain(
      "files/chrome-policy.json /etc/opt/chrome/policies/managed/pi-desktop.json",
    );
    expect(dockerfile).toContain("files/desktop-lib.cjs /usr/local/bin/desktop-lib.cjs");
    for (const gone of ["desktop-open", "desktop-click", "desktop-url", "desktop-text"]) {
      expect(dockerfile, gone).not.toContain(gone);
    }
  });

  it("launches Google Chrome, not Chromium or Firefox", { timeout: 10_000 }, () => {
    const launch = readFileSync(join(files, "desktop-launch"), "utf8");
    expect(launch).toContain("cmd=(google-chrome-stable --no-sandbox");
    expect(launch).not.toMatch(/firefox/i);
    const web = readFileSync(join(files, "desktop-web"), "utf8");
    expect(web).toContain('"--class", "[Gg]oogle-chrome"');
    expect(web).toContain('["chrome"]');
  });

  it(
    "leads the skills with the web commands, not desktop-launch (issue #440)",
    { timeout: 10_000 },
    () => {
      const skill = readFileSync(
        join(root, "images/sandbox-desktop/skills/desktop-sandbox/SKILL.md"),
        "utf8",
      );
      expect(skill).not.toContain("Do not launch apps any other way");
      for (const name of ["desktop-web open", "desktop-web text", "desktop-web click"]) {
        expect(skill.indexOf(name), name).toBeLessThan(skill.indexOf("desktop-launch"));
      }
      const refs = readFileSync(
        join(root, "images/sandbox-desktop/skills/agent-desktop/SKILL.md"),
        "utf8",
      );
      expect(refs).toContain("Web pages do not start here");
    },
  );

  it("gives agent-desktop-run a quiet mode", { timeout: 10_000 }, () => {
    expect(readFileSync(join(files, "agent-desktop-run"), "utf8")).toContain(
      'if [ "${1:-}" = "-q" ]; then',
    );
  });
});
