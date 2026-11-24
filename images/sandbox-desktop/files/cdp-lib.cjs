// Passive CDP reader for the desktop's Chromium (docs/decisions/0065-desktop-sandbox.md, "Chromium and desktop-web").
// Pages detect a driver through what it turns on, above all Runtime.enable, which every Playwright-style client sends and
// which leaves a trace the page can see even after the client leaves. This reader sends only the read-only methods in
// ALLOWED: the accessibility tree, a layout snapshot, element boxes and the window's geometry. It never enables a domain,
// never runs script in the page and never sends input: clicks and keys go through xdotool as real X events.
// Installed next to desktop-web in /usr/local/bin and loaded by path. No dependencies.
"use strict";

// Every method this reader may send. A test keeps desktop-web's calls inside this list.
const ALLOWED = new Set([
  "Accessibility.getFullAXTree",
  "Browser.getWindowForTarget",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getNodeForLocation",
  "DOM.scrollIntoViewIfNeeded",
  "DOMSnapshot.captureSnapshot",
  "Page.getLayoutMetrics",
]);

function assertAllowed(method) {
  if (!ALLOWED.has(method)) throw new Error(`desktop-web does not send ${method}: pages can detect it`);
}

// The page the user sees: /json/list puts the most recently active page target first.
async function pageTarget(port) {
  let list;
  try {
    list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return undefined;
  }
  // Chromium's own UI (the address bar's popup, new-tab page parts) is listed as pages under chrome:// and similar schemes.
  return list.find((t) => t.type === "page" && !/^(chrome|chrome-untrusted|chrome-extension|devtools|chrome-search):/.test(t.url));
}

// One short connection per command: attach, send, close.
async function connect(wsUrl, { timeoutMs = 20000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cannot connect to Chromium"));
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    const p = d.id !== undefined ? pending.get(d.id) : undefined;
    if (!p) return;
    pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.error) p.reject(new Error(d.error.message));
    else p.resolve(d.result);
  };
  const send = (method, params = {}) => {
    assertAllowed(method);
    return new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => {
        pending.delete(i);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      pending.set(i, { resolve, reject, timer });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  };
  return { send, close: () => ws.close() };
}

const CLICKABLE = new Set([
  "link",
  "button",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "treeitem",
  "combobox",
  "textbox",
  "searchbox",
  "spinbutton",
  "slider",
  "listbox",
]);
const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton"]);
const value = (p) => (p && p.value !== undefined ? p.value : undefined);
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Accessibility tree -> the elements an agent acts on, plus named headings, each with a ref (e + backend DOM node id,
// which stays valid until the element leaves the page). Headings that repeat a link's name (product cards) are dropped.
function axEntries(nodes) {
  const live = nodes.filter((n) => !n.ignored);
  const linkNames = new Set(live.filter((n) => value(n.role) === "link").map((n) => squash(value(n.name))));
  const out = [];
  for (const n of live) {
    if (!n.backendDOMNodeId) continue;
    const role = value(n.role);
    const name = squash(value(n.name));
    const props = Object.fromEntries((n.properties ?? []).map((p) => [p.name, value(p.value)]));
    if (props.disabled === true) continue;
    if (role === "heading") {
      if (!name || linkNames.has(name)) continue;
    } else if (!CLICKABLE.has(role) || (!name && !FIELDS.has(role) && role !== "checkbox")) continue;
    out.push({
      ref: `e${n.backendDOMNodeId}`,
      backendNodeId: n.backendDOMNodeId,
      nodeId: n.nodeId,
      role,
      name,
      value: squash(value(n.value)),
      checked: props.checked,
      expanded: props.expanded,
      focused: props.focused === true,
      url: typeof props.url === "string" ? props.url : undefined,
    });
  }
  return out;
}

function entryLine(e, { nameMax = 120 } = {}) {
  let line = `[${e.ref}] ${e.role} "${clip(e.name, nameMax)}"`;
  if (e.value) line += ` value="${clip(e.value, 60)}"`;
  if (e.checked !== undefined) line += ` checked=${e.checked}`;
  if (e.expanded !== undefined) line += ` expanded=${e.expanded}`;
  if (e.focused) line += " focused";
  return line;
}

// The text of the row each candidate sits in: its highest ancestor that holds no other candidate (a product card, a table
// row, a flight). Used to tell same-named links apart (--near) and to show them.
function rowTexts(nodes, candidates, { max = 200 } = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const chain = (id) => {
    const out = [];
    for (let n = byId.get(id); n && n.parentId !== undefined; n = byId.get(n.parentId)) out.push(n.parentId);
    return out;
  };
  const chains = candidates.map((c) => chain(c.nodeId));
  const count = new Map();
  for (const ch of chains) for (const a of new Set(ch)) count.set(a, (count.get(a) ?? 0) + 1);
  const textOf = (id) => {
    const parts = [];
    let size = 0;
    const walk = (nid) => {
      const n = byId.get(nid);
      if (!n || size > max * 2) return;
      const role = value(n.role);
      if (!n.ignored && (role === "StaticText" || role === "staticText")) {
        const t = squash(value(n.name));
        if (t) {
          parts.push(t);
          size += t.length + 1;
        }
      }
      for (const c of n.childIds ?? []) walk(c);
    };
    walk(id);
    return clip(parts.join(" "), max);
  };
  return candidates.map((c, i) => {
    let row = c.nodeId;
    for (const a of chains[i]) {
      if ((count.get(a) ?? 0) > 1) break;
      row = a;
    }
    return textOf(row);
  });
}

// Picks what a click by name means. Returns { pick } or { several } (entries with their row text) or { none }.
// Matches with one URL count as one (an image link and a title link to the same product); --near picks by row text.
// An element named exactly like the pattern wins ("Zgadzam się" over "Nie zgadzam się"); links win over buttons whose
// names repeat them ("Add to compare <product>"); --role narrows to one role.
function chooseTarget(nodes, entries, re, { near, nth, role } = {}) {
  let matches = entries.filter((e) => CLICKABLE.has(e.role) && re.test(e.name) && (!role || e.role === role));
  if (matches.length === 0) return { none: true };
  const exact = matches.filter((e) => new RegExp(`^(?:${re.source})$`, re.flags).test(e.name));
  if (exact.length > 0) matches = exact;
  else if (!role && matches.some((e) => e.role === "link")) matches = matches.filter((e) => e.role === "link");
  const rows = rowTexts(nodes, matches);
  let withRows = matches.map((e, i) => ({ ...e, row: rows[i] }));
  if (near) {
    const nearRe = near instanceof RegExp ? near : new RegExp(near, "i");
    withRows = withRows.filter((e) => nearRe.test(e.row) || nearRe.test(e.name));
    if (withRows.length === 0) return { none: true, near: true };
  }
  const distinct = [];
  const seen = new Set();
  for (const e of withRows) {
    const k = e.url ? `url:${e.url}` : `ref:${e.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    distinct.push(e);
  }
  if (nth !== undefined) return distinct[nth - 1] ? { pick: distinct[nth - 1] } : { none: true };
  if (distinct.length === 1) return { pick: distinct[0] };
  matches = distinct;
  return { several: matches };
}

// Layout snapshot -> lines of visible text, one per block-level element, so a price split into "145" ",95" "zł" reads
// "145,95 zł". Needs captureSnapshot with computedStyles ["display", "visibility"].
const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|inline-block|inline-flex|inline-grid)$/;
function snapshotLines(snap) {
  const lines = [];
  for (const doc of snap.documents ?? []) {
    const str = (i) => (i >= 0 ? snap.strings[i] : "");
    const style = new Map();
    doc.layout.nodeIndex.forEach((ni, li) => style.set(ni, doc.layout.styles[li].map(str)));
    const parent = doc.nodes.parentIndex;
    const blockOf = (i) => {
      let p = parent[i];
      while (p > 0 && !BLOCK.test(style.get(p)?.[0] ?? "inline")) p = parent[p];
      return p;
    };
    const groups = new Map();
    doc.nodes.nodeValue.forEach((v, i) => {
      if (doc.nodes.nodeType[i] !== 3 || !style.has(i)) return;
      if (style.get(i)?.[1] === "hidden") return;
      const g = blockOf(i);
      groups.set(g, (groups.get(g) ?? "") + str(v));
    });
    for (const t of groups.values()) {
      const s = squash(t);
      if (s) lines.push(s);
    }
  }
  return lines;
}

// CSS viewport point -> X screen point. The window's X geometry (xdotool) has a frame of `frame` px on the left, right and
// bottom (openbox); everything between the window top and the viewport is title bar, toolbar and info bars, so the
// viewport's top is the window's bottom edge minus the frame minus the viewport height. Calibrated on Chromium 156/openbox.
function screenPoint({ win, viewport, zoom = 1, frame = 4 }, css) {
  return {
    x: Math.round(win.x + frame + css.x * zoom),
    y: Math.round(win.y + (win.height - frame - viewport.height * zoom) + css.y * zoom),
  };
}

function quadCenter(q) {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

// Whether box `outer` contains box `inner` (2 px slack) and is at most four times its area: a wrapper of the element.
function wraps(outer, inner) {
  const b = (q) => ({ l: Math.min(q[0], q[6]), t: Math.min(q[1], q[3]), r: Math.max(q[2], q[4]), btm: Math.max(q[5], q[7]) });
  const o = b(outer);
  const i = b(inner);
  const area = (r) => Math.max(r.r - r.l, 0) * Math.max(r.btm - r.t, 0);
  const contains = o.l <= i.l + 2 && o.t <= i.t + 2 && o.r >= i.r - 2 && o.btm >= i.btm - 2;
  return contains && area(o) <= 4 * Math.max(area(i), 1);
}

// All backend ids in a DOM.describeNode subtree, to tell whether the element under the click point is the target.
function subtreeIds(node, out = new Set()) {
  if (!node) return out;
  out.add(node.backendNodeId);
  for (const c of node.children ?? []) subtreeIds(c, out);
  for (const c of node.shadowRoots ?? []) subtreeIds(c, out);
  if (node.contentDocument) subtreeIds(node.contentDocument, out);
  return out;
}

module.exports = {
  ALLOWED,
  assertAllowed,
  axEntries,
  chooseTarget,
  connect,
  entryLine,
  pageTarget,
  quadCenter,
  rowTexts,
  screenPoint,
  snapshotLines,
  subtreeIds,
  wraps,
};
