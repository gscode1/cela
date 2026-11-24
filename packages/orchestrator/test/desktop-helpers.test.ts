import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// desktop-page, desktop-click and desktop-open (images/sandbox-desktop/files) drive Firefox through agent-desktop-run. A
// stand-in agent-desktop-run on PATH plays a small stateful desktop: keyboard focus (address bar or page), the clipboard, the
// window title, the address, find results and element bounds, all in a JSON file. Nothing here names a real site.
const root = resolve(import.meta.dirname, "../../..");
const files = join(root, "images/sandbox-desktop/files");

interface Node {
  ref_id: string;
  role: string;
  name: string;
  states?: string[];
}

interface State {
  url: string;
  title: string;
  page: string;
  focus: "page" | "url" | "find";
  selection: "" | "page" | "url";
  clip: string;
  typed: string;
  running: boolean;
  nodes: Node[];
  // ref -> how many clicks are refused as offscreen before it is actionable
  refuse: Record<string, number>;
  // ref -> bounds; offscreen ones move on screen when the find bar finds their text
  bounds: Record<string, { x: number; y: number; width: number; height: number }>;
  afterClick: { title: string; url: string; page: string };
  afterNavigate: { title: string; page: string };
  // how many page copies return nothing before the page has text
  blankCopies: number;
  // the active window's app: Firefox unless set
  app?: "mousepad";
  // an error code every accessibility click answers with (until the element is on screen)
  clickError?: string;
}

const fake = `#!/usr/bin/env node
const fs = require("fs");
const file = process.env.FAKE_STATE;
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const log = (l) => fs.appendFileSync(process.env.FAKE_LOG, l + "\\n");
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = (o) => process.stdout.write(typeof o === "string" ? o : JSON.stringify(o));
const a = process.argv.slice(2);
log(a.join(" "));
if (a[0] === "--exec") {
  const c = a.slice(1);
  if (c[0] === "xdotool" && c[1] === "key") {
    for (const k of c.slice(3)) {
      if (k === "ctrl+l") { s.focus = "url"; s.selection = "url"; }
      else if (k === "F6") s.focus = "page";
      else if (k === "ctrl+f") { s.focus = "find"; s.typed = ""; }
      else if (k === "ctrl+a") s.selection = s.focus === "url" ? "url" : s.focus === "page" ? "page" : s.selection;
      else if (k === "ctrl+c") {
        if (s.selection === "url") s.clip = s.url;
        else if (s.selection === "page") {
          if (s.blankCopies > 0) { s.blankCopies--; s.clip = ""; } else s.clip = s.page;
        }
      } else if (k === "Return" && s.focus === "url") {
        s.url = s.typed; s.title = s.afterNavigate.title; s.page = s.afterNavigate.page; s.focus = "page";
      } else if (k === "Return" && s.focus === "find") {
        for (const n of s.nodes) if (n.name.startsWith(s.typed) && s.bounds[n.ref_id]) s.bounds[n.ref_id].y = 300;
      } else if (k === "Escape" && s.focus === "find") s.focus = "page";
    }
  } else if (c[0] === "xdotool" && c[1] === "type") s.typed = c[c.length - 1];
  else if (c[0] === "xdotool" && c[1] === "getactivewindow") out(s.title + (s.app === "mousepad" ? " - Mousepad" : " — Mozilla Firefox") + "\\n");
  else if (c[0] === "xdotool" && c[1] === "search") out(s.running ? "4194307\\n" : "");
  else if (c[0] === "xdotool" && c[1] === "mousemove") { s.title = s.afterClick.title; s.url = s.afterClick.url; s.page = s.afterClick.page; }
  else if (c[0] === "xclip" && c.includes("-o")) out(s.clip);
  else if (c[0] === "xclip" && c.includes("-i")) s.clip = c.includes("/dev/null") ? "" : fs.readFileSync(0, "utf8");
  save();
  process.exit(0);
}
const flag = (f) => { const i = a.indexOf(f); return i < 0 ? undefined : a[i + 1]; };
if (a[0] === "find") {
  const role = flag("--role");
  const text = (flag("--text") || "").toLowerCase();
  const matches = s.nodes.filter((n) => (!role || n.role === role) && n.name.toLowerCase().includes(text));
  out({ version: "2.6", ok: true, command: "find", data: { matches, truncated: false } });
} else if (a[0] === "click") {
  const ref = a[1];
  if ((s.refuse[ref] || 0) > 0 && !(s.bounds[ref] && s.bounds[ref].y < 800)) {
    s.refuse[ref]--;
    save();
    out({ version: "2.6", ok: false, command: "click", error: { code: s.clickError || "ACTION_FAILED", message: "Target is not actionable: visible (live offscreen state is true)" } });
    process.exit(1);
  }
  s.title = s.afterClick.title; s.url = s.afterClick.url; s.page = s.afterClick.page;
  out({ version: "2.6", ok: true, command: "click", data: { action: "click" } });
} else if (a[0] === "get") {
  out({ version: "2.6", ok: true, command: "get", data: { property: flag("--property"), value: s.bounds[a[1]] || null } });
}
save();
`;

let dir: string;
let bin: string;

function state(overrides: Partial<State> = {}): void {
  const base: State = {
    url: "https://shop.example/list",
    title: "List - Shop",
    page: "Shop\nOffers\nAlpha 10,00 zł\nBeta 12,50 zł\nFooter",
    focus: "page",
    selection: "",
    clip: "agent's own clipboard",
    typed: "",
    running: true,
    nodes: [],
    refuse: {},
    bounds: {},
    afterClick: {
      title: "Alpha - Shop",
      url: "https://shop.example/alpha",
      page: "Alpha\nPrice 10,00 zł\nSeller Kowalski",
    },
    afterNavigate: { title: "Docs - Example", page: "Docs\nIntroduction\nInstall with npm" },
    blankCopies: 0,
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
  it("prints url, title and matching lines and saves the text", { timeout: 40_000 }, () => {
    const { out, status } = helper("desktop-page", "zł");
    expect(status).toBe(0);
    expect(out.slice(0, 3)).toEqual([
      "url: https://shop.example/list",
      "title: List - Shop",
      `text: ${join(dir, "session", "last-page.txt")} (5 lines)`,
    ]);
    expect(out).toEqual(expect.arrayContaining(["3: Alpha 10,00 zł", "4: Beta 12,50 zł"]));
    expect(readFileSync(join(dir, "session", "last-page.txt"), "utf8")).toContain("Beta 12,50 zł");
  });

  it("ends with focus in the page and the agent's clipboard put back", { timeout: 40_000 }, () => {
    helper("desktop-page", "zł");
    expect(keys()).toEqual(["ctrl+l", "ctrl+c", "Escape", "F6", "ctrl+a", "ctrl+c"]);
    const s = readState();
    expect(s.focus).toBe("page");
    expect(s.clip).toBe("agent's own clipboard");
  });

  it("copies from the focused widget with --focused and prints no url", { timeout: 40_000 }, () => {
    const { out, status } = helper("desktop-page", "--focused", "zł");
    expect(status).toBe(0);
    expect(out[0]).toBe("title: List - Shop");
    expect(keys()).toEqual(["ctrl+a", "ctrl+c"]);
  });

  it("takes one line of an editor as a document with --focused", { timeout: 40_000 }, () => {
    state({ app: "mousepad", page: "price 42 PLN" });
    const { out, status } = helper("desktop-page", "--focused", "price");
    expect(status).toBe(0);
    expect(out).toContain("1: price 42 PLN");
  });

  it("refuses to press Firefox keys in another app", { timeout: 40_000 }, () => {
    state({ app: "mousepad" });
    const { status, stderr } = helper("desktop-page", "price");
    expect(status).toBe(64);
    expect(stderr).toContain("not Firefox; for an editor or Writer use --focused");
    expect(keys()).toEqual([]);
  });

  it("answers to its first name, desktop-text", { timeout: 40_000 }, () => {
    const link = join(bin, "desktop-text");
    spawnSync("ln", ["-s", join(files, "desktop-page"), link]);
    const r = spawnSync("node", [link, "--bogus"], { encoding: "utf8", timeout: 10_000 });
    expect(r.stderr).toContain("desktop-text: unknown flag --bogus");
  });
});

describe("desktop-click", () => {
  const nodes: Node[] = [
    { ref_id: "@s1:e1", role: "link", name: "Alpha offer" },
    { ref_id: "@s1:e2", role: "link", name: "Beta offer" },
    { ref_id: "@s1:e3", role: "button", name: "Beta offer details", states: ["offscreen"] },
    { ref_id: "@s1:e4", role: "button", name: "Gamma" },
  ];

  it("clicks the one match and reports what changed", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "Alpha");
    expect(status).toBe(0);
    expect(out[0]).toBe('clicked link "Alpha offer" @s1:e1 (accessibility)');
    expect(out[1]).toBe("title: Alpha - Shop (changed)");
    expect(calls()).toContain("click @s1:e1");
    expect(
      calls()
        .filter((l) => l.startsWith("find"))
        .every((l) => l.includes("--text Alpha")),
    ).toBe(true);
  });

  it("clicks nothing and lists candidates when several match", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "offer");
    expect(status).toBe(2);
    expect(out[0]).toContain("2 matches, clicked none");
    expect(out).toEqual(
      expect.arrayContaining([
        '  --nth 0: @s1:e1 link "Alpha offer"',
        '  --nth 1: @s1:e2 link "Beta offer"',
      ]),
    );
    expect(calls().some((l) => l.startsWith("click"))).toBe(false);
  });

  it(
    "clicks the first of identical candidates (one target shown twice)",
    { timeout: 40_000 },
    () => {
      state({
        nodes: [
          { ref_id: "@s1:e5", role: "link", name: "Same book" },
          { ref_id: "@s1:e6", role: "link", name: "Same book " },
        ],
      });
      const { out, status } = helper("desktop-click", "Same book");
      expect(status).toBe(0);
      expect(out[0]).toBe('clicked link "Same book" @s1:e5 (accessibility, first of 2 identical)');
    },
  );

  it("clicks the chosen candidate with --nth", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "offer", "--nth", "1");
    expect(status).toBe(0);
    expect(out[0]).toContain("@s1:e2");
  });

  it("exits 2 without clicking when nothing matches", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "Delta");
    expect(status).toBe(2);
    expect(out[0]).toContain("no link/button matches /Delta/");
  });

  it("treats a click that times out like a refused one", { timeout: 40_000 }, () => {
    state({
      nodes: [{ ref_id: "@s1:e8", role: "link", name: "Theta deep in a long page" }],
      refuse: { "@s1:e8": 5 },
      clickError: "TIMEOUT",
      bounds: { "@s1:e8": { x: 100, y: 32_000, width: 200, height: 20 } },
    });
    const { out, status } = helper("desktop-click", "Theta");
    expect(status).toBe(0);
    expect(out[0]).toContain("@s1:e8 (accessibility)");
    expect(keys()).toContain("ctrl+f");
  });

  it(
    "brings an offscreen element into view with the find bar, then clicks it",
    { timeout: 40_000 },
    () => {
      state({
        nodes: [{ ref_id: "@s1:e9", role: "link", name: "Zeta far below" }],
        refuse: { "@s1:e9": 5 },
        bounds: { "@s1:e9": { x: 100, y: 32_000, width: 200, height: 20 } },
      });
      const { out, status } = helper("desktop-click", "Zeta");
      expect(status).toBe(0);
      expect(out[0]).toContain("@s1:e9 (accessibility)");
      expect(keys()).toEqual(expect.arrayContaining(["ctrl+f", "Return", "Escape"]));
      expect(calls()).toContain("--exec xdotool type --delay 2 Zeta far below");
    },
  );

  it(
    "falls back to a mouse click at the centre when the click stays refused on screen",
    { timeout: 40_000 },
    () => {
      state({
        nodes: [{ ref_id: "@s1:e7", role: "button", name: "Eta" }],
        refuse: { "@s1:e7": 99 },
        bounds: { "@s1:e7": { x: 100, y: 900, width: 40, height: 20 } },
      });
      // On screen after the find bar (y 300), but the fake keeps refusing: the helper must click physically.
      writeFileSync(
        join(bin, "agent-desktop-run"),
        fake.replace("!(s.bounds[ref] && s.bounds[ref].y < 800)", "true"),
      );
      const { out, status } = helper("desktop-click", "Eta");
      expect(status).toBe(0);
      expect(out[0]).toContain("(physical)");
      expect(calls()).toContain("--exec xdotool mousemove 120 310 click 1");
    },
  );

  it("accepts a ref from desktop-find and skips the search", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "@s1:e4");
    expect(status).toBe(0);
    expect(out[0]).toBe("clicked @s1:e4 (accessibility)");
    expect(calls().some((l) => l.startsWith("find"))).toBe(false);
  });

  it("appends the new page's matching lines with --show", { timeout: 40_000 }, () => {
    state({ nodes });
    const { out, status } = helper("desktop-click", "Alpha", "--show", "Seller");
    expect(status).toBe(0);
    expect(out).toContain("url: https://shop.example/alpha");
    expect(out).toContain("3: Seller Kowalski");
  });
});

describe("desktop-open", () => {
  it("types the URL into a running Firefox and prints the new page", { timeout: 40_000 }, () => {
    const { out, status } = helper("desktop-open", "https://docs.example/start", "npm");
    expect(status).toBe(0);
    expect(out.slice(0, 2)).toEqual(["url: https://docs.example/start", "title: Docs - Example"]);
    expect(out).toContain("3: Install with npm");
    expect(calls()).toContain("--exec xdotool type --delay 2 https://docs.example/start");
  });

  it("copies again while the page has no text yet", { timeout: 40_000 }, () => {
    state({ blankCopies: 2 });
    const { out, status } = helper("desktop-open", "https://docs.example/start");
    expect(status).toBe(0);
    expect(out).toContain("2: Introduction");
  });

  it("refuses a URL outside the web and the workspace", { timeout: 10_000 }, () => {
    const { status, stderr } = helper("desktop-open", "file:///etc/passwd");
    expect(status).toBe(64);
    expect(stderr).toContain("must start with");
  });
});

describe("desktop image settings", () => {
  it(
    "force-installs the pinned cookie banner extension and turns off popups",
    { timeout: 10_000 },
    () => {
      const dockerfile = readFileSync(join(root, "images/sandbox-desktop/Dockerfile"), "utf8");
      expect(dockerfile).toMatch(
        /ADD --checksum=sha256:[0-9a-f]{64} [^\n]*\n[^\n]*istilldontcareaboutcookies-1\.1\.9\.xpi/,
      );
      expect(dockerfile).toContain("RUN ln -s desktop-page /usr/local/bin/desktop-text");
      expect(dockerfile).toContain("files/desktop-lib.cjs /usr/local/bin/desktop-lib.cjs");
      const policies = JSON.parse(readFileSync(join(files, "firefox-policies.json"), "utf8")) as {
        policies: {
          ExtensionSettings: Record<string, { installation_mode: string; install_url?: string }>;
          Preferences: Record<string, unknown>;
        };
      };
      const ext = policies.policies.ExtensionSettings;
      expect(ext["*"]?.installation_mode).toBe("blocked");
      expect(ext["idcac-pub@guus.ninja"]?.installation_mode).toBe("force_installed");
      // The policy loads the file the image puts there, from a directory that existed before the ADD (an ADD-created
      // directory is root-only and Firefox runs as pi).
      const target = (ext["idcac-pub@guus.ninja"]?.install_url ?? "").replace(/^file:\/\//, "");
      expect(target).toBe("/usr/lib/firefox-esr/distribution/idcac-pub@guus.ninja.xpi");
      expect(dockerfile).toContain(`istilldontcareaboutcookies-1.1.9.xpi \\\n  ${target}\n`);
      expect(dockerfile).toContain("/usr/lib/firefox-esr/distribution/policies.json");
      expect(policies.policies.Preferences).toMatchObject({
        "browser.translations.enable": false,
        "browser.translations.automaticallyPopup": false,
        "media.webspeech.synth.enabled": false,
      });
    },
  );

  it("gives agent-desktop-run a quiet mode", { timeout: 10_000 }, () => {
    expect(readFileSync(join(files, "agent-desktop-run"), "utf8")).toContain(
      'if [ "${1:-}" = "-q" ]; then',
    );
  });
});

describe("desktop-url", () => {
  function url(): { out: string; status: number | null; stderr: string } {
    const r = spawnSync("bash", [join(files, "desktop-url")], {
      encoding: "utf8",
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_STATE: join(dir, "state.json"),
        FAKE_LOG: join(dir, "calls.log"),
      },
    });
    return { out: r.stdout.trim(), status: r.status, stderr: r.stderr };
  }

  it("refuses outside Firefox instead of pressing its keys", { timeout: 20_000 }, () => {
    state({ app: "mousepad" });
    const { status, stderr } = url();
    expect(status).toBe(64);
    expect(stderr).toContain("not Firefox");
    expect(keys()).toEqual([]);
  });

  it("prints the URL and leaves focus in the page", { timeout: 20_000 }, () => {
    const { out, status } = url();
    expect(status).toBe(0);
    expect(out).toBe("https://shop.example/list");
    expect(keys().at(-1)).toBe("F6");
    expect(readState().clip).toBe("agent's own clipboard");
  });
});
