import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRoot } from "./support/helm.js";

// How agent-desktop-run binds the lab and public live view (ADR 0065, 0066), run against stub binaries so no X server is
// needed: which address websockify gets, that x11vnc stays on loopback, and that the pgrep pattern fits either bind.

const script = join(repoRoot, "images/sandbox-desktop/files/agent-desktop-run");
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-run-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "state"));
  writeFileSync(
    join(dir, "state", "env"),
    "export DISPLAY=:99\nexport DBUS_SESSION_BUS_ADDRESS=x\nexport XDG_RUNTIME_DIR=/tmp\n",
  );
  const stub = (name: string, body: string): void => {
    writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "bin", name), 0o755);
  };
  for (const name of ["xdpyinfo", "dbus-send", "openbox", "agent-desktop"]) stub(name, "exit 0");
  // The window manager is "running"; x11vnc and websockify are not, so the wrapper starts them.
  stub("pgrep", 'case "$*" in *openbox*) exit 0 ;; *) exit 1 ;; esac');
  stub("setsid", `echo "$@" >> "${dir}/started"`);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(env: Record<string, string>): string[] {
  const result = spawnSync("/bin/sh", [script], {
    env: {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      HOME: dir,
      AGENT_DESKTOP_SESSION_DIR: join(dir, "state"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  expect(result.status, result.stderr).toBe(0);
  // `setsid ... &` runs in the background: give the stubs a moment to write.
  for (let i = 0; i < 100; i += 1) {
    const lines = existsSync(join(dir, "started"))
      ? readFileSync(join(dir, "started"), "utf8").trim().split("\n")
      : [];
    if (lines.length >= 2 || env.PI_DESKTOP_LIVE_VIEW === "0") return lines.filter((l) => l !== "");
    spawnSync("sleep", ["0.05"]);
  }
  return [];
}

describe("agent-desktop-run live view bind", () => {
  it("binds websockify to loopback by default, and x11vnc always", () => {
    const started = run({});
    expect(started.find((l) => l.startsWith("websockify"))).toBe(
      "websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900",
    );
    expect(started.find((l) => l.startsWith("x11vnc"))).toMatch(
      /-listen 127\.0\.0\.1 .*-localhost -viewonly/,
    );
  });

  it("binds websockify to the Pod address only for PI_DESKTOP_LIVE_VIEW_LISTEN=0.0.0.0", () => {
    const started = run({ PI_DESKTOP_LIVE_VIEW_LISTEN: "0.0.0.0" });
    expect(started.find((l) => l.startsWith("websockify"))).toBe(
      "websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900",
    );
    expect(started.find((l) => l.startsWith("x11vnc"))).toMatch(/-listen 127\.0\.0\.1 /);
  });

  it("ignores any other value", () => {
    for (const value of ["10.0.0.5", "::", "0.0.0.0; id", ""]) {
      const started = run({ PI_DESKTOP_LIVE_VIEW_LISTEN: value });
      expect(
        started.find((l) => l.startsWith("websockify")),
        value,
      ).toContain(" 127.0.0.1:6080 ");
      rmSync(join(dir, "started"), { force: true });
    }
  });

  it("starts nothing with PI_DESKTOP_LIVE_VIEW=0", () => {
    expect(run({ PI_DESKTOP_LIVE_VIEW: "0", PI_DESKTOP_LIVE_VIEW_LISTEN: "0.0.0.0" })).toEqual([]);
  });

  it("recognises a running websockify whichever address it is bound to", () => {
    const text = readFileSync(script, "utf8");
    const pattern = /pgrep -u "\$\(id -u\)" -f '(websockify [^']*)'/.exec(text)?.[1];
    expect(pattern).toBeDefined();
    const re = new RegExp(pattern ?? "");
    for (const bind of ["127.0.0.1", "0.0.0.0"]) {
      expect(re.test(`websockify --web /usr/share/novnc ${bind}:6080 127.0.0.1:5900`)).toBe(true);
    }
    expect(re.test("websockify --web /x 0.0.0.0:6081 127.0.0.1:5900")).toBe(false);
  });
});
