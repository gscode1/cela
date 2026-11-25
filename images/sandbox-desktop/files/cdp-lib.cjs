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
// they repeat a link's name: then the link is the target already. Controls without a name are kept here (annotate and
// nameUnnamed give them words from their markup or row, or drop them); disabled ones are kept and marked, so a person sees
// the button that is not ready yet, and a click refuses it.
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
    if (role === "heading") {
      if (!name || linkNames.has(name)) continue;
    } else if (IMAGES.has(role)) {
      if (!name || linkNames.has(name) || inControl(n)) continue;
    } else if (extraRoles?.has(role)) {
      if (!name) continue;
    } else if (!CLICKABLE.has(role)) continue;
    const description = squash(value(n.description));
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
      disabled: props.disabled === true || undefined,
      required: props.required === true || undefined,
      // aria-invalid="false" comes as the token "false"; any other token (true, grammar, spelling) is a complaint
      invalid: props.invalid !== undefined && props.invalid !== false && props.invalid !== "false" ? true : undefined,
      readonly: props.readonly === true || undefined,
      // a slider's range (aria-valuemin/max, or a native range's min and max) and its value as the page words it
      min: role === "slider" && typeof props.valuemin === "number" ? props.valuemin : undefined,
      max: role === "slider" && typeof props.valuemax === "number" ? props.valuemax : undefined,
      vertical: role === "slider" && props.orientation === "vertical" ? true : undefined,
      valuetext: role === "slider" && squash(props.valuetext) && squash(props.valuetext) !== squash(value(n.value)) ? squash(props.valuetext) : undefined,
      description: description && description !== name ? description : undefined,
      url: typeof props.url === "string" ? props.url : undefined,
    });
  }
  return out;
}

const LETTER = /\p{L}/u;
const TOGGLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

// Facts about elements of one layout snapshot by backend node id: where a node is, its attributes, its <label>, and the
// words of its markup.
function snapIndex(snap) {
  const at = new Map();
  for (const doc of snap.documents ?? []) doc.nodes.backendNodeId?.forEach((id, i) => at.set(id, { doc, i }));
  // Elements with a layout box: one inside a display:none part (a template) has none, and is in no hidden set either.
  const boxed = new Set();
  for (const doc of snap.documents ?? []) for (const i of doc.layout?.nodeIndex ?? []) boxed.add(doc.nodes.backendNodeId[i]);
  const shown = (id, hidden) => boxed.has(id) && !hidden.has(id);
  const str = (i) => (i >= 0 ? snap.strings[i] : "");
  const tag = (doc, i) => str(doc.nodes.nodeName[i]).toUpperCase();
  const labelsFor = new Map();
  // The visible <label> of a form control: an ancestor label, else a label whose `for` names the control's id (pages repeat ids
  // in templates, so the first one a person can see).
  const labelOf = ({ doc, i }, hidden) => {
    for (let p = doc.nodes.parentIndex[i]; p >= 0; p = doc.nodes.parentIndex[p])
      if (tag(doc, p) === "LABEL" && shown(doc.nodes.backendNodeId[p], hidden)) return doc.nodes.backendNodeId[p];
    const id = nodeAttrs(snap, doc, i).id;
    if (!id) return undefined;
    if (!labelsFor.has(doc)) {
      const m = new Map();
      doc.nodes.nodeName.forEach((_, k) => {
        if (doc.nodes.nodeType[k] !== 1 || tag(doc, k) !== "LABEL") return;
        const f = nodeAttrs(snap, doc, k).for;
        if (f) m.set(f, [...(m.get(f) ?? []), doc.nodes.backendNodeId[k]]);
      });
      labelsFor.set(doc, m);
    }
    return (labelsFor.get(doc).get(id) ?? []).find((b) => shown(b, hidden));
  };
  // The element's own markup words and those of its first descendant that has any (an icon inside a button), a title first.
  const tokens = ({ doc, i }) => {
    const out = markTokens(snap, doc, i);
    const pi = doc.nodes.parentIndex;
    for (let k = i + 1; k < pi.length && k <= i + 30; k++) {
      let p = pi[k];
      while (p > i) p = pi[p];
      if (p !== i) break;
      if (doc.nodes.nodeType[k] !== 1) continue;
      const t = markTokens(snap, doc, k);
      if (t.length > 0) {
        for (const w of t) if (!out.includes(w)) out.push(w);
        break;
      }
    }
    return [...out.filter((w) => w.startsWith("title:")), ...out.filter((w) => !w.startsWith("title:"))].slice(0, 4);
  };
  const views = new Map();
  const view = (doc) => {
    if (!views.has(doc)) views.set(doc, docView(snap, doc));
    return views.get(doc);
  };
  return { find: (id) => at.get(id), attrs: ({ doc, i }) => nodeAttrs(snap, doc, i), labelOf, tokens, tag, view };
}

// The text a person reads as a field's label: text ending just left of the field on its height (words of the line before it,
// which may hold the field's own value too), or a short line just above it over its width, or one sitting on its top border (a
// floating label). The nearest wins, and a row's own label close by beats the line of the row above. Never text drawn inside
// the field (its value or a drawn placeholder). `lines` come from labelLines.
function nearestLabel(lines, doc, box) {
  let best;
  let bestGap = Infinity;
  const take = (text, gap) => {
    text = squash(text);
    if (gap < bestGap && text.length <= 60 && LETTER.test(text)) {
      best = text;
      bestGap = gap;
    }
  };
  for (const l of lines) {
    if (l.doc !== doc) continue;
    const left = l.pieces.filter((p) => p.box.x + p.box.w <= box.x + 2 && Math.min(p.box.y + p.box.h, box.y + box.h) - Math.max(p.box.y, box.y) >= 0.5 * Math.min(p.box.h, box.h));
    if (left.length > 0) {
      const gap = box.x - Math.max(...left.map((p) => p.box.x + p.box.w));
      if (gap <= 250) take(left.map((p) => p.text).join(" "), gap <= 60 ? gap - 1000 : gap);
    }
    const up = l.pieces.filter((p) => p.box.y + p.box.h / 2 <= box.y + 2 && Math.min(p.box.x + p.box.w, box.x + box.w) - Math.max(p.box.x, box.x) > 0);
    if (up.length > 0) {
      const gap = Math.max(box.y - Math.max(...up.map((p) => p.box.y + p.box.h)), 0);
      if (gap <= 40) take(up.map((p) => p.text).join(" "), gap);
    }
  }
  return best;
}

// The page's text lines as pieces of text with their boxes, for nearestLabel.
function labelLines(snap) {
  const out = [];
  for (const g of snapshotGroups(snap)) {
    const pieces = [];
    for (const t of g.texts) {
      const b = g.v.bounds(t);
      if (b) pieces.push({ text: g.v.str(g.doc.nodes.nodeValue[t]), box: b });
    }
    if (pieces.length > 0) out.push({ doc: g.doc, pieces });
  }
  return out;
}

// Entries of one part (its layout snapshot and the backend ids hidden in it) as a person meets them. A hidden element is left
// out, except a checkbox, radio or switch whose own <label> a person can see: custom controls keep the real input at opacity 0
// or 1 px and draw the box in the label, so that one is kept and clicked through its label (`via`); a hidden input without a
// visible label (a honeypot) stays out. A field gets its placeholder, and a control without a name in letters (an icon
// button, an icon font glyph) gets the words of its markup (`mark`).
// A control also gets what a person sees as part of it, which takes its click like the control itself: its visible <label>
// (`labelEl`) and its own box (`boxEl`), the highest ancestor at most three levels up that holds no other listed control (a
// filter row whose drawn check box, a sibling's ::before, sits over the real input). A field without a name in letters gets
// the text a person reads as its label (`label`), and a field in a form that shows no button to send it is marked (`noSubmit`).
function annotate(entries, snap, hidden) {
  const ix = snapIndex(snap);
  const kept = [];
  for (let e of entries) {
    const at = ix.find(e.backendNodeId);
    if (hidden.has(e.backendNodeId)) {
      if (!TOGGLES.has(e.role) || !at) continue;
      const label = ix.labelOf(at, hidden);
      if (label === undefined) continue;
      e = { ...e, via: label };
    }
    kept.push({ e, at });
  }
  // How many listed controls each element holds, by node: a box holds only its own.
  const holds = new Map();
  for (const { e, at } of kept) {
    if (!at || !CLICKABLE.has(e.role)) continue;
    const m = holds.get(at.doc) ?? new Map();
    holds.set(at.doc, m);
    for (let p = at.doc.nodes.parentIndex[at.i]; p >= 0; p = at.doc.nodes.parentIndex[p]) m.set(p, (m.get(p) ?? 0) + 1);
  }
  const formOf = ({ doc, i }) => {
    for (let p = doc.nodes.parentIndex[i]; p >= 0; p = doc.nodes.parentIndex[p]) if (ix.tag(doc, p) === "FORM") return `${p}`;
    return undefined;
  };
  // A button that sends its form: a <button> of type submit (its default) or a submit or image input; a <button type="button">
  // (swap the fields, clear one) does not, and an element only drawn as a button may run anything.
  const sends = ({ doc, i }) => {
    const type = (nodeAttrs(snap, doc, i).type ?? "").toLowerCase();
    const tag = ix.tag(doc, i);
    return tag === "BUTTON" ? type === "" || type === "submit" : tag === "INPUT" ? type === "submit" || type === "image" : true;
  };
  const buttoned = new Set(kept.filter(({ e, at }) => at && e.role === "button" && sends(at)).map(({ at }) => formOf(at)));
  let lines;
  const out = [];
  for (let { e, at } of kept) {
    if (at && CLICKABLE.has(e.role)) {
      const label = e.via ?? ix.labelOf(at, hidden);
      if (label !== undefined) e = { ...e, labelEl: label };
      const m = holds.get(at.doc);
      let box;
      for (let p = at.doc.nodes.parentIndex[at.i], k = 0; p >= 0 && k < 3; p = at.doc.nodes.parentIndex[p], k++) {
        if ((m?.get(p) ?? 0) > 1 || /^(BODY|HTML)$/.test(ix.tag(at.doc, p))) break;
        box = p;
      }
      if (box !== undefined) e = { ...e, boxEl: at.doc.nodes.backendNodeId[box] };
      if (FIELDS.has(e.role)) {
        const f = formOf(at);
        if (f !== undefined && !buttoned.has(f)) e = { ...e, noSubmit: true };
      }
      const a = ix.attrs(at);
      const ph = squash(a.placeholder);
      if (ph && ph !== e.name) e = { ...e, placeholder: clip(ph, 80) };
      if (a.type === "password") e = { ...e, secret: true };
      // a file input takes a file through the browser's file chooser, never typed text
      if (a.type === "file") e = { ...e, file: true };
      if (!LETTER.test(e.name)) {
        // a control clicked through its label is drawn by it: the label's words (its title) come first
        const t = e.via !== undefined ? [...ix.tokens(ix.find(e.via)), ...ix.tokens(at)].slice(0, 4) : ix.tokens(at);
        // the choice an unnamed radio or checkbox stands for (value="car"); "on" is the browser's default, not a choice
        if (/^(radio|checkbox)$/.test(a.type ?? "") && a.value && a.value !== "on" && a.value.length <= 24) t.unshift(`value=${a.value}`);
        if (t.length > 0) e = { ...e, mark: clip(t.join(" "), 40) };
        if ((FIELDS.has(e.role) || e.role === "slider") && !e.placeholder) {
          const b = ix.view(at.doc).bounds(at.i);
          lines ??= labelLines(snap);
          const l = b ? nearestLabel(lines, at.doc, b) : undefined;
          if (l) e = { ...e, label: clip(l, 60) };
        }
      }
    }
    out.push(e);
  }
  return out;
}

// A control without a name in letters and without a placeholder is told apart by the text of its row (`near`, as --near
// would match it). One that has neither markup words nor row text says nothing a person could use: it is dropped, as before,
// unless it is a field or a checkbox (those are typed into or ticked by ref).
function nameUnnamed(nodes, entries) {
  const unnamed = (e) => CLICKABLE.has(e.role) && !LETTER.test(e.name) && !e.placeholder;
  const want = new Set(entries.filter(unnamed));
  if (want.size === 0) return entries;
  const rows = rowTexts(nodes, entries, { max: 50, only: want });
  return entries
    .map((e, i) => (want.has(e) && /[\p{L}\p{N}]/u.test(rows[i] ?? "") ? { ...e, near: rows[i] } : e))
    .filter((e) => !unnamed(e) || e.name || e.mark || e.label || e.near || FIELDS.has(e.role) || e.role === "checkbox");
}

// What a name regex is tested against: the name and placeholder, and for a control without a name the text beside it, its
// markup words and its row.
const matchTexts = (e) => [e.name, e.placeholder, e.label, e.mark, e.near].filter(Boolean);

// Markup words are a last resort: a control with a label or a row text a person reads is shown by those.
const showMark = (e) => e.mark && !e.label && !e.near;

function entryLine(e, { nameMax = 120 } = {}) {
  let line = `[${e.ref}] ${e.role}${e.name || !showMark(e) ? ` "${clip(e.name, nameMax)}"` : ""}`;
  if (showMark(e)) line += ` ‹${e.mark}›`;
  if (e.placeholder) line += ` placeholder="${clip(e.placeholder, 60)}"`;
  // a row text that already starts with the label says it
  if (e.label && !e.near?.startsWith(e.label)) line += ` label "${e.label}"`;
  if (e.near) line += ` near "${e.near}"`;
  if (e.role === "slider") {
    // numbers, unquoted: what `type <slider> N` takes
    if (e.value) line += ` value=${e.value}`;
    if (e.valuetext) line += ` "${clip(e.valuetext, 30)}"`;
    if (e.min !== undefined) line += ` min=${e.min}`;
    if (e.max !== undefined) line += ` max=${e.max}`;
    if (e.vertical) line += " vertical";
  } else if (e.value) line += ` value="${clip(e.value, 60)}"`;
  if (e.checked !== undefined) line += ` checked=${e.checked}`;
  if (e.expanded !== undefined) line += ` expanded=${e.expanded}`;
  if (e.focused) line += " focused";
  if (e.required) line += " required";
  if (e.invalid) line += " invalid";
  if (e.readonly) line += " readonly";
  if (e.disabled) line += " disabled";
  if (e.description && e.description !== e.placeholder) line += ` desc="${clip(e.description, 80)}"`;
  if (e.options) line += ` options: ${optionsText(e.options)}`;
  if (e.file) line += " (file input: desktop-web upload)";
  return line;
}

// An element in a short line: its name, or the words of its markup when it has none.
const shortName = (e, n = 60) =>
  e.name ? `"${clip(e.name, n)}"` : e.label ? `label "${clip(e.label, n)}"` : e.near ? `near "${clip(e.near, n)}"` : e.mark ? `‹${e.mark}›` : '""';

// How an element's state differs between two reads: `checked false -> true`, `value "a" -> "b"`.
const STATE = ["checked", "expanded", "value", "name"];
function stateDiff(a, b) {
  if (!a || !b) return [];
  // checked and expanded are tokens (true, false, mixed); value and name are text
  const show = (k, v) => (k === "value" || k === "name" ? JSON.stringify(clip(String(v ?? ""), 40)) : String(v ?? "none"));
  return STATE.filter((k) => String(a[k] ?? "") !== String(b[k] ?? "")).map((k) => `${k} ${show(k, a[k])} -> ${show(k, b[k])}`);
}

// Controls on both reads whose state changed (another radio of the group, a panel's toggle), skipping `skip` (the one acted
// on, reported on its own): `[e5] checkbox "Name": checked false -> true`.
function controlDiffs(before, after, { skip } = {}) {
  const was = new Map(before.map((e) => [e.ref, e]));
  const out = [];
  for (const e of after) {
    if (e.ref === skip || e.role === "heading" || IMAGES.has(e.role)) continue;
    const d = stateDiff(was.get(e.ref), e);
    if (d.length > 0) out.push(`[${e.ref}] ${e.role} ${shortName(was.get(e.ref))}: ${d.join(", ")}`);
  }
  return out;
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
function rowTexts(nodes, candidates, { max = 200, only } = {}) {
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
    if (only && !only.has(c)) return "";
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
  let matches = entries.filter((e) => (CLICKABLE.has(e.role) || showable) && matchTexts(e).some((t) => re.test(t)) && (!role || e.role === role));
  if (matches.length === 0) return { none: true };
  const whole = new RegExp(`^(?:${re.source})$`, re.flags);
  const exact = matches.filter((e) => [e.name, e.placeholder, e.label].some((t) => t !== undefined && whole.test(t)));
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
// (screen-reader-only text, honeypot links, prompt injection). Struck-through text (an old price) reads ~637 zł~, and a line
// without letters (a bare count) gets the aria-label or title of the element around it: `94 ‹Upvote›`.
const STYLES = ["display", "visibility", "opacity", "position", "overflow-x", "overflow-y", "clip", "cursor", "text-decoration-line"];
const BLOCK = /^(block|flex|grid|list-item|table|table-row|table-caption|flow-root|inline-block|inline-flex|inline-grid)$/;
// Boxes that sit in a line of text like a word. One stays a line of its own (a card, a column) unless joinInline says it reads
// as part of the line around it.
const INLINE_BOX = /^inline-(block|flex|grid)$/;
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
  const display = (i) => style(i)?.[0] ?? "inline";
  return { str, style, display, bounds, visible, parent, layoutOf, seeThrough, offscreen, tiny };
}

// The inline boxes (inline-block, inline-flex and the items of an inline flex or grid) of a document whose text reads as part
// of the line around them: "Distance: <output>13km</output>." is one line. Decided from layout alone: all of the box's text
// sits on one visual line (no fragment of it wraps, and it holds no block of its own), and that line overlaps text of the
// same block outside the box. A card or a column built of inline-blocks spans several lines and stays apart.
function joinInline(doc, v) {
  const n = doc.nodes.parentIndex.length;
  const cand = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (doc.nodes.nodeType[i] !== 1 || !v.layoutOf.has(i)) continue;
    const p = v.parent[i];
    if (INLINE_BOX.test(v.display(i)) || (p >= 0 && cand[p] && /^inline-(flex|grid)$/.test(v.display(p)))) {
      cand[i] = 1;
      any = true;
    }
  }
  const out = new Set();
  if (!any) return out;
  // Text nodes whose fragments (one per line it takes) start at different heights: text that wraps.
  const wrapped = new Set();
  const tb = doc.textBoxes;
  if (tb?.layoutIndex) {
    const first = new Map();
    tb.layoutIndex.forEach((li, k) => {
      const [, y, , h] = tb.bounds[k];
      if (!first.has(li)) first.set(li, y);
      else if (Math.abs(first.get(li) - y) > 0.5 * h) wrapped.add(li);
    });
  }
  const bands = new Map(); // candidate -> { top, bottom, h, bad }
  const flows = new Map(); // nearest block that is no candidate -> its pieces of text
  const flowOf = new Map(); // candidate -> that block
  for (let t = 0; t < n; t++) {
    if (doc.nodes.nodeType[t] !== 3 || v.str(doc.nodes.nodeValue[t]).trim() === "") continue;
    const b = v.bounds(t);
    if (!b || v.tiny(b)) continue;
    let flow;
    const inside = [];
    for (let p = v.parent[t]; p > 0; p = v.parent[p]) {
      if (cand[p]) {
        const s = bands.get(p) ?? { top: Infinity, bottom: -Infinity, h: 0, bad: false };
        s.top = Math.min(s.top, b.y);
        s.bottom = Math.max(s.bottom, b.y + b.h);
        s.h = Math.max(s.h, b.h);
        if (flow !== undefined || wrapped.has(v.layoutOf.get(t))) s.bad = true;
        bands.set(p, s);
        inside.push(p);
      } else if (flow === undefined && BLOCK.test(v.display(p))) flow = p;
    }
    if (flow === undefined) continue;
    for (const p of inside) if (!flowOf.has(p)) flowOf.set(p, flow);
    if (!flows.has(flow)) flows.set(flow, []);
    flows.get(flow).push({ top: b.y, bottom: b.y + b.h, inside });
  }
  for (const [a, s] of bands) {
    const h = s.bottom - s.top;
    if (s.bad || h > 1.5 * s.h) continue;
    const meets = (flows.get(flowOf.get(a)) ?? []).some(
      (q) => Math.min(q.bottom, s.bottom) - Math.max(q.top, s.top) >= 0.5 * Math.min(q.bottom - q.top, h) && !q.inside.includes(a),
    );
    if (meets) out.add(a);
  }
  return out;
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
  // an inline data: image has no file name (its payload would read as one)
  const src = /^data:/i.test(a.src ?? "") ? undefined : (a.src ?? "").split(/[?#]/)[0]?.split("/").pop();
  if (src) out.push(`src:${clip(src, 24)}`);
  return out;
}

// Layout snapshot -> lines. With `marks`, a rendered element that has a box a person can see but no text and no accessible
// name of its own (an icon, a rating drawn from a class, an image without alt) is written into the line where it sits as
// `‹class words title data src›`, taken from its markup: meaning that is only a picture, as a last resort before a screenshot.
function snapshotLines(snap, { marks = false } = {}) {
  return snapshotGroups(snap, { marks }).map((g) => g.text);
}

// The lines of snapshotLines with where they come from: { text, doc, v (docView), block (node index), texts (text node
// indexes) }.
function snapshotGroups(snap, { marks = false } = {}) {
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
    const joined = joinInline(doc, v);
    const blockOf = (i) => {
      let p = v.parent[i];
      while (p > 0 && (!BLOCK.test(v.display(p)) || joined.has(p))) p = v.parent[p];
      return p;
    };
    // text-decoration is drawn through the descendants of the element that sets it, though no descendant computes it
    const struckAt = new Map();
    const struck = (i) => {
      if (i < 0) return false;
      if (!struckAt.has(i)) struckAt.set(i, /line-through/.test(v.style(i)?.[8] ?? "") || struck(v.parent[i]));
      return struckAt.get(i);
    };
    const groups = new Map();
    const group = (g) => {
      if (!groups.has(g)) groups.set(g, { text: "", box: undefined, brk: false, block: g, texts: [], struck: false, x: Infinity });
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
      const s = struck(i);
      if (g.struck && !s) g.text = g.text.replace(/\s*$/, (m) => `~${m}`);
      if (g.text !== "" && !/\s$/.test(g.text) && !/^\s/.test(raw) && (g.brk || apart(g.box, b) || s !== g.struck)) g.text += " ";
      g.text += s && !g.struck ? raw.replace(/^\s*/, (m) => `${m}~`) : raw;
      g.struck = s;
      g.box = b;
      g.brk = false;
      g.x = Math.min(g.x, b.x);
      g.texts.push(i);
    }
    for (const g of groups.values()) {
      let t = squash(g.struck ? g.text.replace(/\s*$/, "~") : g.text);
      if (t && !LETTER.test(t) && g.texts.length > 0) {
        const label = labelAround(snap, doc, v, g.texts[0]);
        if (label) t += ` ‹${clip(label, 40)}›`;
      }
      if (t) lines.push({ text: t, doc, v, block: g.block, texts: g.texts, x: Number.isFinite(g.x) ? g.x : 0 });
    }
  }
  return lines;
}

// The aria-label or title (in letters) of the nearest element around text node i that holds little more than the text: what
// a bare number stands for ("94" in a button named "Upvote"). A row or a toolbar named as a whole names no number in it.
function labelAround(snap, doc, v, i) {
  const t = v.bounds(i);
  if (!t) return undefined;
  for (let p = v.parent[i], k = 0; p > 0 && k < 6; p = v.parent[p], k++) {
    if (/^(BODY|HTML)$/i.test(v.str(doc.nodes.nodeName[p]))) return undefined;
    const b = v.bounds(p);
    if (b && (b.w > t.w + 120 || b.h > Math.max(3 * t.h, t.h + 40))) return undefined;
    const a = nodeAttrs(snap, doc, p);
    for (const l of [squash(a["aria-label"]), squash(a.title)]) if (b && LETTER.test(l)) return l;
  }
  return undefined;
}

// snapshotLines wrapped to `width`, with where each line is: `xs` (its left edge, px) and `at` (backend node id -> index of
// the first line holding the element's text), so a heading maps to its line by node, not by its words.
function snapshotText(snap, { marks = false, width = 200 } = {}) {
  const lines = [];
  const xs = [];
  const at = new Map();
  for (const g of snapshotGroups(snap, { marks })) {
    const first = lines.length;
    for (const l of wrapLines([g.text], width)) {
      lines.push(l);
      xs.push(g.x);
    }
    const ids = g.doc.nodes.backendNodeId;
    for (const t of g.texts) for (let p = g.v.parent[t]; p >= 0 && !at.has(ids[p]); p = g.v.parent[p]) at.set(ids[p], first);
  }
  return { lines, xs, at };
}

// Nesting levels from the lines' left edges: how many left edges that several lines share lie left of a line's. A thread's
// replies, a nested list: a level per step in, whatever its width in px. Columns side by side read as levels too.
function indentLevels(xs, { max = 12 } = {}) {
  const key = (x) => Math.round(x / 4);
  const count = new Map();
  for (const x of xs) count.set(key(x), (count.get(key(x)) ?? 0) + 1);
  const edges = [...count].filter(([, c]) => c >= 2).map(([k]) => k);
  return xs.map((x) => Math.min(edges.filter((e) => e < key(x)).length, max));
}

// Visible lines a click can act on although no element is named so (role-less options, filter rows, custom list items): text
// whose own element shows a pointer cursor (inherited from the clickable element around it), or that sits, within its line's
// block, in an element the snapshot marks clickable (it has a click listener). Each is { backendNodeId, name } of the text's
// own element, the box a click aims at. `skip` holds backend ids already listed: text inside one (a link's own text) is that
// element, and text whose element holds one (a label around its field) belongs to it; neither is another target. With `any`
// every visible line counts, clickable or not: what a drag picks up or drops on (a drop zone) needs no click listener.
function textTargets(snap, re, { skip = new Set(), any = false } = {}) {
  const out = [];
  const perDoc = new Map();
  for (const g of snapshotGroups(snap)) {
    if (!re.test(g.text)) continue;
    const { doc, v } = g;
    if (!perDoc.has(doc)) {
      const holds = new Set();
      doc.nodes.backendNodeId.forEach((id, i) => {
        if (skip.has(id)) for (let a = i; a >= 0 && !holds.has(a); a = v.parent[a]) holds.add(a);
      });
      perDoc.set(doc, { clickable: new Set(doc.nodes.isClickable?.index ?? []), holds });
    }
    const { clickable, holds } = perDoc.get(doc);
    let hit;
    let ok = false;
    // the piece that matches first: one line can hold several controls' words (buttons side by side)
    const own = (t) => re.test(squash(v.str(doc.nodes.nodeValue[t])));
    for (const t of [...g.texts.filter(own), ...g.texts.filter((t) => !own(t))]) {
      const p = v.parent[t];
      ok = /^(pointer|grab|move)$/.test(v.style(p)?.[7] ?? "");
      for (let a = p; !ok && a >= 0; a = v.parent[a]) {
        if (clickable.has(a)) ok = true;
        if (a === g.block) break;
      }
      if (ok || any) {
        hit = p;
        break;
      }
    }
    if (hit === undefined || holds.has(hit)) continue;
    let listed = false;
    for (let a = hit; a >= 0 && !listed; a = v.parent[a]) listed = skip.has(doc.nodes.backendNodeId[a]);
    if (!listed) out.push({ backendNodeId: doc.nodes.backendNodeId[hit], name: clip(g.text, 120), clickable: !any || ok });
  }
  return out;
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

// Whether the element shows a box: it has a layout box (a display:none element has none, and hiddenElements, which looks
// at boxes, does not list it) and is not visibility:hidden. An iframe without one is a tracker's, whatever its document draws.
function showsBox(snap, backendNodeId) {
  for (const doc of snap.documents ?? []) {
    const i = doc.nodes.backendNodeId?.indexOf(backendNodeId) ?? -1;
    if (i < 0) continue;
    const v = docView(snap, doc);
    return v.layoutOf.has(i) && v.style(i)?.[1] !== "hidden";
  }
  return false;
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

// Open dialogs in the accessibility tree (role dialog or alertdialog, or aria-modal) with the elements to act on in them, so a
// consent banner or a popup is reported in any site's language without knowing its words. `modal`: it holds the page back
// (aria-modal, a <dialog> shown as modal, or an alert dialog); a dialog that is not (a <dialog open>, a panel with the role)
// leaves the page usable.
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
    out.push({
      role,
      modal: modal || role === "alertdialog",
      name: squash(value(n.name)),
      backendNodeId: n.backendDOMNodeId,
      frameTag: n.frameTag,
      entries: entries.slice(0, max),
      more: Math.max(entries.length - max, 0),
    });
  }
  return out;
}

function dialogLines(ds) {
  const out = [];
  for (const d of ds) {
    out.push(`open ${d.role}${d.name ? ` "${clip(d.name, 80)}"` : ""} (${d.modal === false ? "not modal" : "act on it first"}):`);
    for (const e of d.entries) out.push(`  ${entryLine(e, { nameMax: 70 })}`);
    if (d.more) out.push(`  ... ${d.more} more: desktop-web snap`);
  }
  return out;
}

// Dialogs of `before` that `after` no longer has, as `dialog "Name"`: a consent banner that a click closed.
function closedDialogs(before, after) {
  const key = (d) => `${d.role}${d.name ? ` "${clip(d.name, 80)}"` : ""}`;
  const left = after.map(key);
  const out = [];
  for (const d of before) {
    const i = left.indexOf(key(d));
    if (i >= 0) left.splice(i, 1);
    else out.push(key(d));
  }
  return out;
}

// Text of alert and status regions (form errors, "3 results", "saved"), which an action's answer names as such.
function liveTexts(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out = [];
  for (const n of nodes) {
    const role = value(n.role);
    if (n.ignored || (role !== "alert" && role !== "status")) continue;
    let text = squash(value(n.name));
    if (!text) {
      const parts = [];
      const walk = (id) => {
        const m = byId.get(id);
        if (!m || parts.length > 40) return;
        if (!m.ignored && /^(StaticText|staticText)$/.test(value(m.role) ?? "")) parts.push(squash(value(m.name)));
        for (const c of m.childIds ?? []) walk(c);
      };
      for (const c of n.childIds ?? []) walk(c);
      text = squash(parts.join(" "));
    }
    if (text) out.push(`${role} "${clip(text, 150)}"`);
  }
  return out;
}

// The page's headings with the text line each starts at, in line order: an outline to aim a regex or --lines at. `lineOf`
// maps a heading's node to its line (snapshotText's `at`); a heading without a line there shows no text a person can see
// and is left out. Without `lineOf` a heading is found by its words.
function outline(nodes, lines, { max = 20, lineOf } = {}) {
  const out = [];
  for (const n of nodes) {
    if (n.ignored || value(n.role) !== "heading") continue;
    const name = squash(value(n.name));
    if (!name) continue;
    const level = (n.properties ?? []).find((p) => p.name === "level");
    const at = lineOf ? (lineOf(n) ?? -1) : lines.findIndex((l) => l.startsWith(name.slice(0, 40)));
    if (at >= 0) out.push({ at, text: `${at + 1}: ${"#".repeat(Number(value(level?.value) ?? 2))} ${clip(name, 100)}` });
  }
  return out
    .sort((a, b) => a.at - b.at)
    .slice(0, max)
    .map((h) => h.text);
}

// HTML entities as /json/list writes them into a page title: "Stripe&#39;s", "A &amp; B".
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
    const c = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : Number(e.slice(1));
    return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m;
  });
}

// Challenge providers whose widget a bot check shows in a frame of its own, known by the frame's URL. Providers only, never a
// site: the same check reads any site that uses one. reCAPTCHA's invisible badge (size=invisible) sits on ordinary pages.
const CHALLENGES = [
  ["Cloudflare challenge", (u) => u.hostname === "challenges.cloudflare.com"],
  ["hCaptcha", (u) => /(^|\.)hcaptcha\.com$/.test(u.hostname)],
  ["reCAPTCHA", (u) => /(^|\.)(google\.com|recaptcha\.net)$/.test(u.hostname) && u.pathname.startsWith("/recaptcha/") && !/[?&]size=invisible/.test(u.search)],
  ["DataDome", (u) => /(^|\.)captcha-delivery\.com$/.test(u.hostname)],
  ["HUMAN (PerimeterX)", (u) => /(^|\.)(px-cdn\.net|px-cloud\.net|perimeterx\.net|humansecurity\.com)$/.test(u.hostname)],
  ["Arkose", (u) => /(^|\.)(arkoselabs\.com|funcaptcha\.com)$/.test(u.hostname)],
];
// The challenge provider a frame's URL belongs to, or undefined.
function challengeOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  return CHALLENGES.find(([, test]) => test(u))?.[0];
}
// A bot check says little: a page this short (in lines) can be one; a longer one is a page with content. A site's error page
// keeps the site's menus and footer around its message, so it may be longer.
const SHORT_PAGE = 40;
const ERROR_PAGE = 150;
// An HTTP error status at the start or the end of a title's part or a heading: "404 - Shop", "Error 404", "x | 522: Connection
// timed out" (Cloudflare's own error pages run from 520 to 530). A number inside one ("SSD 500 GB") is a product's.
const CODE = "(40[0-8]|410|429|451|5[0-2]\\d|530)";
const STATUS = new RegExp(`^\\W*${CODE}(\\D|$)|(^|\\D)${CODE}\\W*$`);
// A line of the page that is a status and nothing else, or one word and the status ("Error 404"): a price ("404 zł") is not.
const STATUS_LINE = new RegExp(`^(\\p{L}+ )?${CODE}$`, "u");
// A title's parts: "Shop | 522: Connection timed out". A hyphen counts only between spaces ("Wi-Fi 500" is one part).
const TITLE_PARTS = /\s*[|:]\s*|\s+[-–—]\s+/;
const ORDINAL = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

// What the page is, beyond its text, as notices for an answer's header. `parts` are the page and its out-of-process frames
// as read: { snap, hidden (backend ids), url (a frame's target URL) }. Says when the page is Chrome's own error page, may be
// a site's error page (a status number at the edge of a title's part or an h1 to h3, or a line among the first that is only
// the status, of a page that is not long), looks like a bot check (a visible frame of a challenge provider on a short page),
// or shows a frame that has drawn nothing yet. There is no HTTP status: reading it would take Network.enable, which a page
// can detect. `sighting(host)` is how many times this session has met a bot check on the page's host, this time included:
// the first may be a one-off, the second is the site's answer.
function pageNotices(parts, { lines = [], title = "", sighting = () => 1 } = {}) {
  const out = [];
  const short = lines.length <= SHORT_PAGE;
  const str = (snap, i) => (i >= 0 ? snap.strings[i] : "");
  const main = parts[0]?.snap?.documents?.[0];
  const status = () =>
    squash(title).split(TITLE_PARTS).some((t) => STATUS.test(t)) ||
    headings(parts[0]).some((h) => STATUS.test(h)) ||
    lines.slice(0, SHORT_PAGE).some((l) => STATUS_LINE.test(squash(l)));
  if (main && /^chrome-error:/.test(str(parts[0].snap, main.documentURL)))
    out.push("Chrome error page: the page did not load (Chrome's reason is in its text)");
  else if (lines.length <= ERROR_PAGE && status()) out.push("may be an error page: a status number in the title, a heading or a line of its own");
  const frames = [];
  const loading = [];
  // a document that has drawn nothing: no text and no element with a box but its root
  const empty = (snap, doc) =>
    !(doc?.layout?.nodeIndex ?? []).some((ni, li) => {
      if (doc.nodes.nodeType[ni] === 3) return str(snap, doc.nodes.nodeValue[ni]).trim() !== "";
      const b = doc.layout.bounds[li];
      return doc.nodes.nodeType[ni] === 1 && !/^(HTML|HEAD|BODY)$/i.test(str(snap, doc.nodes.nodeName[ni])) && b[2] * b[3] >= 4;
    });
  for (const [k, part] of parts.entries()) {
    const { snap } = part;
    if (k > 0 && part.url) {
      frames.push(part.url);
      const doc = snap.documents?.[0];
      const html = doc?.layout?.bounds?.[0];
      // a frame that has laid out nothing at all is one a person cannot see either (a tracker's)
      if (html && html[2] >= 100 && html[3] >= 50 && empty(snap, doc)) loading.push(part.url);
    }
    for (const doc of snap.documents ?? []) {
      const v = docView(snap, doc);
      const inner = new Map((doc.nodes.contentDocumentIndex?.index ?? []).map((i, j) => [i, doc.nodes.contentDocumentIndex.value[j]]));
      for (const [i] of v.layoutOf) {
        if (doc.nodes.nodeType[i] !== 1 || !/^i?frame$/i.test(v.str(doc.nodes.nodeName[i]))) continue;
        const b = v.bounds(i);
        if (!b || v.tiny(b) || v.offscreen(b) || part.hidden?.has(doc.nodes.backendNodeId[i])) continue;
        const sub = inner.has(i) ? snap.documents[inner.get(i)] : undefined;
        let url = sub ? str(snap, sub.documentURL) : "";
        // a srcdoc or a frame not loaded yet: what it was asked to show
        if (!/^https?:/.test(url)) {
          try {
            url = new URL(nodeAttrs(snap, doc, i).src ?? "", str(snap, doc.documentURL)).href;
          } catch {
            url = "";
          }
        }
        if (url) frames.push(url);
        if (sub && b.w >= 100 && b.h >= 50 && empty(snap, sub)) loading.push(url || "about:blank");
      }
    }
  }
  const hit = short ? frames.map(challengeOf).find(Boolean) : undefined;
  if (hit) {
    let host = "";
    try {
      host = new URL(str(parts[0].snap, main?.documentURL)).host;
    } catch {
      // no host: counted as a first sight
    }
    const n = host ? sighting(host) : 1;
    out.push(
      n <= 1
        ? `looks like a bot check (${hit}): never click or solve it. It can be a one-off: open one ordinary page of the site (its home or section page), then this page once more.`
        : `bot check again (${hit}, ${ORDINAL(n)} time on ${host}): stop and report it. Do not retry, wait it out, or try other addresses or mirrors.`,
    );
  }
  if (loading.length > 0) {
    const host = (u) => {
      try {
        return new URL(u).host || u;
      } catch {
        return u;
      }
    };
    const hosts = [...new Set(loading.map(host))];
    out.push(`${loading.length === 1 ? "a frame is" : `${loading.length} frames are`} still loading (${hosts.slice(0, 3).join(", ")}): read again in a moment`);
  }
  return out;
}

// The texts of the visible h1, h2 and h3 of a part's main document, each cut at 200 characters.
function headings(part) {
  const doc = part?.snap?.documents?.[0];
  if (!doc) return [];
  const { snap } = part;
  const v = docView(snap, doc);
  const out = [];
  for (const [i] of v.layoutOf) {
    if (doc.nodes.nodeType[i] !== 1 || !/^H[1-3]$/.test(v.str(doc.nodes.nodeName[i]).toUpperCase()) || part.hidden?.has(doc.nodes.backendNodeId[i])) continue;
    let text = "";
    for (let k = i + 1; k < doc.nodes.parentIndex.length && text.length < 200; k++) {
      let p = doc.nodes.parentIndex[k];
      while (p > i) p = doc.nodes.parentIndex[p];
      if (p !== i) break;
      if (doc.nodes.nodeType[k] === 3) text += v.str(doc.nodes.nodeValue[k]);
    }
    out.push(squash(text));
  }
  return out;
}

// The accessibility node ids a combobox or list owns: its own subtree and the subtrees of the elements it names in
// aria-controls (a popup list drawn elsewhere in the page). A dropdown's options are looked for there first.
function ownedNodes(nodes, entry) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const own = new Set();
  const walk = (id) => {
    const n = byId.get(id);
    if (!n || own.has(id)) return;
    own.add(id);
    for (const c of n.childIds ?? []) walk(c);
  };
  const tag = entry.frameTag ?? "";
  const self = nodes.find((n) => n.backendDOMNodeId === entry.backendNodeId && (n.frameTag ?? "") === tag);
  if (!self) return own;
  walk(self.nodeId);
  const controls = (self.properties ?? []).find((p) => p.name === "controls")?.value?.relatedNodes ?? [];
  for (const r of controls) {
    const n = nodes.find((m) => m.backendDOMNodeId === r.backendDOMNodeId && (m.frameTag ?? "") === tag);
    if (n) walk(n.nodeId);
  }
  return own;
}

// Whether an entry sits inside a landmark of one of `roles` (banner, navigation): the page's header and menus.
function inLandmark(nodes, entry, roles) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  for (let n = byId.get(entry.nodeId); n; n = byId.get(n.parentId)) if (!n.ignored && roles.has(value(n.role))) return true;
  return false;
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

// The file inputs of layout snapshots, shown or not (a styled button often stands in for a hidden one), with the value each
// holds (the browser's "C:\\fakepath\\name" for a picked file, "" for none): { backendNodeId, value }.
function fileInputs(snaps) {
  const out = [];
  for (const snap of snaps)
    for (const doc of snap.documents ?? []) {
      const vals = new Map((doc.nodes.inputValue?.index ?? []).map((i, k) => [i, doc.nodes.inputValue.value[k]]));
      doc.nodes.nodeName.forEach((n, i) => {
        if (doc.nodes.nodeType[i] !== 1 || snap.strings[n]?.toUpperCase() !== "INPUT" || nodeAttrs(snap, doc, i).type?.toLowerCase() !== "file") return;
        const v = vals.get(i);
        out.push({ backendNodeId: doc.nodes.backendNodeId[i], value: v === undefined || v < 0 ? "" : snap.strings[v] });
      });
    }
  return out;
}

// Where a press sets a slider to `want`: the proportional point along its track `box` (screen px). The thumb's centre cannot
// reach the ends of a native range, so its travel is inset by half a thumb (about half the track's height); a few px off is
// corrected with the arrow keys afterwards. A vertical slider grows upwards.
function sliderPoint(box, { min, max, vertical = false }, want, { inset } = {}) {
  const f = max > min ? Math.min(Math.max((want - min) / (max - min), 0), 1) : 0;
  if (vertical) {
    const pad = inset ?? Math.min(box.w / 2, 10);
    return { x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h - pad - f * (box.h - 2 * pad)) };
  }
  const pad = inset ?? Math.min(box.h / 2, 10);
  return { x: Math.round(box.x + pad + f * (box.w - 2 * pad)), y: Math.round(box.y + box.h / 2) };
}

// Arrow presses from value `now` to `want` once a press is known to move the slider by `step` (undefined: not yet known,
// press once to learn it). Positive is up. 0 when the slider is as close as its steps allow.
function sliderPresses(now, want, step) {
  if (now === want) return 0;
  if (!step) return now < want ? 1 : -1;
  const n = Math.round((want - now) / step);
  return Math.max(Math.min(n, 200), -200) || 0; // never -0
}

// The track of a slider drawn as a thumb alone (role slider on a small knob): the nearest ancestor in the layout snapshot
// that is several thumbs long along the slider's axis and holds the thumb's centre. Undefined when the slider is its own
// track (a native range, or a wide element) or no such ancestor exists. Returns the ancestor's backend node id.
function sliderTrack(snap, backendNodeId, { vertical = false } = {}) {
  for (const doc of snap.documents ?? []) {
    const i = doc.nodes.backendNodeId.indexOf(backendNodeId);
    if (i < 0) continue;
    const v = docView(snap, doc);
    const b = v.bounds(i);
    if (!b) return undefined;
    const long = (x) => (vertical ? x.h : x.w);
    const across = (x) => (vertical ? x.w : x.h);
    if (long(b) >= 3 * Math.max(across(b), 1)) return undefined;
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    for (let a = v.parent[i]; a >= 0; a = v.parent[a]) {
      const ab = v.bounds(a);
      if (!ab) continue;
      if (/^(BODY|HTML)$/i.test(v.str(doc.nodes.nodeName[a]))) return undefined;
      const holds = cx >= ab.x - 1 && cx <= ab.x + ab.w + 1 && cy >= ab.y - b.h && cy <= ab.y + ab.h + b.h;
      if (holds && long(ab) >= 3 * long(b) && across(ab) <= 4 * Math.max(across(b), 8)) return doc.nodes.backendNodeId[a];
    }
    return undefined;
  }
  return undefined;
}

// All backend ids in a DOM.describeNode subtree, to tell whether the element under the click point is the target.
function subtreeIds(node, out = new Set()) {
  if (!node) return out;
  out.add(node.backendNodeId);
  for (const c of node.children ?? []) subtreeIds(c, out);
  for (const c of node.shadowRoots ?? []) subtreeIds(c, out);
  // ::before and ::after boxes are the element's own (a label's drawn check mark), and hit testing can return them
  for (const c of node.pseudoElements ?? []) subtreeIds(c, out);
  if (node.contentDocument) subtreeIds(node.contentDocument, out);
  return out;
}

module.exports = {
  ALLOWED,
  STYLES,
  fileInputs,
  sliderPoint,
  sliderPresses,
  sliderTrack,
  annotate,
  closedDialogs,
  controlDiffs,
  liveTexts,
  matchTexts,
  nameUnnamed,
  shortName,
  stateDiff,
  textTargets,
  dialogLines,
  dialogs,
  hiddenElements,
  showsBox,
  challengeOf,
  mainFirst,
  ownedNodes,
  inLandmark,
  childFrameIds,
  frameTag,
  iframeTargets,
  newLines,
  outline,
  decodeEntities,
  pageNotices,
  snapshotText,
  indentLevels,
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
