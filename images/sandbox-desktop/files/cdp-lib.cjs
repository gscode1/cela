// Passive CDP reader for the desktop's Chrome (docs/decisions/0065-desktop-sandbox.md, "Chromium and desktop-web").
// Pages detect a driver through what it turns on, above all Runtime.enable, which every Playwright-style client sends and
// which leaves a trace the page can see even after the client leaves. This reader sends only the read-only methods in
// ALLOWED: the accessibility tree, a layout snapshot, the frame tree and element boxes. It never enables a domain,
// never runs script in the page and never sends input: clicks and keys go through xdotool as real X events.
// Installed next to desktop-web in /usr/local/bin and loaded by path. No dependencies.
"use strict";

// Every method this reader may send. A test keeps desktop-web's calls inside this list.
const ALLOWED = new Set([
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  // The iframe element that owns a frame, to place a frame's boxes inside the page. Reads the DOM, enables nothing.
  "DOM.getFrameOwner",
  "DOM.getNodeForLocation",
  "DOM.scrollIntoViewIfNeeded",
  "DOMSnapshot.captureSnapshot",
  // The ids of a page's frames, to read each frame's accessibility tree. Reads, enables nothing and runs nothing in the page.
  "Page.getFrameTree",
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
  // Chrome's own UI (the address bar's popup, new-tab page parts) is listed as pages under chrome:// and similar schemes.
  return list.find((t) => t.type === "page" && !/^(chrome|chrome-untrusted|chrome-extension|devtools|chrome-search):/.test(t.url));
}

// Every target Chrome lists (pages, and iframes that live in another process).
async function targetList(port) {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return [];
  }
}

// Frames of another site run in their own process and are separate targets of type "iframe" whose parentId is the target
// holding them (the page, or another such frame). Breadth first from the page, at most `max` (ad-heavy pages have dozens).
// `tag` is a short name for refs and for telling frames apart.
const frameTag = (id) => String(id).slice(0, 4).toUpperCase();
function iframeTargets(list, pageId, { max = 10 } = {}) {
  const known = new Set([pageId]);
  const out = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of list) {
      if (t.type !== "iframe" || !t.webSocketDebuggerUrl || known.has(t.id) || !known.has(t.parentId) || out.length >= max) continue;
      known.add(t.id);
      out.push({ id: t.id, parentId: t.parentId, tag: frameTag(t.id), url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl });
      grew = true;
    }
  }
  return out;
}

// Ids of the frames below the root of a Page.getFrameTree answer (same-process ones; an out-of-process frame is a target).
function childFrameIds(tree) {
  const out = [];
  const walk = (n) => {
    for (const c of n.childFrames ?? []) {
      out.push(c.frame.id);
      walk(c);
    }
  };
  walk(tree);
  return out;
}

// Accessibility nodes of one frame, made unique among the page's: node ids get `prefix`, and `frameTag` says which process
// (which backend node id space) the element is in.
function prefixNodes(nodes, prefix, tag) {
  const p = (id) => (id === undefined ? id : `${prefix}${id}`);
  return nodes.map((n) => ({ ...n, nodeId: p(n.nodeId), parentId: p(n.parentId), childIds: n.childIds?.map(p), frameTag: tag }));
}

const shiftQuad = (q, dx, dy) => q.map((v, i) => v + (i % 2 === 0 ? dx : dy));
const quadOrigin = (q) => ({ x: Math.min(q[0], q[2], q[4], q[6]), y: Math.min(q[1], q[3], q[5], q[7]) });

// How far the layout viewport falls short of the real one: a horizontal scrollbar (any thickness, any zoom) takes the bottom
// of the window's page area, but clientHeight leaves it out, and the viewport's top is found from its full height. Hit
// testing covers the whole page area, scrollbar included, so the first point below clientHeight that hits nothing is the
// bottom. `hits(y)` says whether a point at y lands on any node.
async function scrollbarThickness(hits, client, { max = 40 } = {}) {
  const first = Math.ceil(client);
  if (!(await hits(first))) return 0;
  let lo = first; // hits
  let hi = first + max; // assumed not to
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hits(mid)) lo = mid;
    else hi = mid;
  }
  return hi - client;
}

// One short connection per command: attach, send, close.
async function connect(wsUrl, { timeoutMs = 20000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("cannot connect to Chrome"));
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
const IMAGES = new Set(["image", "img", "figure"]);
const FIELDS = new Set(["textbox", "searchbox", "combobox", "spinbutton", "listbox"]);
const value = (p) => (p && p.value !== undefined ? p.value : undefined);
const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// Accessibility tree -> the elements an agent acts on, plus named headings, each with a ref (e + backend DOM node id,
// which stays valid until the element leaves the page; "@TAG" after it names an out-of-process iframe). Headings that repeat a link's name (product cards) are dropped.
// Named pictures are listed too (hover and shot aim at them, a ref can click one), unless a link or button holds them or
// they repeat a link's name: then the link is the target already.
function axEntries(nodes, { extraRoles } = {}) {
  const live = nodes.filter((n) => !n.ignored);
  const linkNames = new Set(live.filter((n) => value(n.role) === "link").map((n) => squash(value(n.name))));
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const inControl = (n) => {
    for (let p = byId.get(n.parentId); p; p = byId.get(p.parentId)) if (CLICKABLE.has(value(p.role))) return true;
    return false;
  };
  const out = [];
  for (const n of live) {
    if (!n.backendDOMNodeId) continue;
    const role = value(n.role);
    const name = squash(value(n.name));
    const props = Object.fromEntries((n.properties ?? []).map((p) => [p.name, value(p.value)]));
    if (props.disabled === true) continue;
    if (role === "heading") {
      if (!name || linkNames.has(name)) continue;
    } else if (IMAGES.has(role)) {
      if (!name || linkNames.has(name) || inControl(n)) continue;
    } else if (extraRoles?.has(role)) {
      if (!name) continue;
    } else if (!CLICKABLE.has(role) || (!name && !FIELDS.has(role) && role !== "checkbox")) continue;
    out.push({
      ref: `e${n.backendDOMNodeId}${n.frameTag ? `@${n.frameTag}` : ""}`,
      frameTag: n.frameTag,
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
  if (e.options) line += ` options: ${optionsText(e.options)}`;
  return line;
}

// A select's options on one line: "A | B | C (disabled)", cut to a few and said so. Truncated by
// count and characters, never silently: "(+N more)".
function optionsText(options, { maxItems = 12, maxChars = 220 } = {}) {
  const parts = [];
  let size = 0;
  for (const o of options) {
    const t = `${clip(o.text, 40)}${o.disabled ? " (disabled)" : ""}`;
    if (parts.length >= maxItems || size + t.length > maxChars) break;
    parts.push(t);
    size += t.length + 3;
  }
  const more = options.length - parts.length;
  return `${parts.join(" | ")}${more > 0 ? ` | (+${more} more)` : ""}`;
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
// An element named exactly like the pattern wins ("Accept" over "Do not accept"); a button whose name contains a matching
// link's name loses to that link; --role narrows to one role.
function chooseTarget(nodes, entries, re, { near, nth, role, showable = false } = {}) {
  let matches = entries.filter((e) => (CLICKABLE.has(e.role) || showable) && re.test(e.name) && (!role || e.role === role));
  if (matches.length === 0) return { none: true };
  const exact = matches.filter((e) => new RegExp(`^(?:${re.source})$`, re.flags).test(e.name));
  if (exact.length > 0) matches = exact;
  else if (!role) {
    // A button whose name repeats a matching link's ("Add <product> to cart" next to the "<product>" link) is the
    // link's companion: drop it. Any other button stays, so a real choice is listed, never decided silently.
    const linkNames = matches.filter((e) => e.role === "link" && e.name).map((e) => e.name.toLowerCase());
    if (linkNames.length > 0)
      matches = matches.filter((e) => e.role !== "button" || !linkNames.some((n) => e.name.toLowerCase().includes(n)));
  }
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
    // Only links collapse by URL (an image link and a title link to one product); same-source pictures stay apart.
    const k = e.url && e.role === "link" ? `url:${e.url}` : `ref:${e.ref}`;
    if (seen.has(k)) continue;
    seen.add(k);
    distinct.push(e);
  }
  if (nth !== undefined) return distinct[nth - 1] ? { pick: distinct[nth - 1] } : { none: true };
  if (distinct.length === 1) return { pick: distinct[0] };
  matches = distinct;
  return { several: matches };
}

// Attributes of a DOMSnapshot node as a name -> value map.
function nodeAttrs(snap, doc, i) {
  const a = doc.nodes.attributes?.[i] ?? [];
  const out = {};
  for (let k = 0; k + 1 < a.length; k += 2) out[snap.strings[a[k]]] = a[k + 1] >= 0 ? snap.strings[a[k + 1]] : "";
  return out;
}

// The native <select> elements of a layout snapshot, by backend node id: whether a list is shown (multiple, or size above
// 1) and the options with their text, selected state and whether a person can pick them (not disabled, not hidden, not in a
// disabled group). Options of a closed select have no box, but the snapshot lists them as nodes all the same.
function selectInfos(snap) {
  const out = new Map();
  for (const doc of snap.documents ?? []) {
    const str = (i) => (i >= 0 ? snap.strings[i] : "");
    const n = doc.nodes;
    const kids = new Map();
    n.parentIndex.forEach((p, i) => {
      if (p >= 0) kids.set(p, [...(kids.get(p) ?? []), i]);
    });
    const selected = new Set(n.optionSelected?.index ?? []);
    const textOf = (i) => {
      if (n.nodeType[i] === 3) return str(n.nodeValue[i]);
      return (kids.get(i) ?? []).map(textOf).join("");
    };
    n.nodeName.forEach((nameIdx, i) => {
      if (n.nodeType[i] !== 1 || str(nameIdx).toUpperCase() !== "SELECT") return;
      const a = nodeAttrs(snap, doc, i);
      const options = [];
      const walk = (j, off) => {
        for (const k of kids.get(j) ?? []) {
          if (n.nodeType[k] !== 1) continue;
          const tag = str(n.nodeName[k]).toUpperCase();
          const at = nodeAttrs(snap, doc, k);
          if (tag === "OPTGROUP") walk(k, off || at.disabled !== undefined);
          else if (tag === "OPTION") {
            const text = squash(at.label || textOf(k));
            options.push({ text, selected: selected.has(k), disabled: off || at.disabled !== undefined || at.hidden !== undefined });
          }
        }
      };
      walk(i, false);
      const size = Number(a.size);
      out.set(n.backendNodeId[i], { multiple: a.multiple !== undefined, size: Number.isFinite(size) ? size : 0, options });
    });
  }
  return out;
}

// Which of `texts` a person means by `query`: the one that equals it, else the one that equals it ignoring case, else the one
// the query matches as a regular expression. Returns { index } for one, { several: [index...] } when a step matches more than
// one (nothing is chosen for the person), or { none }.
function matchOption(texts, query) {
  const q = squash(query);
  let re;
  try {
    re = new RegExp(query, "i");
  } catch {
    re = undefined;
  }
  const tiers = [(t) => t === q, (t) => t.toLowerCase() === q.toLowerCase(), (t) => re?.test(t) === true];
  for (const tier of tiers) {
    const hits = texts.map((t, i) => (tier(squash(t)) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return { index: hits[0] };
    if (hits.length > 1) return { several: hits };
  }
  return { none: true };
}

// Arrow presses from the selected option to option `target` in an open single-select popup: only options a person can pick
// count, since the keyboard skips the others. Negative is Up.
function arrowSteps(options, target) {
  const live = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  const cur = options.findIndex((o) => o.selected);
  const from = live.indexOf(cur >= 0 ? cur : (live[0] ?? 0));
  const to = live.indexOf(target);
  return to - from;
}

// A progress bar or an element marked busy in the accessibility tree: the page is still working on something.
function busy(nodes) {
  return nodes.some(
    (n) => !n.ignored && (value(n.role) === "progressbar" || (n.properties ?? []).some((p) => p.name === "busy" && value(p.value) === true)),
  );
}

// Layout snapshot -> lines of visible text, one per block-level element (a price split into "145" ",95" "zł" reads
// "145,95 zł"). Needs captureSnapshot with computedStyles STYLES. Within a block, pieces of text are joined the way a PDF
// text extractor does it, from layout alone: a space where the source has none but the boxes sit on different lines, stand
// apart by more than a sliver, or have a replaced or void element (br, img, input...) between them; no space where they
// touch. Text a person cannot see is left out: no box or a box under 2 px², entirely left of or above the page, visibility
// hidden, under an ancestor with opacity 0, or cut away by an ancestor's overflow hidden/clip or its own clip rect
// (screen-reader-only text, honeypot links, prompt injection).
const STYLES = ["display", "visibility", "opacity", "position", "overflow-x", "overflow-y", "clip"];
const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|inline-block|inline-flex|inline-grid)$/;
const VOID = new Set(["BR", "IMG", "INPUT", "SELECT", "TEXTAREA", "HR", "SVG", "VIDEO", "CANVAS", "IFRAME", "OBJECT", "EMBED"]);

// Per-document helpers over a DOMSnapshot document: style, bounds, effective visibility.
function docView(snap, doc) {
  const str = (i) => (i >= 0 ? snap.strings[i] : "");
  const nodeName = doc.nodes.nodeName;
  const layoutOf = new Map();
  doc.layout.nodeIndex.forEach((ni, li) => layoutOf.set(ni, li));
  const style = (i) => {
    const li = layoutOf.get(i);
    return li === undefined ? undefined : doc.layout.styles[li].map(str);
  };
  const bounds = (i) => {
    const li = layoutOf.get(i);
    const b = li === undefined ? undefined : doc.layout.bounds?.[li];
    return b ? { x: b[0], y: b[1], w: b[2], h: b[3] } : undefined;
  };
  const parent = doc.nodes.parentIndex;
  const transparent = new Map();
  const seeThrough = (i) => {
    if (i < 0) return false;
    if (transparent.has(i)) return transparent.get(i);
    const v = style(i)?.[2] === "0" || seeThrough(parent[i]);
    transparent.set(i, v);
    return v;
  };
  const offscreen = (b) => b.x + b.w <= 0 || b.y + b.h <= 0;
  const tiny = (b) => b.w * b.h < 2;
  const meet = (a, b) => {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    return { x, y, w: Math.max(Math.min(a.x + a.w, b.x + b.w) - x, 0), h: Math.max(Math.min(a.y + a.h, b.y + b.h) - y, 0) };
  };
  // The part of node i's box a person can see: what is left after the overflow-hidden boxes it sits in (until a fixed
  // position leaves them; an absolute one leaves those before its containing block) and its own `clip: rect(...)`.
  // Scrollable boxes (auto, scroll) do not cut: their content is one scroll away. body and html clip nothing.
  const visible = (i) => {
    let box = bounds(i);
    if (!box) return undefined;
    let escaping = false;
    for (let cur = i, a = parent[i]; a >= 0; cur = a, a = parent[a]) {
      const cs = style(cur);
      const rect = /^rect\(([^)]*)\)$/.exec(cs?.[6] ?? "");
      const own = bounds(cur);
      if (rect && own) {
        const [t, r, bt, l] = rect[1].split(/[ ,]+/).map(parseFloat);
        if ([t, r, bt, l].every(Number.isFinite)) box = meet(box, { x: own.x + l, y: own.y + t, w: r - l, h: bt - t });
      }
      if (cs?.[3] === "fixed") break;
      if (cs?.[3] === "absolute") escaping = true;
      const as = style(a);
      const ab = bounds(a);
      if (!as || !ab) continue;
      if (escaping) {
        if (as[3] === "static") continue;
        escaping = false;
      }
      const tag = str(nodeName[a]).toUpperCase();
      if (tag === "BODY" || tag === "HTML") continue;
      if (/^(hidden|clip)$/.test(as[4]) || /^(hidden|clip)$/.test(as[5])) box = meet(box, ab);
    }
    return box;
  };
  return { str, style, bounds, visible, parent, layoutOf, seeThrough, offscreen, tiny };
}

// Elements that stand for themselves or carry a name of their own: never marked as a nameless picture.
const NO_MARK = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "NOSCRIPT", "BR", "HR", "WBR", "OPTION", "OPTGROUP", "TEMPLATE"]);
const RICH = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "IFRAME", "VIDEO", "AUDIO", "CANVAS", "OBJECT", "EMBED"]);
const MAX_MARKS = 200;

// What a person would call a nameless element from its markup alone: a few class words, title, data-* values and the file
// name of its image. Generated class names (a run of letters and digits) say nothing and are left out.
function markTokens(snap, doc, i) {
  const a = nodeAttrs(snap, doc, i);
  const out = [];
  for (const c of (a.class ?? "").split(/\s+/)) {
    if (c.length < 2 || c.length > 32 || (c.match(/\d/g) ?? []).length >= 3) continue;
    if (out.length < 3) out.push(c);
  }
  if (a.title) out.push(`title:"${clip(squash(a.title), 30)}"`);
  let data = 0;
  for (const [k, v] of Object.entries(a)) {
    if (!k.startsWith("data-") || !v || v.length > 24 || data >= 2) continue;
    out.push(`${k.slice(5)}=${v}`);
    data++;
  }
  const src = (a.src ?? "").split(/[?#]/)[0]?.split("/").pop();
  if (src && !src.startsWith("data:")) out.push(`src:${clip(src, 24)}`);
  return out;
}

// Layout snapshot -> lines. With `marks`, a rendered element that has a box a person can see but no text and no accessible
// name of its own (an icon, a rating drawn from a class, an image without alt) is written into the line where it sits as
// `‹class words title data src›`, taken from its markup: meaning that is only a picture, as a last resort before a screenshot.
function snapshotLines(snap, { marks = false } = {}) {
  const lines = [];
  let marked = 0;
  for (const doc of snap.documents ?? []) {
    const v = docView(snap, doc);
    // Elements whose subtree holds text or a control: not nameless pictures.
    const content = new Set();
    const covered = new Set();
    if (marks) {
      for (let i = 0; i < doc.nodes.parentIndex.length; i++) {
        const isText = doc.nodes.nodeType[i] === 3 && v.str(doc.nodes.nodeValue[i]).trim() !== "";
        const rich = doc.nodes.nodeType[i] === 1 && RICH.has(v.str(doc.nodes.nodeName[i]).toUpperCase());
        if (isText || rich) for (let p = doc.nodes.parentIndex[i]; p >= 0 && !content.has(p); p = doc.nodes.parentIndex[p]) content.add(p);
      }
    }
    const name = (i) => v.str(doc.nodes.nodeName[i]).toUpperCase();
    const blockOf = (i) => {
      let p = v.parent[i];
      while (p > 0 && !BLOCK.test(v.style(p)?.[0] ?? "inline")) p = v.parent[p];
      return p;
    };
    const groups = new Map();
    const group = (g) => {
      if (!groups.has(g)) groups.set(g, { text: "", box: undefined, brk: false });
      return groups.get(g);
    };
    for (let i = 0; i < doc.nodes.parentIndex.length; i++) {
      if (!v.layoutOf.has(i)) continue;
      if (doc.nodes.nodeType[i] === 1) {
        if (VOID.has(name(i)) && groups.has(blockOf(i))) groups.get(blockOf(i)).brk = true;
        if (marks && v.parent[i] >= 0 && covered.has(v.parent[i])) covered.add(i);
        else if (marks && marked < MAX_MARKS && !content.has(i) && !NO_MARK.has(name(i)) && !RICH.has(name(i))) {
          const b = v.bounds(i);
          const shown = v.visible(i);
          const at = nodeAttrs(snap, doc, i);
          const named = (at["aria-label"] ?? at.alt ?? "").trim() !== "";
          if (b && shown && shown.w >= 4 && shown.h >= 4 && (Math.min(b.w, b.h) <= 120 || name(i) === "IMG" || name(i) === "SVG") && !named && !v.offscreen(b) && v.style(i)?.[1] !== "hidden" && !v.seeThrough(i)) {
            // The element's own words, else those of its first descendant that has any.
            let tokens = markTokens(snap, doc, i);
            const below = (j) => {
              for (let k = j + 1; k < doc.nodes.parentIndex.length && tokens.length === 0; k++) {
                let inside = false;
                for (let p = k; p >= 0; p = doc.nodes.parentIndex[p]) if (p === i) inside = true;
                if (!inside) break;
                if (doc.nodes.nodeType[k] === 1) tokens = markTokens(snap, doc, k);
              }
            };
            below(i);
            covered.add(i);
            if (tokens.length > 0) {
              marked++;
              const text = `‹${clip(tokens.join(" "), 60)}›`;
              const own = /^(block|flex|grid|list-item|table|flow-root)$/.test(v.style(i)?.[0] ?? "inline");
              const g = group(own ? i : blockOf(i));
              if (g.text !== "" && !/\s$/.test(g.text)) g.text += " ";
              g.text += text;
              g.box = b;
              g.brk = true;
            }
          }
        }
        continue;
      }
      if (doc.nodes.nodeType[i] !== 3) continue;
      const b = v.bounds(i);
      const shown = v.visible(i);
      if (!b || v.tiny(shown) || v.offscreen(b) || v.style(i)?.[1] === "hidden" || v.seeThrough(i)) continue;
      const raw = v.str(doc.nodes.nodeValue[i]);
      if (raw.trim() === "") {
        const g0 = groups.get(blockOf(i));
        if (g0 && g0.text !== "") g0.text += " ";
        continue;
      }
      const g = group(blockOf(i));
      if (g.text !== "" && !/\s$/.test(g.text) && !/^\s/.test(raw) && (g.brk || apart(g.box, b))) g.text += " ";
      g.text += raw;
      g.box = b;
      g.brk = false;
    }
    for (const g of groups.values()) {
      const t = squash(g.text);
      if (t) lines.push(t);
    }
  }
  return lines;
}

// Two consecutive text boxes of one block read as separate words: on different lines, or a visible gap between them.
function apart(a, b) {
  if (!a) return false;
  const h = Math.max(Math.min(a.h, b.h), 1);
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (overlap < 0.5 * h) return true;
  return b.x - (a.x + a.w) > 0.15 * h;
}

// Backend ids of elements a person cannot see (no visible box in their subtree, left of or above the page, or under
// opacity 0), so snap and click leave them out like the text above.
function hiddenElements(snap) {
  const hidden = new Set();
  for (const doc of snap.documents ?? []) {
    const v = docView(snap, doc);
    const seen = new Set();
    for (const [i] of v.layoutOf) {
      const b = v.bounds(i);
      if (!b || v.tiny(v.visible(i)) || v.offscreen(b) || v.seeThrough(i)) continue;
      for (let p = i; p >= 0 && !seen.has(p); p = v.parent[p]) seen.add(p);
    }
    for (const [i] of v.layoutOf) {
      if (doc.nodes.nodeType[i] !== 1) continue;
      const b = v.bounds(i);
      const gone = !seen.has(i) || (b && v.offscreen(b)) || v.seeThrough(i);
      if (gone && doc.nodes.backendNodeId) hidden.add(doc.nodes.backendNodeId[i]);
    }
  }
  return hidden;
}

// Long blocks become several numbered lines instead of one clipped line, so every part of a page can be read.
function wrapLines(lines, width = 200) {
  const out = [];
  for (const l of lines) {
    if (l.length <= width) {
      out.push(l);
      continue;
    }
    let rest = l;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut < width / 2) cut = width;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

// Lines of `after` that `before` did not have, in order, once each: what an action changed on the page.
function newLines(before, after) {
  const had = new Set(before);
  const out = [];
  const seen = new Set();
  for (const l of after) {
    if (had.has(l) || seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

// Open modal dialogs in the accessibility tree (role dialog or alertdialog, or aria-modal) with the elements to act on in
// them, so a consent banner or a popup is reported in any site's language without knowing its words.
function dialogs(nodes, { max = 8 } = {}) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out = [];
  for (const n of nodes) {
    if (n.ignored) continue;
    const role = value(n.role);
    const modal = (n.properties ?? []).some((p) => p.name === "modal" && value(p.value) === true);
    if (role !== "dialog" && role !== "alertdialog" && !modal) continue;
    const sub = [];
    const walk = (id) => {
      const m = byId.get(id);
      if (!m) return;
      sub.push(m);
      for (const c of m.childIds ?? []) walk(c);
    };
    for (const c of n.childIds ?? []) walk(c);
    const entries = axEntries(sub).filter((e) => e.role !== "heading" && !IMAGES.has(e.role));
    out.push({ role, name: squash(value(n.name)), entries: entries.slice(0, max), more: Math.max(entries.length - max, 0) });
  }
  return out;
}

function dialogLines(ds) {
  const out = [];
  for (const d of ds) {
    out.push(`open ${d.role}${d.name ? ` "${clip(d.name, 80)}"` : ""} (act on it first):`);
    for (const e of d.entries) out.push(`  ${entryLine(e, { nameMax: 70 })}`);
    if (d.more) out.push(`  ... ${d.more} more: desktop-web snap`);
  }
  return out;
}

// The page's headings with the text line each starts at, an outline to aim a regex at.
function outline(nodes, lines, { max = 20 } = {}) {
  const out = [];
  for (const n of nodes) {
    if (n.ignored || value(n.role) !== "heading") continue;
    const name = squash(value(n.name));
    if (!name) continue;
    const level = (n.properties ?? []).find((p) => p.name === "level");
    const at = lines.findIndex((l) => l.startsWith(name.slice(0, 40)));
    out.push(`${at >= 0 ? `${at + 1}:` : "-:"} ${"#".repeat(Number(value(level?.value) ?? 2))} ${clip(name, 100)}`);
    if (out.length >= max) break;
  }
  return out;
}

// Entries inside the main landmark first (header and navigation come before the content in document order).
function mainFirst(nodes, entries) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const inMain = new Set();
  const walk = (id) => {
    const m = byId.get(id);
    if (!m || inMain.has(id)) return;
    inMain.add(id);
    for (const c of m.childIds ?? []) walk(c);
  };
  for (const n of nodes) if (!n.ignored && value(n.role) === "main") walk(n.nodeId);
  if (inMain.size === 0) return entries;
  return [...entries.filter((e) => inMain.has(e.nodeId)), ...entries.filter((e) => !inMain.has(e.nodeId))];
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
  STYLES,
  dialogLines,
  dialogs,
  hiddenElements,
  mainFirst,
  childFrameIds,
  frameTag,
  iframeTargets,
  newLines,
  outline,
  wrapLines,
  assertAllowed,
  axEntries,
  chooseTarget,
  connect,
  entryLine,
  pageTarget,
  prefixNodes,
  quadCenter,
  quadOrigin,
  scrollbarThickness,
  shiftQuad,
  targetList,
  rowTexts,
  screenPoint,
  arrowSteps,
  busy,
  matchOption,
  optionsText,
  selectInfos,
  snapshotLines,
  subtreeIds,
  wraps,
};
