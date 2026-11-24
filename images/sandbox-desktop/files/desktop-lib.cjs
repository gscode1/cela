// Shared code for the desktop helpers (desktop-find, desktop-page, desktop-web). Installed next to them in /usr/local/bin and
// loaded by path, so the helpers stay single files with no package. No dependencies. Nothing here knows any site or app: it
// drives agent-desktop, xdotool and xclip the same way every time (docs/decisions/0065-desktop-sandbox.md).
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const BIG = 512 * 1024 * 1024;

function failer(name) {
  return (message, code = 1) => {
    process.stderr.write(`${name}: ${message}\n`);
    process.exit(code);
  };
}

function sessionDir() {
  return process.env.AGENT_DESKTOP_SESSION_DIR ?? path.join(process.env.HOME ?? os.homedir(), ".agent-desktop-session");
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// agent-desktop exits non-zero with its error envelope on stdout; that envelope is the answer, not an exception.
function desktop(args) {
  try {
    return execFileSync("agent-desktop-run", args, { encoding: "utf8", maxBuffer: BIG });
  } catch (e) {
    if (typeof e.stdout === "string" && e.stdout.trim() !== "") return e.stdout;
    return JSON.stringify({ ok: false, error: { code: "EXEC", message: String(e.stderr || e.message).trim().split("\n")[0].slice(0, 160) } });
  }
}

function envelope(text) {
  const start = text.indexOf("{");
  try {
    return JSON.parse(start < 0 ? text : text.slice(start));
  } catch {
    return { ok: false, error: { code: "NOT_JSON", message: text.slice(0, 120).replace(/\s+/g, " ") } };
  }
}

// stderr is dropped: X errors from a window that closed mid-call and xclip's "target STRING not available" on an empty
// clipboard would otherwise land in the agent's results.
const exec = (...args) =>
  execFileSync("agent-desktop-run", ["--exec", ...args], { encoding: "utf8", maxBuffer: BIG, stdio: ["ignore", "pipe", "ignore"] });
const key = (...keys) => exec("xdotool", "key", "--clearmodifiers", ...keys);
// xdotool type fails on some non-ASCII characters (seen: a non-breaking hyphen); callers pass what it can type.
// "--" ends xdotool's options: text that starts with "-" (a burst of "upload-me") is typed, not read as an option.
const type = (text) => exec("xdotool", "type", "--delay", "2", "--", text);

// Input that reads as a person's to behaviour scoring: keys in small bursts at a typing pace, the pointer travelling to a
// point near (not exactly at) the target's centre in a few steps, a short dwell before the press and a held button.
const rand = (a, b) => a + Math.random() * (b - a);
function humanType(text) {
  for (let i = 0; i < text.length; ) {
    const n = Math.min(text.length - i, 1 + Math.floor(rand(0, 4)));
    exec("xdotool", "type", "--delay", String(Math.round(rand(35, 90))), "--", text.slice(i, i + n));
    i += n;
    if (Math.random() < 0.15) pause(rand(80, 260));
  }
}

function pointer() {
  try {
    const g = Object.fromEntries(exec("xdotool", "getmouselocation", "--shell").trim().split("\n").map((l) => l.split("=")));
    return { x: Number(g.X), y: Number(g.Y) };
  } catch {
    return { x: 640, y: 400 };
  }
}

// box: { x, y, w, h } on screen. Aims inside the middle third of the box. The pointer travels there in a few steps (a hover
// is this alone, with a dwell for the page's own hover handling); a click presses and releases after a short dwell.
function humanMove(box) {
  const tx = Math.round(box.x + box.w / 2 + rand(-1, 1) * Math.min(box.w / 6, 12));
  const ty = Math.round(box.y + box.h / 2 + rand(-1, 1) * Math.min(box.h / 6, 4));
  const from = pointer();
  const steps = 3 + Math.floor(rand(0, 3));
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    const ease = f * f * (3 - 2 * f);
    const jx = k < steps ? rand(-3, 3) : 0;
    const jy = k < steps ? rand(-3, 3) : 0;
    exec("xdotool", "mousemove", String(Math.round(from.x + (tx - from.x) * ease + jx)), String(Math.round(from.y + (ty - from.y) * ease + jy)));
    pause(rand(12, 30));
  }
  return { x: tx, y: ty };
}

function humanPress() {
  pause(rand(60, 160));
  exec("xdotool", "mousedown", "1");
  pause(rand(50, 110));
  exec("xdotool", "mouseup", "1");
}

function humanClick(box) {
  const at = humanMove(box);
  humanPress();
  return at;
}

// A drag as a person makes one: the pointer travels to the source, presses, holds a moment, leaves the press point by a few
// px (browsers start a drag only past a small threshold), travels in eased steps with a slight wobble, then dwells over the
// target with a small jiggle (drop targets react to movement over them: dragover fires on motion) and releases there.
// from: a box on screen; to: a point on screen. Returns where it pressed and released.
// `to` may be { by: { dx, dy } }: that far from where the press lands.
function humanDrag(from, to) {
  const start = humanMove(from);
  if (to.by) to = { x: start.x + to.by.dx, y: start.y + to.by.dy };
  pause(rand(80, 160));
  exec("xdotool", "mousedown", "1");
  pause(rand(120, 220));
  const dx = to.x - start.x;
  const dy = to.y - start.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nudge = (k) => ({ x: Math.round(start.x + (dx / dist) * k), y: Math.round(start.y + (dy / dist) * k) });
  for (const k of [3, 7]) {
    const p = nudge(k);
    exec("xdotool", "mousemove", String(p.x), String(p.y));
    pause(rand(30, 60));
  }
  const steps = Math.min(Math.max(Math.round(dist / 25), 12), 40);
  for (let k = 1; k <= steps; k++) {
    const f = k / steps;
    const ease = f * f * (3 - 2 * f);
    const w = k < steps ? 2 : 0;
    exec("xdotool", "mousemove", String(Math.round(start.x + dx * ease + rand(-w, w))), String(Math.round(start.y + dy * ease + rand(-w, w))));
    pause(rand(14, 30));
  }
  for (let j = 0; j < 3; j++) {
    pause(rand(60, 120));
    exec("xdotool", "mousemove", String(Math.round(to.x + rand(-3, 3))), String(Math.round(to.y + rand(-3, 3))));
  }
  exec("xdotool", "mousemove", String(to.x), String(to.y));
  pause(rand(150, 260));
  exec("xdotool", "mouseup", "1");
  return { from: start, to };
}

// One key pressed `n` times at a person's pace (a held arrow key repeats about this fast).
function keyRepeat(name, n) {
  if (n <= 0) return;
  exec("xdotool", "key", "--clearmodifiers", "--delay", String(Math.round(rand(55, 85))), ...Array(Math.min(n, 200)).fill(name));
}

// Which of the browser's top-level windows are its dialogs (a file chooser, a save-as dialog): a dialog window transient
// for another, unlike the browser window itself and unlike a dropdown's popup. wins: [{ id, name, transientFor, type }].
function dialogWindows(wins) {
  return wins.filter((w) => w.transientFor && /_NET_WM_WINDOW_TYPE_DIALOG/.test(w.type ?? ""));
}

// Text xdotool cannot type reliably (anything outside printable ASCII) goes in through the clipboard and ctrl+v; the
// agent's clipboard is put back afterwards.
function pasteText(text) {
  const saved = readClipboard();
  writeClipboard(text);
  pause(100);
  key("ctrl+v");
  pause(150);
  writeClipboard(saved);
}
const typable = (text) => /^[\x20-\x7e]*$/.test(text);

function readClipboard() {
  try {
    return exec("xclip", "-o", "-selection", "clipboard");
  } catch {
    return "";
  }
}

// xclip -i forks a child that owns the selection until another program takes it. With a piped stdout execFileSync would wait
// for that child forever, so only stdin is a pipe (closed once the text is written).
function writeClipboard(text) {
  try {
    execFileSync("agent-desktop-run", ["--exec", "xclip", "-selection", "clipboard", "-i"], {
      input: text,
      stdio: ["pipe", "ignore", "ignore"],
      timeout: 10_000,
    });
  } catch {
    // The clipboard is a courtesy to the agent's own copy and paste; a failure here must not fail the read.
  }
}

function cleanLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, " ").trim();
    if (l !== "" || (out.length > 0 && out.at(-1) !== "")) out.push(l);
  }
  while (out.at(-1) === "") out.pop();
  return out;
}

// Copies the text of whatever has focus (an editor, a document): ctrl+a and ctrl+c, then the agent's clipboard is put back.
// The selection stays until the next click or keystroke in the app. Returns the cleaned lines.
function copyFocused() {
  const saved = readClipboard();
  writeClipboard("");
  key("ctrl+a");
  pause(200);
  key("ctrl+c");
  pause(500);
  const text = readClipboard();
  writeClipboard(saved);
  return cleanLines(text);
}

const clip = (s, n) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Matching lines with their neighbours, numbered as in the saved file: "12: hit", "11- context", "--" between groups.
function grepLines(lines, re, { limit = 25, context = 1, width = 200 } = {}) {
  const out = [];
  const hits = [];
  for (const [i, l] of lines.entries()) if (re.test(l)) hits.push(i);
  const isHit = new Set(hits);
  const shown = new Set();
  let last = -2;
  for (const h of hits.slice(0, limit)) {
    const from = Math.max(0, h - context);
    const to = Math.min(lines.length - 1, h + context);
    if (from > last + 1 && shown.size > 0) out.push("--");
    for (let i = from; i <= to; i++) {
      if (shown.has(i) || lines[i] === "") continue;
      shown.add(i);
      out.push(`${i + 1}${isHit.has(i) ? ":" : "-"} ${clip(lines[i], width)}`);
    }
    last = to;
  }
  if (hits.length > limit) out.push(`${hits.length - limit} more matches, narrow the regex or raise --limit`);
  if (hits.length === 0) out.push(`no match among ${lines.length} lines`);
  return out;
}

// The page text, one line per line, for grepping it again later (desktop-web text, desktop-page --from).
function savePage(lines, file) {
  const target = file ?? path.join(sessionDir(), "last-page.txt");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${lines.join("\n")}\n`);
  return target;
}

// Roles an unscoped find is split into when it fails: what an agent acts on or navigates by. Every find walks the whole
// tree (about 7 s on a large page, and agent-desktop serialises parallel ones), so the list stays short; plain text is
// desktop-page's job.
const FALLBACK_ROLES = ["heading", "link", "button", "textfield", "combobox", "checkbox"];

// agent-desktop find over roles. One element without a stable identity or bounds (offscreen, lazily rendered) makes a whole
// find fail with STALE_REF, so a failing role is skipped and named, and a failing unscoped find is retried role by role.
// Returns { matches, skipped, truncated, answered, splitRoles }.
// deadline (ms since epoch): roles not yet searched when it passes are skipped and named, so a caller stays under the agent's
// tool time limit.
function findAcross({ app, roles = [], literal, root, timeout = "60000", fallbackRoles = FALLBACK_ROLES, deadline }) {
  const matches = [];
  const skipped = [];
  let truncated = false;
  let answered = 0;
  let splitRoles = false;
  const collect = (role) => {
    if (deadline !== undefined && Date.now() > deadline) {
      skipped.push(`${role ?? "all roles"} (out of time)`);
      return false;
    }
    const args = ["find"];
    if (app) args.push("--app", app);
    if (role) args.push("--role", role);
    if (literal) args.push("--text", literal);
    if (root) args.push("--root", root);
    // No cap: a page has thousands of links, and a capped answer would drop the one asked for before the regex sees it.
    args.push("--limit", "0", "--timeout-ms", timeout);
    const env = envelope(desktop(args));
    if (env.ok === false || !Array.isArray(env.data?.matches)) {
      skipped.push(`${role ?? "all roles"} (${env.error?.code ?? "ERROR"})`);
      return false;
    }
    answered++;
    matches.push(...env.data.matches);
    truncated ||= env.data.truncated === true;
    return true;
  };
  if (roles.length > 0) for (const role of roles) collect(role);
  else if (!collect(undefined)) {
    skipped.length = 0;
    splitRoles = true;
    for (const role of fallbackRoles) collect(role);
  }
  return { matches, skipped, truncated, answered, splitRoles };
}

// A plain word or phrase every match of the pattern must contain, for agent-desktop's --text (a case-insensitive substring
// match), so the find returns only candidates: the pattern itself when it has no regex syntax, otherwise its longest literal
// run when nothing makes that run optional (no alternation, ?, * or {).
function literalOf(pattern) {
  if (pattern === undefined) return undefined;
  if (!/[\\^$.*+?()[\]{}|]/.test(pattern)) return pattern;
  if (/[|?*{]/.test(pattern)) return undefined;
  const runs = pattern
    .replace(/\\./g, "\u0000")
    .replace(/\[[^\]]*\]/g, "\u0000")
    .split(/[\u0000\\^$.*+?()[\]{}|]/)
    .map((r) => r.trim())
    .filter((r) => r.length >= 3);
  return runs.sort((a, b) => b.length - a.length)[0];
}

// Chrome draws a JS alert, confirm, prompt and leave-page dialog itself, and its accessibility tree (AT-SPI) answers while the
// page is blocked: a node with role dialog (the title is its name, the message its description) with buttons and, for a
// prompt, a text field. `tree` is the root of an agent-desktop snapshot; returns undefined when it holds no dialog.
function atspiDialog(tree) {
  const find = (n) => {
    if (!n) return undefined;
    if (n.role === "dialog" || n.role === "alert") return n;
    for (const c of n.children ?? []) {
      const d = find(c);
      if (d) return d;
    }
    return undefined;
  };
  const dlg = find(tree);
  if (!dlg) return undefined;
  const buttons = [];
  const fields = [];
  const texts = [];
  const walk = (n) => {
    if (n.role === "button" && n.name) buttons.push({ name: n.name, focused: (n.states ?? []).includes("focused") });
    else if (/^(textfield|textbox|entry|text|combobox)$/.test(n.role ?? "")) fields.push(n.value ?? n.name ?? "");
    else if (n.role === "statictext" && n.name) texts.push(n.name);
    for (const c of n.children ?? []) walk(c);
  };
  walk(dlg);
  return { title: dlg.name ?? "", message: dlg.description ?? texts.join(" "), buttons, fields };
}

module.exports = {
  atspiDialog,
  FALLBACK_ROLES,
  clip,
  cleanLines,
  copyFocused,
  desktop,
  dialogWindows,
  envelope,
  exec,
  failer,
  findAcross,
  grepLines,
  humanClick,
  humanDrag,
  humanMove,
  humanPress,
  humanType,
  key,
  keyRepeat,
  literalOf,
  pasteText,
  pause,
  readClipboard,
  savePage,
  sessionDir,
  type,
  typable,
  writeClipboard,
};
