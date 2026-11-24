import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// desktop-find (images/sandbox-desktop/files) keeps a snapshot out of the agent's context: it filters a saved agent-desktop
// snapshot down to short lines. The fixture has the real shape (envelope, nested children, dom_classes, available_actions,
// offscreen state) captured from a lab pod in a reduced form.
const root = resolve(import.meta.dirname, "../../..");
const script = join(root, "images/sandbox-desktop/files/desktop-find");
const ref = (n: number): string => `@sabc:e${String(n)}`;

const fixture = {
  version: "2.6",
  ok: true,
  command: "snapshot",
  data: {
    app: "soffice.bin",
    complete: true,
    ref_count: 8,
    snapshot_id: "sabc",
    tree: {
      ref_id: ref(1),
      role: "window",
      name: "Offers - LibreOffice Writer",
      children: [
        {
          ref_id: ref(2),
          role: "textfield",
          name: "Search or enter address",
          value: "https://allegro.pl/x",
          available_actions: ["SetValue"],
        },
        {
          ref_id: ref(3),
          role: "group",
          dom_classes: ["m1", "m2"],
          children: [
            {
              ref_id: ref(4),
              role: "button",
              name: "Dodaj do koszyka",
              dom_classes: ["m1"],
              available_actions: ["Click"],
            },
            { ref_id: ref(5), role: "button", name: "Dodaj do ulubionych", states: ["offscreen"] },
            { ref_id: ref(6), role: "link", name: `Long ${"x".repeat(400)}`, states: [] },
            { ref_id: ref(7), role: "checkbox", name: "Dodatkowa gwarancja", states: ["checked"] },
            { ref_id: ref(8), role: "menu", states: ["hidden"] },
          ],
        },
      ],
    },
  },
};

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-find-"));
  file = join(dir, "snapshot.json");
  writeFileSync(file, JSON.stringify(fixture));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function find(...args: string[]): { out: string[]; status: number | null; stderr: string } {
  const r = spawnSync("node", [script, "--from", file, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  return { out: r.stdout.trim().split("\n"), status: r.status, stderr: r.stderr };
}

describe("desktop-find", () => {
  it("prints a summary, not the tree, when there is no regex or role", { timeout: 15_000 }, () => {
    const { out } = find();
    expect(out[0]).toBe(`snapshot: ${file}`);
    expect(out.join("\n")).toContain('windows: "Offers - LibreOffice Writer"');
    expect(out.join("\n")).toMatch(/roles: .*button 1/);
    expect(out.join("\n")).not.toContain("@sabc:e4");
  });

  it(
    "matches the name case-insensitively and drops offscreen nodes and the class and action lists",
    { timeout: 15_000 },
    () => {
      const { out } = find("DODAJ");
      expect(out).toEqual([`snapshot: ${file}`, `${ref(4)} button "Dodaj do koszyka"`]);
      expect(find("--all", "dodaj").out).toContain(`${ref(5)} button "Dodaj do ulubionych"`);
    },
  );

  it(
    "filters by role, shows value and state, truncates long names and applies the limit",
    { timeout: 15_000 },
    () => {
      expect(find("--role", "textfield").out[1]).toBe(
        `${ref(2)} textfield "Search or enter address" =https://allegro.pl/x`,
      );
      expect(find("--role", "checkbox").out[1]).toBe(
        `${ref(7)} checkbox "Dodatkowa gwarancja" [checked]`,
      );
      const link = find("--role", "link").out[1] ?? "";
      expect(link.length).toBeLessThan(160);
      expect(link).toContain("…");
      const limited = find("--role", "button,link,checkbox", "--limit", "2").out;
      expect(limited).toHaveLength(4);
      expect(limited[3]).toBe("1 more, narrow the filter (regex, --role, --limit)");
    },
  );

  it("refuses a bad regex and reports an error envelope", { timeout: 15_000 }, () => {
    expect(find("(").status).toBe(64);
    writeFileSync(
      file,
      JSON.stringify({
        ok: false,
        error: { code: "INTERNAL", message: "RefMap exceeds 1MB size limit on write" },
      }),
    );
    const r = find("x");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("RefMap exceeds 1MB");
  });
});

describe("desktop image helpers", () => {
  it(
    "installs the helpers, the packages they need and quiet Node in the wrapper",
    { timeout: 10_000 },
    () => {
      const dockerfile = readFileSync(join(root, "images/sandbox-desktop/Dockerfile"), "utf8");
      for (const name of ["desktop-find", "desktop-shot", "desktop-page"]) {
        expect(dockerfile).toContain(
          `COPY --chmod=0755 images/sandbox-desktop/files/${name} /usr/local/bin/${name}`,
        );
      }
      expect(dockerfile).toMatch(/apt-get install[^&]*\bxclip\b[^&]*\bjq\b[^&]*\bpython3-pil\b/);
      expect(dockerfile).toContain("ln -s python3 /usr/bin/python");
      expect(
        readFileSync(join(root, "images/sandbox-desktop/files/agent-desktop-run"), "utf8"),
      ).toContain("NODE_NO_WARNINGS=1 exec agent-desktop");
    },
  );
});

describe("desktop-find on a tree too large to snapshot", () => {
  // A stand-in agent-desktop-run on PATH: snapshot fails with the RefMap overflow seen on Allegro, find answers.
  // failing: roles whose find answers STALE_REF; "" stands for the unscoped find.
  function fakeRun(failing: string[] = []): string {
    const stale = JSON.stringify({
      version: "2.6",
      ok: false,
      command: "find",
      error: { code: "STALE_REF", message: "Selected locator lacks a verifiable identity" },
    });
    const overflow = JSON.stringify({
      version: "2.6",
      ok: false,
      command: "snapshot",
      error: { code: "INTERNAL", message: "RefMap exceeds 1MB size limit on write" },
    });
    const found = JSON.stringify({
      version: "2.6",
      ok: true,
      command: "find",
      data: {
        matches: [
          {
            ref_id: "@sf:e1",
            role: "link",
            name: "LEGO 42143 Ferrari",
            states: [],
            path: ["window"],
          },
          {
            ref_id: "@sf:e2",
            role: "link",
            name: "Ferrari offscreen",
            states: ["offscreen"],
            path: ["window"],
          },
          { ref_id: "@sf:e3", role: "link", name: "Porsche", states: [], path: ["window"] },
        ],
        total_matches: 3,
        truncated: false,
      },
    });
    const bin = join(dir, "bin");
    const run = join(bin, "agent-desktop-run");
    rmSync(bin, { recursive: true, force: true });
    spawnSync("mkdir", ["-p", bin]);
    writeFileSync(join(dir, "args.log"), "");
    writeFileSync(
      run,
      [
        "#!/bin/sh",
        `echo "$*" >> '${join(dir, "args.log")}'`,
        `if [ "$1" = snapshot ]; then echo '${overflow}'; exit 1; fi`,
        'role=""; prev=""; for a in "$@"; do [ "$prev" = --role ] && role="$a"; prev="$a"; done',
        `for f in ${failing.map((r) => `'${r}'`).join(" ")}; do if [ "$f" = "$role" ]; then echo '${stale}'; exit 1; fi; done`,
        `echo '${found}'`,
        "",
      ].join("\n"),
    );
    chmodSync(run, 0o755);
    return bin;
  }

  function live(...args: string[]): { out: string[]; status: number | null; stderr: string } {
    return liveFailing([], ...args);
  }

  function liveFailing(
    failing: string[],
    ...args: string[]
  ): { out: string[]; status: number | null; stderr: string } {
    const bin = fakeRun(failing);
    const r = spawnSync("node", [script, "--out", join(dir, "out.json"), ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    return { out: r.stdout.trim().split("\n"), status: r.status, stderr: r.stderr };
  }

  it("falls back to agent-desktop find and filters the same way", { timeout: 15_000 }, () => {
    const { out, status } = live("--app", "soffice.bin", "--role", "link", "Ferrari");
    expect(status).toBe(0);
    expect(out).toContain('@sf:e1 link "LEGO 42143 Ferrari"');
    expect(out.join("\n")).not.toContain("offscreen");
    expect(out.join("\n")).not.toContain("Porsche");
    expect(out.at(-1)).toContain("used agent-desktop find");
    const calls = readFileSync(join(dir, "args.log"), "utf8");
    expect(calls).toMatch(/^find --app soffice.bin --role link --text Ferrari /m);
  });

  it("refuses an unfiltered call instead of printing a huge tree", { timeout: 15_000 }, () => {
    const { status, stderr } = live("--app", "soffice.bin");
    expect(status).toBe(1);
    expect(stderr).toContain("add a regex or --role");
    expect(stderr).toContain("desktop-page");
  });

  it("skips a role whose find fails and keeps the others", { timeout: 15_000 }, () => {
    const { out, status } = liveFailing(
      ["statictext"],
      "--app",
      "soffice.bin",
      "--role",
      "statictext,link",
      "Ferrari",
    );
    expect(status).toBe(0);
    expect(out).toContain('@sf:e1 link "LEGO 42143 Ferrari"');
    expect(out.at(-1)).toContain("skipped, find failed: statictext (STALE_REF)");
    expect(out.at(-1)).toContain("desktop-page");
  });

  it("retries a failing unscoped find role by role", { timeout: 15_000 }, () => {
    const { out, status } = liveFailing(["", "button"], "--app", "soffice.bin", "Ferrari|Porsche");
    expect(status).toBe(0);
    expect(out).toContain('@sf:e1 link "LEGO 42143 Ferrari"');
    const calls = readFileSync(join(dir, "args.log"), "utf8")
      .split("\n")
      .filter((l) => l.startsWith("find"));
    expect(calls[0]).not.toContain("--role");
    expect(calls.slice(1).map((l) => /--role (\S+)/.exec(l)?.[1])).toEqual(
      expect.arrayContaining(["heading", "link", "button", "textfield"]),
    );
    const notes = out.slice(-2).join("\n");
    expect(notes).toContain("searched only heading, link, button");
    expect(notes).toContain("skipped, find failed: button (STALE_REF)");
    expect(notes).not.toContain("all roles");
  });

  it("fails with a desktop-page hint when no role answers", { timeout: 15_000 }, () => {
    const { status, stderr } = liveFailing(
      ["link"],
      "--app",
      "soffice.bin",
      "--role",
      "link",
      "Ferrari",
    );
    expect(status).toBe(1);
    expect(stderr).toContain("failed for every role: link (STALE_REF)");
    expect(stderr).toContain("desktop-page");
  });
});
