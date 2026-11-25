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
  // a table's header cell: annotate keeps one only when it shows it sorts or takes clicks (a sortable column)
  "columnheader",
  // not an accessibility role: an element of another role that a person reaches with Tab (a slider's handle drawn as a
  // span), named so by axEntries and kept by annotate only for tabindex>=0 in its markup
  "focusable",
]);
// Nodes that are focusable but never a target: the page and its frames.
const NOT_TARGETS = new Set(["RootWebArea", "WebArea", "Iframe", "IframePresentational"]);
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
// the button that is not ready yet, and a click refuses it. Every named column header is kept here; annotate drops those
// that do not sort or take clicks, and names a duplicate by the header above it.
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
    let role = value(n.role);
    const name = squash(value(n.name));
    const props = Object.fromEntries((n.properties ?? []).map((p) => [p.name, value(p.value)]));
    if (role === "heading") {
      if (!name || linkNames.has(name)) continue;
    } else if (IMAGES.has(role)) {
      if (!name || linkNames.has(name) || inControl(n)) continue;
    } else if (extraRoles?.has(role)) {
      if (!name) continue;
    } else if (role === "columnheader") {
      if (!name) continue;
    } else if (!CLICKABLE.has(role)) {
      // a role-less element a person reaches with Tab: listed as "focusable" (annotate checks its tabindex)
      if (props.focusable !== true || NOT_TARGETS.has(role) || inControl(n)) continue;
      role = "focusable";
    }
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
      // a tab, an option or a row picked (aria-selected), a toggle button's state (aria-pressed: true, false or mixed)
      selected: props.selected,
      pressed: props.pressed,
      // what a click opens (aria-haspopup: menu, listbox, dialog...): a closed menu may hold what a search did not find
      hasPopup: props.hasPopup !== undefined && props.hasPopup !== false && props.hasPopup !== "false" ? String(props.hasPopup) : undefined,
      focusable: role === "columnheader" && props.focusable === true ? true : undefined,
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
  // Hidden only by opacity 0: a box of at least 8 px a person can click, not cut away, not visibility:hidden, on the page.
  const clearBox = ({ doc, i }) => {
    const v = view(doc);
    const b = v.bounds(i);
    const seen = v.visible(i);
    return !!b && !!seen && v.seeThrough(i) && v.style(i)?.[1] !== "hidden" && !v.offscreen(b) && seen.w >= 8 && seen.h >= 8;
  };
  return { find: (id) => at.get(id), attrs: ({ doc, i }) => nodeAttrs(snap, doc, i), labelOf, tokens, tag, view, clearBox };
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
  let kept = [];
  for (let e of entries) {
    const at = ix.find(e.backendNodeId);
    if (hidden.has(e.backendNodeId)) {
      if (!TOGGLES.has(e.role) || !at) continue;
      const label = ix.labelOf(at, hidden);
      // without a label: a toggle hidden only by opacity 0 over a box a person can click (the row draws its check box) is
      // clicked on its own box; a hit test still refuses it when something covers it
      if (label === undefined && !ix.clearBox(at)) continue;
      if (label !== undefined) e = { ...e, via: label };
    }
    if (e.role === "focusable" && (!at || !tabStop(ix, at))) continue;
    kept.push({ e, at });
  }
  // A focusable element that holds a listed control is a container (a panel, a row): its controls are the targets.
  const around = new Map();
  for (const { e, at } of kept) {
    if (!at || e.role === "focusable" || !CLICKABLE.has(e.role)) continue;
    const m = around.get(at.doc) ?? new Set();
    around.set(at.doc, m);
    for (let p = at.doc.nodes.parentIndex[at.i]; p >= 0; p = at.doc.nodes.parentIndex[p]) m.add(p);
  }
  kept = kept.filter(({ e, at }) => e.role !== "focusable" || !around.get(at.doc)?.has(at.i));
  const headers = kept.filter(({ e, at }) => e.role === "columnheader" && at);
  kept = kept.filter(({ e, at }) => e.role !== "columnheader" || (at && sortable(ix, at, e)));
  // How many listed controls each element holds, by node, itself included: a box holds only its own.
  const holds = new Map();
  for (const { e, at } of kept) {
    if (!at || !CLICKABLE.has(e.role)) continue;
    const m = holds.get(at.doc) ?? new Map();
    holds.set(at.doc, m);
    for (let p = at.i; p >= 0; p = at.doc.nodes.parentIndex[p]) m.set(p, (m.get(p) ?? 0) + 1);
  }
  // The listed controls inside each control (a footnote link in a column header): a click on it aims beside them.
  const inner = new Map();
  const listed = new Set(kept.filter(({ e, at }) => at && CLICKABLE.has(e.role)).map(({ e }) => e.backendNodeId));
  for (const { e, at } of kept) {
    if (!at || !CLICKABLE.has(e.role)) continue;
    for (let p = at.doc.nodes.parentIndex[at.i]; p >= 0; p = at.doc.nodes.parentIndex[p]) {
      const holder = at.doc.nodes.backendNodeId[p];
      if (listed.has(holder)) inner.set(holder, [...(inner.get(holder) ?? []), e.via ?? e.backendNodeId]);
    }
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
      if (inner.has(e.backendNodeId)) e = { ...e, inner: inner.get(e.backendNodeId) };
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
      // aria-sort (ascending, descending, other): the accessibility tree Chrome sends leaves it out
      if (a["aria-sort"] !== undefined) e = { ...e, sort: a["aria-sort"] || "none" };
      if ((e.hasPopup || e.expanded === false) && !FIELDS.has(e.role) && !showsText(ix, at)) e = { ...e, iconOnly: true };
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
  return groupHeaders(out, headers, ix);
}

// An element in the page's Tab order by its own markup (tabindex 0 or more; -1 only takes focus from script) that does not
// scroll (a scroller with tabindex is a region to read, not a control).
function tabStop(ix, at) {
  const t = ix.attrs(at).tabindex;
  if (t === undefined || !/^\s*\d+\s*$/.test(t)) return false;
  const st = ix.view(at.doc).style(at.i);
  return !/^(auto|scroll)$/.test(st?.[4] ?? "") && !/^(auto|scroll)$/.test(st?.[5] ?? "");
}

// A column header that sorts or takes clicks: aria-sort, focusable, a click listener or a pointer cursor. Others are labels.
function sortable(ix, at, e) {
  if (e.focusable || ix.attrs(at)["aria-sort"] !== undefined) return true;
  if ((at.doc.nodes.isClickable?.index ?? []).includes(at.i)) return true;
  return /^(pointer)$/.test(ix.view(at.doc).style(at.i)?.[7] ?? "");
}

// Whether an element shows text of its own (a person reads its name), or only an icon.
function showsText(ix, { doc, i }) {
  const v = ix.view(doc);
  const pi = doc.nodes.parentIndex;
  for (let k = i + 1; k < pi.length; k++) {
    let p = pi[k];
    while (p > i) p = pi[p];
    if (p !== i) break;
    if (doc.nodes.nodeType[k] !== 3 || v.str(doc.nodes.nodeValue[k]).trim() === "") continue;
    const b = v.bounds(k);
    if (b && !v.tiny(b)) return true;
  }
  return false;
}

// Column headers that share a name (Population under two groups) get the header above them whose span covers theirs, in
// the same table: `group`, printed as `in "City proper"`. `headers` are every named header, the group cells included.
function groupHeaders(out, headers, ix) {
  const kept = out.filter((e) => e.role === "columnheader");
  if (kept.length < 2) return out;
  const count = new Map();
  for (const e of kept) count.set(e.name, (count.get(e.name) ?? 0) + 1);
  if (![...count.values()].some((n) => n > 1)) return out;
  const tableOf = ({ doc, i }) => {
    for (let p = doc.nodes.parentIndex[i]; p >= 0; p = doc.nodes.parentIndex[p]) if (ix.tag(doc, p) === "TABLE") return p;
    return -1;
  };
  const cells = headers.map(({ e, at }) => ({ e, at, box: ix.view(at.doc).bounds(at.i), table: tableOf(at) })).filter((c) => c.box);
  const group = new Map();
  for (const c of cells) {
    if ((count.get(c.e.name) ?? 0) < 2 || !kept.some((e) => e.backendNodeId === c.e.backendNodeId)) continue;
    const b = c.box;
    let best;
    for (const g of cells) {
      if (g === c || g.at.doc !== c.at.doc || g.table !== c.table) continue;
      const a = g.box;
      if (a.y + a.h > b.y + 2 || a.x > b.x + 2 || a.x + a.w < b.x + b.w - 2) continue;
      if (!best || a.y > best.box.y) best = g;
    }
    if (best) group.set(c.e.backendNodeId, best.e.name);
  }
  return out.map((e) => (e.role === "columnheader" && group.has(e.backendNodeId) ? { ...e, group: group.get(e.backendNodeId) } : e));
}

// A control without a name in letters and without a placeholder is told apart by the text of its row (`near`, as --near
// would match it). One that has neither markup words nor row text says nothing a person could use: it is dropped, as before,
// unless it is a field or a checkbox (those are typed into or ticked by ref). A focusable element whose row has no text (two
// handles of one slider) takes the text of the nearest element around it that has some. Controls that share a role and a
// name (a "Toggle" per row of a list) show their row's text too, cut to 40 characters, without the name it starts with.
function nameUnnamed(nodes, entries) {
  const unnamed = (e) => CLICKABLE.has(e.role) && !LETTER.test(e.name) && !e.placeholder;
  const key = (e) => `${e.frameTag ?? ""}\u0000${e.role}\u0000${e.name}`;
  const count = new Map();
  for (const e of entries) if (CLICKABLE.has(e.role) && LETTER.test(e.name)) count.set(key(e), (count.get(key(e)) ?? 0) + 1);
  const twin = (e) => CLICKABLE.has(e.role) && LETTER.test(e.name) && (count.get(key(e)) ?? 0) > 1;
  const want = new Set(entries.filter((e) => unnamed(e) || twin(e)));
  if (want.size === 0) return entries;
  const rows = rowTexts(nodes, entries, { max: 50, only: want });
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const words = /[\p{L}\p{N}]/u;
  // the text of the nearest ancestor that has any (the label beside a slider's track)
  const around = (e) => {
    for (let n = byId.get(byId.get(e.nodeId)?.parentId); n; n = byId.get(n.parentId)) {
      const t = axText(byId, n.nodeId, 40);
      if (words.test(t)) return t;
    }
    return "";
  };
  return entries
    .map((e, i) => {
      if (!want.has(e)) return e;
      if (unnamed(e)) {
        const row = words.test(rows[i] ?? "") ? rows[i] : e.role === "focusable" ? around(e) : "";
        return row ? { ...e, near: row } : e;
      }
      const row = rows[i].toLowerCase().startsWith(e.name.toLowerCase()) ? rows[i].slice(e.name.length).trim() : rows[i];
      return words.test(row) ? { ...e, near: clip(row, 40) } : e;
    })
    .filter((e) => !unnamed(e) || e.name || e.mark || e.label || e.near || FIELDS.has(e.role) || e.role === "checkbox");
}

// What a name regex is tested against: the name and placeholder, the description (a label that moved there once a value was
// picked), a column header's group and name ("City proper Population"), and for a control without a name the text beside it,
// its markup words, its row and its role word ("slider"). A named control's row (`near` of a twin) is not its name.
const matchTexts = (e) => {
  const named = LETTER.test(e.name ?? "");
  return [e.name, e.placeholder, e.label, e.mark, named ? undefined : e.near, e.description, e.group && `${e.group} ${e.name}`, named ? undefined : e.role].filter(Boolean);
};

// Markup words are a last resort: a control with a label or a row text a person reads is shown by those. A focusable element
// has no role word that says what it is: its markup words always show.
const showMark = (e) => e.mark && (e.role === "focusable" ? !e.name : !e.label && !e.near);

function entryLine(e, { nameMax = 120 } = {}) {
  let line = `[${e.ref}] ${e.role}${e.name || (!showMark(e) && e.role !== "focusable") ? ` "${clip(e.name, nameMax)}"` : ""}`;
  if (e.group) line += ` in "${clip(e.group, 60)}"`;
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
  if (e.selected === true) line += " selected";
  if (e.pressed !== undefined) line += ` pressed=${e.pressed}`;
  if (e.sort !== undefined || e.role === "columnheader") line += ` sort=${e.sort ?? "none"}`;
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
const STATE = ["checked", "expanded", "selected", "pressed", "sort", "value", "name"];
function stateDiff(a, b) {
  if (!a || !b) return [];
  // checked, expanded, selected, pressed and sort are tokens (true, false, mixed; ascending); value and name are text
  const show = (k, v) => (k === "value" || k === "name" ? JSON.stringify(clip(String(v ?? ""), 40)) : String(v ?? "none"));
  // a header without aria-sort is unsorted, like one with aria-sort="none"
  const get = (x, k) => (k === "sort" && x.role === "columnheader" ? (x[k] ?? "none") : x[k]);
  return STATE.filter((k) => String(get(a, k) ?? "") !== String(get(b, k) ?? "")).map((k) => `${k} ${show(k, get(a, k))} -> ${show(k, get(b, k))}`);
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
  const textOf = (id) => axText(byId, id, max);
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

// The visible text (StaticText) of an accessibility node's subtree, cut to `max` characters.
function axText(byId, id, max) {
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
}

// Where an element sits for a person, beyond its row: the names of the groups around it (a radio group, a fieldset, a table
// row, a list item) and the last heading before it in the page (a question's title above a scale). `nodes` in any order: the
// page's order is walked from the roots. Returns entry -> [texts], computed once per page.
const CONTEXT = new Set(["group", "radiogroup", "row", "listitem"]);
function contextOf(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  let order;
  let heads;
  return (e) => {
    if (e.nodeId === undefined || !byId.has(e.nodeId)) return [];
    if (!order) {
      order = new Map();
      heads = [];
      const walk = (id) => {
        const n = byId.get(id);
        if (!n || order.has(id)) return;
        order.set(id, order.size);
        if (!n.ignored && value(n.role) === "heading" && squash(value(n.name))) heads.push(n);
        for (const c of n.childIds ?? []) walk(c);
      };
      for (const n of nodes) if (n.parentId === undefined || !byId.has(n.parentId)) walk(n.nodeId);
    }
    const out = [];
    for (let n = byId.get(byId.get(e.nodeId).parentId); n; n = byId.get(n.parentId)) {
      const name = squash(value(n.name));
      if (!n.ignored && CONTEXT.has(value(n.role)) && name) out.push(name);
    }
    const at = order.get(e.nodeId) ?? -1;
    let head;
    for (const h of heads) if (order.get(h.nodeId) < at) head = h;
    if (head) out.push(squash(value(head.name)));
    return out;
  };
}

// The node ids inside a modal dialog (aria-modal, an alert dialog): what a person can act on while it is open.
function modalIds(nodes) {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const out = new Set();
  const walk = (id) => {
    const n = byId.get(id);
    if (!n || out.has(id)) return;
    out.add(id);
    for (const c of n.childIds ?? []) walk(c);
  };
  for (const n of nodes) {
    if (n.ignored) continue;
    const modal = (n.properties ?? []).some((p) => p.name === "modal" && value(p.value) === true);
    if (modal || value(n.role) === "alertdialog") walk(n.nodeId);
  }
  return out;
}

// Picks what a click by name means. Returns { pick, note } or { several } (entries with their row text) or { none }.
// Matches with one URL count as one (an image link and a title link to the same product); --near picks by row text, the
// groups around an element or the heading above it. A button whose name contains a matching link's name loses to that link;
// --role narrows to one role. Of several, in order (each automatic pick says so in `note`):
//   1. an element named exactly like the pattern ("Accept" over "Do not accept"); with none, the one line of text (`texts`,
//      read when needed) that reads exactly so beats elements that only contain it (`drag "A"`);
//   2. those inside an open modal dialog;
//   3. with `fields`, a field outside the page's header and navigation (a site's search box against the form's own);
//   4. twins (one role, name, row and context: --near cannot tell them apart, a copy in an off-canvas menu): the one in the
//      viewport (`inView`), else the first in the main content.
// Matches in different rows are listed, never chosen.
function chooseTarget(nodes, entries, re, { near, nth, role, showable = false, texts, fields = false, inView, landmark } = {}) {
  let matches = entries.filter((e) => (CLICKABLE.has(e.role) || showable) && matchTexts(e).some((t) => re.test(t)) && (!role || e.role === role));
  if (matches.length === 0) return { none: true };
  const whole = new RegExp(`^(?:${re.source})$`, re.flags);
  const notes = [];
  // A field to type into while a modal is open is one inside it: a field behind it takes no input, whatever its name
  // (rule 2 below, applied before rule 1 so an exact name behind the dialog does not hide the dialog's own field).
  const inModal = modalIds(nodes);
  if (fields) {
    const inside = matches.filter((e) => inModal.has(e.nodeId));
    if (inside.length > 0 && inside.length < matches.length) {
      notes.push(`${matches.length} fields match; used the one in the open dialog (another: its ref)`);
      matches = inside;
    }
  }
  const exact = matches.filter((e) => [e.name, e.placeholder, e.label, e.group && `${e.group} ${e.name}`].some((t) => t && whole.test(t)));
  if (exact.length > 0) {
    if (exact.length < matches.length) notes.push(`${matches.length} elements match; used the one named exactly so`);
    matches = exact;
  } else {
    const lines = texts && !role ? texts().filter((t) => whole.test(t.name)) : [];
    if (lines.length === 1 && nth === undefined)
      return { pick: lines[0], note: `${matches.length} element${matches.length === 1 ? "" : "s"} only contain${matches.length === 1 ? "s" : ""} ${JSON.stringify(re.source)}; used the text that reads exactly so` };
    if (!role) {
      // A button whose name repeats a matching link's ("Add <product> to cart" next to the "<product>" link) is the
      // link's companion: drop it. Any other button stays, so a real choice is listed, never decided silently.
      const linkNames = matches.filter((e) => e.role === "link" && e.name).map((e) => e.name.toLowerCase());
      if (linkNames.length > 0)
        matches = matches.filter((e) => e.role !== "button" || !linkNames.some((n) => e.name.toLowerCase().includes(n)));
    }
  }
  const ctx = contextOf(nodes);
  const rows = rowTexts(nodes, matches);
  let withRows = matches.map((e, i) => ({ ...e, row: rows[i] }));
  if (near) {
    const nearRe = near instanceof RegExp ? near : new RegExp(near, "i");
    withRows = withRows.filter((e) => [e.row, e.near, e.name, e.group, ...ctx(e)].some((t) => t && nearRe.test(t)));
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
  const done = (pick, note) => ({ pick, note: [...notes, note].filter(Boolean).join("; ") || undefined });
  if (distinct.length === 1) return done(distinct[0]);
  let left = distinct;
  const modal = left.filter((e) => inModal.has(e.nodeId));
  if (modal.length > 0 && modal.length < left.length) {
    if (modal.length === 1) return done(modal[0], `${left.length} elements match; used the one in the open dialog (another: its ref)`);
    left = modal;
  }
  if (fields && landmark) {
    const out = left.filter((e) => !landmark(e));
    if (out.length === 1) return done(out[0], `${left.length} fields match; used the one outside the page's header and navigation (another: --near "row text" or its ref)`);
  }
  // pictures in a gallery share a name (alt) though a person tells them apart: twins are controls only
  const key = (e) => [e.role, e.name, e.group ?? "", e.row, ...ctx(e)].join("\u0000");
  if (left.every((e) => CLICKABLE.has(e.role) && key(e) === key(left[0]))) {
    const seenNow = inView ? left.find((e) => inView(e)) : undefined;
    return done(
      seenNow ?? left[0],
      `${left.length} identical elements match (same name, row and place); used the ${seenNow ? "one in view" : "first in the main content"} (another: its ref)`,
    );
  }
  return { several: left };
}

// Closed menus and collapsed controls a missing element may sit in (an overflow "..." button that hides "Sort"): controls
// with aria-haspopup or expanded=false, icon-only and unnamed ones first, then menus before dialogs, in the page's order
// (the main content first). Nothing is opened.
function closedMenus(entries, { max = 4 } = {}) {
  const pick = entries.filter(
    (e) => CLICKABLE.has(e.role) && !["textbox", "searchbox"].includes(e.role) && !e.disabled && (e.hasPopup || e.expanded === false || e.expanded === "false"),
  );
  const rank = (e) => (e.iconOnly || !LETTER.test(e.name ?? "") ? 0 : 2) + (e.hasPopup && e.hasPopup !== "dialog" ? 0 : 1);
  return pick
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.e);
}

// Points to click a control that holds other listed controls (a column header with a footnote link) on itself: inside its
// box `own` ({l, t, r, b}), at least 3 px from the boxes of those inside it, nearest its centre first.
function aimPoints(own, inner) {
  const cx = (own.l + own.r) / 2;
  const cy = (own.t + own.b) / 2;
  const out = [];
  for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85])
    for (const fx of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.1, 0.9]) {
      const x = own.l + 3 + fx * Math.max(own.r - own.l - 6, 0);
      const y = own.t + 3 + fy * Math.max(own.b - own.t - 6, 0);
      if (inner.some((k) => x >= k.l - 3 && x <= k.r + 3 && y >= k.t - 3 && y <= k.b + 3)) continue;
      out.push({ x, y });
    }
  return out.sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
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
  // `cut` (cutBy) learns the overflow box that cut i's box away entirely, when one did.
  const cutBy = (i) => {
    let box = bounds(i);
    if (!box) return undefined;
    let cut = -1;
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
      if (/^(hidden|clip)$/.test(as[4]) || /^(hidden|clip)$/.test(as[5])) {
        const was = tiny(box);
        box = meet(box, ab);
        if (!was && tiny(box) && cut < 0) cut = a;
      }
    }
    return { box, cut };
  };
  const visible = (i) => cutBy(i)?.box;
  const display = (i) => style(i)?.[0] ?? "inline";
  return { str, style, display, bounds, visible, cutBy, parent, layoutOf, seeThrough, offscreen, tiny };
}

// The inline boxes (inline-block, inline-flex and the items of an inline flex or grid) of a document whose text reads as part
// of the line around them: "Distance: <output>13km</output>." is one line. Decided from layout alone: all of the box's text
// sits on one visual line (no fragment of it wraps, and it holds no block of its own), and that line overlaps text of the
// same block outside the box. A card or a column built of inline-blocks spans several lines and stays apart. The items of a
// flex row (which compute to block) count too when one's text stands within 0.6 of a line's height of the next's: a price drawn as
// "699" "00" "zł" side by side. Returns { joined, spaced }: `spaced` are those flex items, whose words are always kept apart
// by a space ("699 00 zł", never "69900"), as a flex row draws them apart. A menu's links are controls and stay lines.
// A link, button or field is a target of its own: as a flex item it stays apart from the text beside it ("50 zł taniej").
const CONTROL_TAGS = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|LABEL)$/i;
function joinInline(doc, v) {
  const n = doc.nodes.parentIndex.length;
  const cand = new Uint8Array(n);
  const spaced = new Set();
  let any = false;
  const kids = new Map(); // flex container -> its items with a box
  for (let i = 0; i < n; i++) {
    if (doc.nodes.nodeType[i] !== 1 || !v.layoutOf.has(i)) continue;
    const p = v.parent[i];
    if (INLINE_BOX.test(v.display(i)) || (p >= 0 && cand[p] && /^inline-(flex|grid)$/.test(v.display(p)))) {
      cand[i] = 1;
      any = true;
    } else if (p >= 0 && /^(inline-)?flex$/.test(v.display(p)) && v.bounds(i) && !CONTROL_TAGS.test(v.str(doc.nodes.nodeName[i]))) {
      if (!kids.has(p)) kids.set(p, []);
      kids.get(p).push(i);
    }
  }
  // where each item's text is drawn (a padded menu link stands apart by its padding though the boxes touch) and the height
  // of its tallest piece of text, a line's
  const ext = new Map();
  if (kids.size > 0) {
    const items = new Set([...kids.values()].flat());
    for (let t = 0; t < n; t++) {
      if (doc.nodes.nodeType[t] !== 3 || v.str(doc.nodes.nodeValue[t]).trim() === "") continue;
      const b = v.bounds(t);
      if (!b || v.tiny(b)) continue;
      for (let p = v.parent[t]; p > 0; p = v.parent[p]) {
        if (!items.has(p)) continue;
        const e = ext.get(p);
        if (!e) ext.set(p, { ...b, line: b.h });
        else {
          const x = Math.min(e.x, b.x);
          const y = Math.min(e.y, b.y);
          ext.set(p, { x, y, w: Math.max(e.x + e.w, b.x + b.w) - x, h: Math.max(e.y + e.h, b.y + b.h) - y, line: Math.max(e.line, b.h) });
        }
      }
    }
  }
  for (const items of kids.values()) {
    for (let k = 0; k + 1 < items.length; k++) {
      const a = ext.get(items[k]);
      const b = ext.get(items[k + 1]);
      if (!a || !b) continue;
      // both within one line of the row: "00" over "zł" in small print beside a large "699" still is
      const row = Math.max(a.line, b.line);
      const h = Math.min(a.line, b.line);
      const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const gap = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w));
      if (h <= 0 || a.h > 1.5 * row || b.h > 1.5 * row || overlap < 0.5 * Math.min(a.h, b.h) || gap > 0.6 * h) continue;
      for (const i of [items[k], items[k + 1]]) {
        cand[i] = 1;
        spaced.add(i);
      }
      any = true;
    }
  }
  const out = new Set();
  if (!any) return { joined: out, spaced: new Set() };
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
    // a flex item is placed by its row (above): blocks inside it (the "00" and "zł" stacked) read as part of the line
    if (spaced.has(a)) {
      out.add(a);
      continue;
    }
    if (s.bad || h > 1.5 * s.h) continue;
    const meets = (flows.get(flowOf.get(a)) ?? []).some(
      (q) => Math.min(q.bottom, s.bottom) - Math.max(q.top, s.top) >= 0.5 * Math.min(q.bottom - q.top, h) && !q.inside.includes(a),
    );
    if (meets) out.add(a);
  }
  if (spaced.size > 0) {
    for (let i = 0; i < n; i++) {
      if (doc.nodes.nodeType[i] !== 1 || out.has(i) || !BLOCK.test(v.display(i))) continue;
      for (let p = v.parent[i]; p > 0; p = v.parent[p]) {
        if (!spaced.has(p)) continue;
        out.add(i);
        break;
      }
    }
  }
  return { joined: out, spaced };
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
// One with a name of its own (aria-label, alt: an "Accepted" check, a shop's logo) is written as that name, `‹"Accepted"›`.
// Text in an element with a `datetime` (a <time>) is followed by `‹datetime=…›`, and text in one whose `title` says more
// than the text by `‹title:"…"›`: values a person reads from a tooltip, never printed without `marks`.
function snapshotLines(snap, { marks = false, table = false } = {}) {
  return snapshotGroups(snap, { marks, table }).map((g) => g.text);
}

// The lines of snapshotLines with where they come from: { text, doc, v (docView), block (node index), texts (text node
// indexes) }. With `table` a table row is one line of its cells joined by " | ", empty cells kept (spans are not resolved),
// and carries `table` (its table, "document:node") and `head` (a header row: all its cells are th, or it sits in a thead).
// A table row is a <tr> (display table-row with table-cell children) or an element with role row and cells of role cell,
// gridcell, columnheader or rowheader (ARIA grids drawn with divs), whatever their display.
function snapshotGroups(snap, { marks = false, table = false } = {}) {
  const lines = [];
  let marked = 0;
  for (const [di, doc] of (snap.documents ?? []).entries()) {
    const v = docView(snap, doc);
    // in a table, each cell is a block of its own: the row is put together from them below
    const aria = table ? ariaRows(snap, doc, v) : undefined;
    const isBlock = (p) => BLOCK.test(v.display(p)) || (table && (v.display(p) === "table-cell" || aria.rowOf.has(p) || aria.cells.has(p)));
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
    const { joined, spaced } = joinInline(doc, v);
    const blockOf = (i) => {
      let p = v.parent[i];
      while (p > 0 && (!isBlock(p) || joined.has(p))) p = v.parent[p];
      return p;
    };
    // the flex item (joinInline's `spaced`) a text node sits in, within its block: -1 for none
    const itemOf = (i, block) => {
      for (let p = v.parent[i]; p > 0 && p !== block; p = v.parent[p]) if (spaced.has(p)) return p;
      return -1;
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
      if (!groups.has(g)) groups.set(g, { text: "", box: undefined, brk: false, block: g, texts: [], struck: false, x: Infinity, item: -1, attrs: new Map(), titles: new Set() });
      return groups.get(g);
    };
    // marks from the attributes of the elements around a group's text: each written once, after the element's last text
    const flushAttrs = (g, keep = new Set()) => {
      for (const [el, m] of g.attrs) {
        if (keep.has(el) || m.done) continue;
        m.done = true;
        const own = squash(g.text.slice(m.start)).toLowerCase();
        const tokens = [];
        if (m.datetime) tokens.push(`‹datetime=${clip(m.datetime, 40)}›`);
        if (m.title && m.title.toLowerCase() !== own && m.title !== m.datetime) {
          tokens.push(`‹title:"${clip(m.title, 80)}"›`);
          g.titles.add(m.title);
        }
        if (tokens.length > 0) g.text = `${g.text.replace(/\s*$/, "")} ${tokens.join(" ")} `;
      }
    };
    const attrMarks = (g, i) => {
      const around = new Set();
      for (let p = v.parent[i], k = 0; p > 0 && k < 8; p = v.parent[p], k++) {
        around.add(p);
        if (p === g.block) break;
      }
      flushAttrs(g, around);
      for (const p of around) {
        if (g.attrs.has(p)) continue;
        const a = nodeAttrs(snap, doc, p);
        const datetime = squash(a.datetime);
        const title = squash(a.title);
        if (datetime || LETTER.test(title)) g.attrs.set(p, { start: g.text.length, datetime, title });
      }
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
          const named = squash(at["aria-label"] || at.alt);
          if (b && shown && shown.w >= 4 && shown.h >= 4 && (Math.min(b.w, b.h) <= 120 || name(i) === "IMG" || name(i) === "SVG") && !v.offscreen(b) && v.style(i)?.[1] !== "hidden" && !v.seeThrough(i)) {
            // Its name, else that of a picture inside it (a logo's link), else its own words, else those of its first
            // descendant that has any.
            const inside = (k) => {
              for (let p = k; p >= 0; p = doc.nodes.parentIndex[p]) if (p === i) return true;
              return false;
            };
            let label = named;
            for (let k = i + 1; !label && k < doc.nodes.parentIndex.length && inside(k); k++) {
              if (doc.nodes.nodeType[k] !== 1) continue;
              const ak = nodeAttrs(snap, doc, k);
              label = squash(ak["aria-label"] || ak.alt);
            }
            let tokens = label ? [`"${clip(label, 80)}"`] : markTokens(snap, doc, i);
            for (let k = i + 1; tokens.length === 0 && k < doc.nodes.parentIndex.length && inside(k); k++) {
              if (doc.nodes.nodeType[k] === 1) tokens = markTokens(snap, doc, k);
            }
            covered.add(i);
            if (tokens.length > 0) {
              marked++;
              const text = label ? `‹${tokens[0]}›` : `‹${clip(tokens.join(" "), 60)}›`;
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
      if (marks) attrMarks(g, i);
      const s = struck(i);
      const item = spaced.size > 0 ? itemOf(i, g.block) : -1;
      // another flex item: apart, unless it starts with a decimal mark or a comma ("145" ",95")
      const nextItem = item !== g.item && (item >= 0 || g.item >= 0) && !/^[,.]/.test(raw);
      if (g.struck && !s) g.text = g.text.replace(/\s*$/, (m) => `~${m}`);
      if (g.text !== "" && !/\s$/.test(g.text) && !/^\s/.test(raw) && (g.brk || nextItem || apart(g.box, b) || s !== g.struck)) g.text += " ";
      g.text += s && !g.struck ? raw.replace(/^\s*/, (m) => `${m}~`) : raw;
      g.struck = s;
      g.box = b;
      g.brk = false;
      g.item = item;
      g.x = Math.min(g.x, b.x);
      g.texts.push(i);
    }
    const done = [];
    for (const g of groups.values()) {
      if (marks) flushAttrs(g);
      let t = squash(g.struck ? g.text.replace(/\s*$/, "~") : g.text);
      if (t && !LETTER.test(t.replace(/‹[^›]*›/g, "")) && g.texts.length > 0) {
        const label = labelAround(snap, doc, v, g.texts[0]);
        if (label && !g.titles.has(label)) t += ` ‹${clip(label, 80)}›`;
      }
      if (t) done.push({ text: t, doc, v, block: g.block, texts: g.texts, x: Number.isFinite(g.x) ? g.x : 0 });
    }
    lines.push(...(table ? tableRows(done, doc, v, di, aria) : done));
  }
  return lines;
}

// The rows of a document's ARIA grids, from role attributes alone: { rowOf (cell -> its row), cells (row -> its cells, in
// document order), role (node -> its first role word) }. A cell's row is the nearest ancestor with role row, no other cell
// between. Only elements with a box count.
const CELL_ROLES = /^(cell|gridcell|columnheader|rowheader)$/;
function ariaRows(snap, doc, v) {
  const roles = new Map();
  const role = (i) => {
    if (!roles.has(i)) roles.set(i, i >= 0 && doc.nodes.nodeType[i] === 1 ? (nodeAttrs(snap, doc, i).role ?? "").trim().split(/\s+/)[0].toLowerCase() : "");
    return roles.get(i);
  };
  const rowOf = new Map();
  const cells = new Map();
  for (const [i] of v.layoutOf) {
    if (!CELL_ROLES.test(role(i))) continue;
    let r = v.parent[i];
    while (r >= 0 && role(r) !== "row" && !CELL_ROLES.test(role(r))) r = v.parent[r];
    if (r < 0 || role(r) !== "row" || !v.layoutOf.has(r)) continue;
    rowOf.set(i, r);
    if (!cells.has(r)) cells.set(r, []);
    cells.get(r).push(i);
  }
  for (const list of cells.values()) list.sort((a, b) => a - b);
  return { rowOf, cells, role };
}

// The lines of one document (snapshotGroups) with the lines of each table row's cells joined into one line at the row's
// first: "Tokyo | Japan | 37,400,068". A cell's text is all the lines inside it; a cell without text stays, empty.
// `aria` (ariaRows) adds the rows of ARIA grids; a header row there is one of columnheader cells only.
function tableRows(done, doc, v, di, aria) {
  const name = (i) => v.str(doc.nodes.nodeName[i]).toUpperCase();
  const rowOf = (c) => aria.rowOf.get(c) ?? v.parent[c];
  // A TD or TH under a TR is a cell of that row whatever its display: a restyled table (display:grid, tr display:contents)
  // keeps its markup, and a row that is display:contents has no box of its own.
  const isCell = (p) => /^(TD|TH)$/.test(name(p)) && v.parent[p] >= 0 && name(v.parent[p]) === "TR";
  const cellOf = (i) => {
    for (let p = i; p >= 0; p = v.parent[p]) {
      if (aria.rowOf.has(p)) return p;
      if (aria.cells.has(p)) return -1;
      if (isCell(p)) return p;
      const d = v.display(p);
      if (d === "table-cell") return v.display(v.parent[p]) === "table-row" ? p : -1;
      if (/^(table|table-row|table-row-group|table-header-group|table-footer-group)$/.test(d)) return -1;
    }
    return -1;
  };
  const cells = new Map(aria.cells);
  for (const [i] of v.layoutOf) {
    const row = v.parent[i];
    // a cell has a box even when its row (display:contents) has none; a display:none cell has none and is no cell
    if (row >= 0 && !aria.cells.has(row) && (isCell(i) || (v.display(i) === "table-cell" && v.display(row) === "table-row"))) {
      if (!cells.has(row)) cells.set(row, []);
      cells.get(row).push(i);
    }
  }
  for (const list of cells.values()) list.sort((a, b) => a - b);
  const inCell = new Map();
  for (const l of done) {
    const c = cellOf(l.block);
    if (c < 0) continue;
    if (!inCell.has(c)) inCell.set(c, []);
    inCell.get(c).push(l);
  }
  const out = [];
  const emitted = new Set();
  for (const l of done) {
    const c = cellOf(l.block);
    if (c < 0) {
      out.push(l);
      continue;
    }
    const row = rowOf(c);
    if (emitted.has(row)) continue;
    emitted.add(row);
    const own = (cells.get(row) ?? [c]).map((k) => inCell.get(k) ?? []);
    let tab = row;
    let head;
    if (aria.cells.has(row)) {
      // the grid around the row, else the nearest ancestor that is not a group of rows
      tab = v.parent[row];
      while (tab >= 0 && !/^(grid|table|treegrid)$/.test(aria.role(tab))) tab = v.parent[tab];
      if (tab < 0) for (tab = v.parent[row]; tab > 0 && aria.role(tab) === "rowgroup"; ) tab = v.parent[tab];
      head = aria.cells.get(row).every((k) => aria.role(k) === "columnheader");
    } else {
      while (tab >= 0 && v.display(tab) !== "table") tab = v.parent[tab];
      if (tab < 0) for (tab = row; tab >= 0 && name(tab) !== "TABLE"; ) tab = v.parent[tab];
      head = (cells.get(row) ?? []).every((k) => name(k) === "TH");
      for (let p = v.parent[row]; p >= 0 && p !== tab && !head; p = v.parent[p]) head = name(p) === "THEAD";
    }
    out.push({
      text: own.map((ls) => ls.map((x) => x.text).join(" ")).join(" | "),
      doc,
      v,
      block: row,
      texts: own.flat().flatMap((x) => x.texts),
      x: Math.min(...own.flat().map((x) => x.x)),
      table: `${di}:${tab}`,
      head,
    });
  }
  return out;
}

// Text a box with overflow hidden cuts away entirely (a collapsed spec table, a "show more" section): how many of its blocks
// match `re`, and the boxes that cut them, so an answer can say that it exists and what opens it without printing it. Only
// text a person would see once the box opens counts: a box that itself shows (at least 20 px each way) cuts it, not a
// screen-reader-only one of 1 px, and nothing hidden in any other way. Returns { count, boxes: [{x, y, w, h}] }.
function cutOff(snap, re) {
  let count = 0;
  const boxes = [];
  for (const doc of snap.documents ?? []) {
    const v = docView(snap, doc);
    const blocks = new Map(); // block -> { text, cut }
    for (const [i] of v.layoutOf) {
      if (doc.nodes.nodeType[i] !== 3) continue;
      const raw = v.str(doc.nodes.nodeValue[i]);
      const b = v.bounds(i);
      if (raw.trim() === "" || !b || v.tiny(b) || v.style(i)?.[1] === "hidden" || v.seeThrough(i)) continue;
      const r = v.cutBy(i);
      if (!r || r.cut < 0 || !v.tiny(r.box)) continue;
      const shown = v.visible(r.cut);
      if (!shown || shown.w < 20 || shown.h < 20 || v.style(r.cut)?.[1] === "hidden" || v.seeThrough(r.cut)) continue;
      let block = v.parent[i];
      while (block > 0 && !BLOCK.test(v.display(block))) block = v.parent[block];
      const g = blocks.get(block) ?? { text: "", cut: r.cut };
      g.text += ` ${raw}`;
      blocks.set(block, g);
    }
    for (const g of blocks.values()) {
      if (!re.test(squash(g.text))) continue;
      count++;
      const box = v.visible(g.cut);
      if (!boxes.some((x) => x.x === box.x && x.y === box.y && x.w === box.w && x.h === box.h)) boxes.push(box);
    }
  }
  return { count, boxes };
}

// The boxes of elements by backend id, as a layout snapshot has them (page coordinates).
function boxesOf(snap, ids) {
  const want = new Set(ids);
  const out = new Map();
  for (const doc of snap.documents ?? []) {
    const v = docView(snap, doc);
    for (const [i] of v.layoutOf) {
      const id = doc.nodes.backendNodeId[i];
      if (want.has(id) && v.bounds(i)) out.set(id, v.bounds(i));
    }
  }
  return out;
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

// The title (in letters) of an element by backend id, or of the nearest element around it that holds little more: the
// tooltip a person sees when the pointer rests on it. Undefined when there is none.
function titleAround(snap, backendNodeId) {
  for (const doc of snap.documents ?? []) {
    const i = doc.nodes.backendNodeId.indexOf(backendNodeId);
    if (i < 0) continue;
    const v = docView(snap, doc);
    const own = v.bounds(i);
    for (let p = i, k = 0; p > 0 && k < 5; p = v.parent[p], k++) {
      if (/^(BODY|HTML)$/i.test(v.str(doc.nodes.nodeName[p]))) return undefined;
      const b = v.bounds(p);
      if (own && b && (b.w > own.w + 200 || b.h > Math.max(3 * own.h, own.h + 40))) return undefined;
      const title = squash(nodeAttrs(snap, doc, p).title);
      if (LETTER.test(title)) return title;
    }
  }
  return undefined;
}

// snapshotLines wrapped to `width`, with where each line is: `xs` (its left edge, px) and `at` (backend node id -> index of
// the first line holding the element's text), so a heading maps to its line by node, not by its words.
// With `table` (snapshotGroups) `rows` holds, per line, the { table, head } of a table row's line.
function snapshotText(snap, { marks = false, width = 200, table = false } = {}) {
  const lines = [];
  const xs = [];
  const at = new Map();
  const rows = [];
  for (const g of snapshotGroups(snap, { marks, table })) {
    const first = lines.length;
    for (const l of wrapLines([g.text], width)) {
      rows[lines.length] = g.table === undefined ? undefined : { table: g.table, head: g.head };
      lines.push(l);
      xs.push(g.x);
    }
    const ids = g.doc.nodes.backendNodeId;
    for (const t of g.texts) for (let p = g.v.parent[t]; p >= 0 && !at.has(ids[p]); p = g.v.parent[p]) at.set(ids[p], first);
  }
  return { lines, xs, at, rows };
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

// Lines of `after` that `before` did not have, in order, once each: what an action changed on the page. Lines are counted, so
// a line that `before` held elsewhere ("Red" picked in a second list) is new when `after` holds it more often.
function newLines(before, after) {
  const left = new Map();
  for (const l of before) left.set(l, (left.get(l) ?? 0) + 1);
  const out = [];
  const seen = new Set();
  for (const l of after) {
    const n = left.get(l) ?? 0;
    if (n > 0) {
      left.set(l, n - 1);
      continue;
    }
    if (seen.has(l)) continue;
    seen.add(l);
    out.push(l);
  }
  return out;
}

// Controls an action added (a chip's "Remove Red" button, a field that opened for editing): per frame, role and name, those
// `after` holds more of than `before`. Of those that could be the new one, first one with a ref `before` did not list, and of
// those first one whose row (`near`) is new too (a list drawn again gives every row a new ref). In the page's order.
function appearedControls(before, after) {
  const key = (e) => `${e.frameTag ?? ""}\u0000${e.role}\u0000${e.name}`;
  const sig = (e) => `${key(e)}\u0000${e.near ?? ""}`;
  const count = (es, f) => {
    const m = new Map();
    for (const e of es) if (CLICKABLE.has(e.role)) m.set(f(e), (m.get(f(e)) ?? 0) + 1);
    return m;
  };
  const was = count(before, key);
  const now = count(after, key);
  const rowWas = count(before, sig);
  const known = new Set(before.map((e) => e.ref));
  const picked = new Set();
  for (const [k, n] of now) {
    const grew = n - (was.get(k) ?? 0);
    if (grew <= 0) continue;
    const same = after.filter((e) => CLICKABLE.has(e.role) && key(e) === k);
    const rows = new Map(rowWas);
    const newRow = (e) => {
      const left = rows.get(sig(e)) ?? 0;
      rows.set(sig(e), left - 1);
      return left <= 0;
    };
    const fresh = same.filter(newRow);
    const rest = same.filter((e) => !fresh.includes(e));
    const order = [...fresh.filter((x) => !known.has(x.ref)), ...rest.filter((x) => !known.has(x.ref)), ...fresh.filter((x) => known.has(x.ref)), ...rest.filter((x) => known.has(x.ref))];
    for (const e of order.slice(0, grew)) picked.add(e);
  }
  return after.filter((e) => picked.has(e));
}

// Whether the lines both reads hold kept their order (a sort, a drag that swaps two items, a list that put the picked one
// first). Lines that show more than once in either read are left out: which copy moved cannot be told. Returns the range
// of `after` (1-based line numbers) from the first line out of place to the last, or undefined when the order held.
function orderChange(before, after) {
  const count = (ls) => {
    const m = new Map();
    for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const a = count(before);
  const b = count(after);
  const kept = (l) => a.get(l) === 1 && b.get(l) === 1;
  const was = before.filter(kept);
  const now = [];
  const at = [];
  after.forEach((l, i) => {
    if (kept(l)) {
      now.push(l);
      at.push(i);
    }
  });
  let i = 0;
  while (i < now.length && was[i] === now[i]) i++;
  if (i === now.length) return undefined;
  let j = now.length - 1;
  while (j > i && was[j] === now[j]) j--;
  return { from: at[i] + 1, to: at[j] + 1 };
}

// The element that has focus: its entry when it is one (with a ref), else its accessibility node's role and name; the
// page itself (no element focused) is undefined. { key (frame and backend id), entry?, line }.
function focusOf(nodes, entries) {
  const n = nodes.find((m) => !m.ignored && m.backendDOMNodeId && !/^(RootWebArea|WebArea)$/.test(value(m.role)) && (m.properties ?? []).some((p) => p.name === "focused" && value(p.value) === true));
  if (!n) return undefined;
  const key = `${n.frameTag ?? ""}:${n.backendDOMNodeId}`;
  const entry = entries.find((e) => `${e.frameTag ?? ""}:${e.backendNodeId}` === key);
  return { key, entry, line: entry ? entryLine(entry, { nameMax: 80 }) : `${value(n.role)} "${clip(squash(value(n.name)), 80)}"` };
}

// The acted-on element in a later read: by its ref, else (the page drew it again) the one element of its role and name in
// its frame. { entry, redrawn } or undefined when it is gone or several could be it (`several`).
function findAgain(entries, entry) {
  const same = entries.find((e) => e.ref === entry.ref);
  if (same) return { entry: same, redrawn: false };
  const like = entries.filter((e) => e.role === entry.role && e.name === entry.name && (e.frameTag ?? "") === (entry.frameTag ?? ""));
  if (like.length === 1) return { entry: like[0], redrawn: true };
  return like.length > 1 ? { several: true } : undefined;
}

// The entries a dialog listing keeps when there are more than `max`: its buttons first (the decision is a button, and
// language options and partner links in front of it would push it behind "... N more"), then the others, each in tree order.
// Refs belong to the entries, so the order changes none.
function capEntries(entries, max) {
  if (entries.length <= max) return entries;
  return [...entries.filter((e) => e.role === "button"), ...entries.filter((e) => e.role !== "button")].slice(0, max);
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
    const entries = axEntries(sub).filter((e) => e.role !== "heading" && !IMAGES.has(e.role) && (e.role !== "columnheader" || e.focusable));
    out.push({
      role,
      modal: modal || role === "alertdialog",
      name: squash(value(n.name)),
      backendNodeId: n.backendDOMNodeId,
      frameTag: n.frameTag,
      entries: capEntries(entries, max),
      more: Math.max(entries.length - max, 0),
    });
  }
  return out;
}

// The controls inside a set of elements (backend ids, of the part with frame tag `tag`), as a dialog lists them: a fixed
// layer in front that has no dialog role (a consent overlay). Returns { entries (at most `max`), more, buttons }.
function layerControls(nodes, ids, { tag = "", max = 8 } = {}) {
  const sub = nodes.filter((n) => !n.ignored && (n.frameTag ?? "") === tag && ids.has(n.backendDOMNodeId));
  const entries = axEntries(sub).filter((e) => e.role !== "heading" && !IMAGES.has(e.role) && (e.role !== "columnheader" || e.focusable));
  return { entries: capEntries(entries, max), more: Math.max(entries.length - max, 0), buttons: entries.filter((e) => e.role === "button").length };
}

// The elements at or above a node (by backend id) that a layout snapshot shows with position fixed, nearest first: layers
// that stay in front whatever the scroll (a consent banner, and the dimming layer it may hold). Returns their backend ids.
function fixedAncestors(snap, backendNodeId) {
  for (const doc of snap.documents ?? []) {
    const i = doc.nodes.backendNodeId.indexOf(backendNodeId);
    if (i < 0) continue;
    const v = docView(snap, doc);
    const out = [];
    for (let p = i; p > 0; p = v.parent[p]) {
      if (/^(BODY|HTML)$/i.test(v.str(doc.nodes.nodeName[p]))) break;
      if (v.style(p)?.[3] === "fixed") out.push(doc.nodes.backendNodeId[p]);
    }
    return out;
  }
  return [];
}

// The widest element around a narrow one (by backend id) that is no taller than 2.5 times it and at most 160 px: the row a
// label or a price sits in (a shop's logo beside its price, an infobox value beside its label), for a screenshot that shows
// what the row says. Returns its backend id, or undefined when nothing around it is wider.
function rowAround(snap, backendNodeId) {
  for (const doc of snap.documents ?? []) {
    const i = doc.nodes.backendNodeId.indexOf(backendNodeId);
    if (i < 0) continue;
    const v = docView(snap, doc);
    const own = v.bounds(i);
    if (!own) return undefined;
    const tallest = Math.min(2.5 * own.h, 160);
    let best;
    let width = own.w;
    for (let p = v.parent[i]; p > 0; p = v.parent[p]) {
      if (/^(BODY|HTML)$/i.test(v.str(doc.nodes.nodeName[p]))) break;
      const b = v.bounds(p);
      if (!b) continue;
      if (b.h > tallest) break;
      if (b.w > width + 1) {
        width = b.w;
        best = doc.nodes.backendNodeId[p];
      }
    }
    return best;
  }
  return undefined;
}

// The screen region a shot takes (all in screen px): the target with `pad` around it, at least SHOT_MIN, and at least the
// row it sits in (`row`, cdp.rowAround). A wide block alone (a heading that spans the page) is cut to a readable width, kept
// at its left edge. The region is shifted, not cut, to stay inside the page's area on the screen (`area`), so nothing of the
// toolbar or another window comes in and the target does not end up at an edge.
const SHOT_NARROW = 300;
const SHOT_MIN = { w: 480, h: 160 };
function shotCrop(box, row, area, pad) {
  const want = row ?? box;
  let w = Math.max(box.w + 2 * pad, SHOT_MIN.w, row ? row.w + 2 * pad : 0);
  if (!row) w = Math.min(w, Math.max(640 + 2 * pad, SHOT_MIN.w));
  let h = Math.max(box.h + 2 * pad, SHOT_MIN.h, row ? row.h + 2 * pad : 0);
  let x = want.w + 2 * pad > w ? want.x - pad : want.x + want.w / 2 - w / 2;
  let y = want.y + want.h / 2 - h / 2;
  if (area && area.w > 0 && area.h > 0) {
    w = Math.min(w, area.w);
    h = Math.min(h, area.h);
    x = Math.min(Math.max(x, area.x), area.x + area.w - w);
    y = Math.min(Math.max(y, area.y), area.y + area.h - h);
  }
  return { x: Math.max(Math.round(x), 0), y: Math.max(Math.round(y), 0), w: Math.round(w), h: Math.round(h) };
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
// At most this many lines (and 200 characters), and no field: a page that says almost nothing.
const NEARLY_EMPTY = 3;
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
  if (main && /^chrome-error:/.test(str(parts[0].snap, main.documentURL))) {
    // Chrome's reason is in the page's text ("net::ERR_CERT_COMMON_NAME_INVALID"); naming it keeps a chain from reading the page as content
    const code = /ERR_[A-Z_]+/.exec(lines.join("\n"))?.[0];
    out.push(`Chrome error page${code ? ` (net::${code})` : ""}: the page did not load. Do not retry, click through or work around it; report the host and move on`);
  }
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
  // A page of a few short lines and no field to fill or heading with a control: a site's error or block page that names no status ("Sorry, something
  // went wrong"), in any language, or a page drawn as a picture. A page with nothing drawn yet is not one (no lines).
  const shown = (tags) =>
    parts.some(({ snap, hidden }) =>
      (snap.documents ?? []).some((doc) => {
        const v = docView(snap, doc);
        return [...v.layoutOf.keys()].some((i) => {
          if (doc.nodes.nodeType[i] !== 1 || !tags.test(v.str(doc.nodes.nodeName[i]))) return false;
          const b = v.bounds(i);
          return b && !v.tiny(b) && !v.offscreen(b) && !hidden?.has(doc.nodes.backendNodeId[i]);
        });
      }),
    );
  // A heading and a button make a page to use ("Welcome" and a Start button), not a blank one.
  const fields = shown(/^(INPUT|TEXTAREA|SELECT)$/i) || (shown(/^H[1-6]$/i) && shown(/^BUTTON$/i));
  const web = /^https?:/.test(str(parts[0]?.snap, main?.documentURL ?? -1));
  const chars = lines.reduce((n, l) => n + l.length, 0);
  if (out.length === 0 && !hit && web && lines.length >= 1 && lines.length <= NEARLY_EMPTY && chars <= 200 && !fields)
    out.push(
      `page shows almost no text (${lines.length} line${lines.length === 1 ? "" : "s"}, no form field): an error or block page, or a picture-only one; look with desktop-shot`,
    );
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
  appearedControls,
  orderChange,
  focusOf,
  findAgain,
  outline,
  decodeEntities,
  pageNotices,
  cutOff,
  boxesOf,
  snapshotText,
  indentLevels,
  wrapLines,
  assertAllowed,
  axEntries,
  chooseTarget,
  closedMenus,
  aimPoints,
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
  titleAround,
  layerControls,
  fixedAncestors,
  rowAround,
  SHOT_NARROW,
  shotCrop,
  wraps,
};
