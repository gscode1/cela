// Shared code for the desktop helpers (desktop-find, desktop-page, desktop-click, desktop-open). Installed next to them in
// /usr/local/bin and loaded by path, so the helpers stay single files with no package. No dependencies. Nothing here knows any
// site: it drives agent-desktop, xdotool and xclip the same way for every page (docs/decisions/0065-desktop-sandbox.md).
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
const type = (text) => exec("xdotool", "type", "--delay", "2", text);

function windowTitle() {
  try {
    return exec("xdotool", "getactivewindow", "getwindowname").trim().replace(/ [—-] Mozilla Firefox$/u, "");
  } catch {
    return "";
  }
}

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

// Reads the browser page without the accessibility tree: ctrl+l and ctrl+c copy the URL, Escape restores the address bar, F6
// moves focus into the page, ctrl+a and ctrl+c copy its text. Ends with focus in the page and the agent's clipboard put back.
// focused: copy from whatever has focus (an editor), no URL. The page stays selected until the next click on it.
function copyPage({ focused = false } = {}) {
  const saved = readClipboard();
  let url = "";
  if (!focused) {
    writeClipboard("");
    key("ctrl+l");
    pause(200);
    key("ctrl+c");
    pause(250);
    url = readClipboard().trim();
    key("Escape");
    key("F6");
    pause(300);
  }
  writeClipboard("");
  key("ctrl+a");
  pause(200);
  key("ctrl+c");
  pause(500);
  const text = readClipboard();
  writeClipboard(saved);
  return { url, title: windowTitle(), lines: cleanLines(text) };
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
function findAcross({ app, roles = [], literal, root, timeout = "60000" }) {
  const matches = [];
  const skipped = [];
  let truncated = false;
  let answered = 0;
  let splitRoles = false;
  const collect = (role) => {
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
    for (const role of FALLBACK_ROLES) collect(role);
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

const HIDDEN = new Set(["offscreen", "hidden"]);
const isHidden = (n) => (n.states ?? []).some((s) => HIDDEN.has(s));

function nodeLine(n, nameMax = 80) {
  const name = clip(n.name || n.description || "", nameMax);
  const states = (n.states ?? []).filter((s) => !HIDDEN.has(s));
  const parts = [n.ref_id, n.role ?? "node"];
  if (name) parts.push(`"${name.replace(/"/g, "'")}"`);
  if (n.value !== undefined && n.value !== null && n.value !== "") parts.push(`=${clip(n.value, 60)}`);
  if (states.length > 0) parts.push(`[${states.join(",")}]`);
  return parts.join(" ");
}

// Waits for the page to answer an action by watching the window title, which costs no tree walk. Returns when the title has
// changed and held for 600 ms, or when it has not changed within quietMs (an in-page update, which this cannot see), at
// most capMs. Returns the final title.
function settle(before, { quietMs = 2000, capMs = 8000 } = {}) {
  const start = Date.now();
  let current = before;
  let changedAt;
  while (Date.now() - start < capMs) {
    pause(200);
    const t = windowTitle();
    if (t !== current) {
      current = t;
      changedAt = Date.now();
    }
    if (changedAt === undefined && Date.now() - start >= quietMs) break;
    if (changedAt !== undefined && Date.now() - changedAt >= 600) break;
  }
  return current;
}

module.exports = {
  FALLBACK_ROLES,
  clip,
  cleanLines,
  copyPage,
  desktop,
  envelope,
  exec,
  failer,
  findAcross,
  grepLines,
  isHidden,
  key,
  literalOf,
  nodeLine,
  pause,
  readClipboard,
  savePage,
  sessionDir,
  settle,
  type,
  windowTitle,
  writeClipboard,
};
