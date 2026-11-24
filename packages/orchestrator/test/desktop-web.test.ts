import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// desktop-web reads the desktop's Chromium over CDP without any method a page can detect (docs/decisions/0065-desktop-sandbox.md,
// "Chromium and desktop-web"). These tests pin that invariant and the pure parts of cdp-lib.cjs. Nothing here names a real site.
const root = resolve(import.meta.dirname, "../../..");
const files = join(root, "images/sandbox-desktop/files");

interface Entry {
  ref: string;
  backendNodeId: number;
  nodeId: string;
  role: string;
  name: string;
  url?: string;
  value?: string;
  checked?: unknown;
  placeholder?: string;
  mark?: string;
  near?: string;
  via?: number;
  frameTag?: string;
}
interface CdpLib {
  ALLOWED: Set<string>;
  assertAllowed(method: string): void;
  axEntries(nodes: AxNode[]): Entry[];
  entryLine(e: Entry & { options?: Opt[] }): string;
  rowTexts(nodes: AxNode[], candidates: Entry[]): string[];
  chooseTarget(
    nodes: AxNode[],
    entries: Entry[],
    re: RegExp,
    o?: { near?: RegExp; nth?: number; showable?: boolean },
  ): { pick?: Entry; several?: Entry[]; none?: boolean };
  snapshotLines(snap: unknown, o?: { marks?: boolean }): string[];
  screenPoint(
    g: {
      win: { x: number; y: number; height: number };
      viewport: { height: number };
      zoom?: number;
      frame?: number;
    },
    css: { x: number; y: number },
  ): { x: number; y: number };
  wraps(outer: number[], inner: number[]): boolean;
  hiddenElements(snap: unknown): Set<number>;
  wrapLines(lines: string[], width?: number): string[];
  newLines(before: string[], after: string[]): string[];
  dialogs(nodes: AxNode[]): { role: string; name: string; entries: Entry[] }[];
  dialogLines(ds: { role: string; name: string; entries: Entry[] }[]): string[];
  outline(nodes: AxNode[], lines: string[]): string[];
  mainFirst(nodes: AxNode[], entries: Entry[]): Entry[];
  childFrameIds(tree: FrameTree): string[];
  iframeTargets(
    list: {
      id: string;
      type: string;
      parentId?: string;
      webSocketDebuggerUrl?: string;
      url?: string;
    }[],
    pageId: string,
    o?: { max?: number },
  ): { id: string; parentId: string; tag: string }[];
  prefixNodes(nodes: AxNode[], prefix: string, tag: string): (AxNode & { frameTag: string })[];
  shiftQuad(q: number[], dx: number, dy: number): number[];
  quadOrigin(q: number[]): { x: number; y: number };
  scrollbarThickness(hits: (y: number) => Promise<boolean>, client: number): Promise<number>;
  selectInfos(snap: unknown): Map<number, SelectInfo>;
  matchOption(
    texts: string[],
    query: string,
  ): { index?: number; several?: number[]; none?: boolean };
  arrowSteps(options: Opt[], target: number): number;
  optionsText(options: Opt[]): string;
  busy(nodes: AxNode[]): boolean;
  annotate(entries: Entry[], snap: unknown, hidden: Set<number>): Entry[];
  nameUnnamed(nodes: AxNode[], entries: Entry[]): Entry[];
  textTargets(
    snap: unknown,
    re: RegExp,
    o?: { skip?: Set<number>; any?: boolean },
  ): { backendNodeId: number; name: string; clickable: boolean }[];
  sliderPoint(
    box: { x: number; y: number; w: number; h: number },
    range: { min: number; max: number; vertical?: boolean },
    want: number,
    o?: { inset?: number },
  ): { x: number; y: number };
  sliderPresses(now: number, want: number, step?: number): number;
  sliderTrack(snap: unknown, backendNodeId: number, o?: { vertical?: boolean }): number | undefined;
  fileInputs(snaps: unknown[]): { backendNodeId: number; value: string }[];
  stateDiff(a: Partial<Entry>, b: Partial<Entry>): string[];
  controlDiffs(before: Entry[], after: Entry[], o?: { skip?: string }): string[];
  closedDialogs(
    before: { role: string; name: string }[],
    after: { role: string; name: string }[],
  ): string[];
  liveTexts(nodes: AxNode[]): string[];
}
interface Opt {
  text: string;
  selected: boolean;
  disabled: boolean;
}
interface SelectInfo {
  multiple: boolean;
  size: number;
  options: Opt[];
}
interface FrameTree {
  frame: { id: string };
  childFrames?: FrameTree[];
}
const cdp = createRequire(import.meta.url)(join(files, "cdp-lib.cjs")) as CdpLib;

interface AxNode {
  nodeId: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role: { value: string };
  name?: { value: string };
  description?: { value: string };
  value?: { value: unknown };
  properties?: { name: string; value: { value: unknown } }[];
}

// A page with two product rows whose title links share a name, an image link that repeats one of them, a heading that
// repeats a link, a disabled button and a field.
function tree(): AxNode[] {
  const n = (
    nodeId: string,
    role: string,
    name: string,
    parentId?: string,
    extra: Partial<AxNode> = {},
  ): AxNode => ({
    nodeId,
    role: { value: role },
    name: { value: name },
    ...(parentId ? { parentId } : {}),
    backendDOMNodeId: Number(nodeId) + 100,
    ...extra,
  });
  const url = (u: string) => ({ properties: [{ name: "url", value: { value: u } }] });
  const nodes = [
    n("1", "RootWebArea", "Shop", undefined, { childIds: ["2", "3", "20", "30", "31"] }),
    n("2", "generic", "", "1", { childIds: ["4", "5", "6", "7"] }),
    n("3", "generic", "", "1", { childIds: ["8", "9", "10"] }),
    n("4", "link", "Honey 250 g", "2", url("https://shop.test/a")),
    n("5", "link", "Honey 250 g", "2", url("https://shop.test/a")),
    n("6", "StaticText", "Seller Alpha", "2"),
    n("7", "StaticText", "12,50 zł", "2"),
    n("8", "link", "Honey 250 g", "3", url("https://shop.test/b")),
    n("9", "StaticText", "Seller Beta", "3"),
    n("10", "StaticText", "11,90 zł", "3"),
    n("20", "heading", "Honey 250 g", "1"),
    n("30", "button", "Buy", "1", { properties: [{ name: "disabled", value: { value: true } }] }),
    n("31", "textbox", "", "1"),
  ];
  return nodes;
}

describe("desktop-web's CDP reader", () => {
  it("allows no method that enables a domain or runs script in the page", () => {
    for (const m of cdp.ALLOWED) {
      expect(m).not.toMatch(/^(Runtime|Debugger|Input|Emulation|Fetch|Target)\./);
      expect(m).not.toMatch(
        /\.enable$|addScriptToEvaluateOnNewDocument|evaluate|callFunctionOn|addBinding/i,
      );
    }
    for (const m of [
      "Runtime.enable",
      "Runtime.evaluate",
      "Page.enable",
      "DOM.enable",
      "Input.dispatchMouseEvent",
      "Page.navigate",
    ]) {
      expect(() => cdp.assertAllowed(m)).toThrow(/does not send/);
    }
  });

  it("sends only allowed methods from desktop-web", () => {
    const src = readFileSync(join(files, "desktop-web"), "utf8");
    const sent = [...src.matchAll(/\.send\(\s*"([A-Za-z]+\.[A-Za-z]+)"/g)].map((m) => m[1] ?? "");
    expect(sent.length).toBeGreaterThan(5);
    for (const m of sent) expect(cdp.ALLOWED.has(m), m).toBe(true);
    // Every message goes through connect's guarded send; nothing else opens a socket or calls Runtime.
    const code = src.replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/new WebSocket|Runtime\./);
  });

  it("lists clickable elements and named headings with refs, without duplicates of link names, disabled ones marked", () => {
    const lines = cdp.axEntries(tree()).map((e) => cdp.entryLine(e));
    expect(lines).toEqual([
      '[e104] link "Honey 250 g"',
      '[e105] link "Honey 250 g"',
      '[e108] link "Honey 250 g"',
      '[e130] button "Buy" disabled',
      '[e131] textbox ""',
    ]);
  });

  it("shows a field's required and invalid state and its error description", () => {
    const prop = (name: string, v: unknown) => ({ name, value: { value: v } });
    const nodes: AxNode[] = [
      {
        nodeId: "1",
        role: { value: "textbox" },
        name: { value: "Phone" },
        description: { value: "Enter a valid phone number" },
        backendDOMNodeId: 7,
        properties: [prop("required", true), prop("invalid", "true")],
      },
      {
        nodeId: "2",
        role: { value: "textbox" },
        name: { value: "Zip" },
        backendDOMNodeId: 8,
        properties: [prop("invalid", "false"), prop("readonly", true)],
      },
    ];
    expect(cdp.axEntries(nodes).map((e) => cdp.entryLine(e))).toEqual([
      '[e7] textbox "Phone" required invalid desc="Enter a valid phone number"',
      '[e8] textbox "Zip" readonly',
    ]);
  });

  it("gives each same-named link its row text and picks one by --near", () => {
    const nodes = tree();
    const entries = cdp.axEntries(nodes);
    const r = cdp.chooseTarget(nodes, entries, /honey/i);
    expect(r.several?.map((e) => e.ref)).toEqual(["e104", "e108"]);
    expect(cdp.rowTexts(nodes, r.several ?? [])).toEqual([
      "Seller Alpha 12,50 zł",
      "Seller Beta 11,90 zł",
    ]);
    expect(cdp.chooseTarget(nodes, entries, /honey/i, { near: /beta/i }).pick?.ref).toBe("e108");
    expect(cdp.chooseTarget(nodes, entries, /honey/i, { nth: 1 }).pick?.ref).toBe("e104");
    expect(cdp.chooseTarget(nodes, entries, /honey/i, { near: /gamma/i }).none).toBe(true);
    expect(cdp.chooseTarget(nodes, entries, /cart/i).none).toBe(true);
  });

  it("treats matches that lead to one URL as one", () => {
    const nodes = tree().filter((n) => n.nodeId !== "8");
    expect(cdp.chooseTarget(nodes, cdp.axEntries(nodes), /honey/i).pick?.ref).toBe("e104");
  });

  it("lists named pictures apart even with one source, but not those a link holds or names", () => {
    const img = (id: string, name: string, parentId: string, src: string): AxNode => ({
      nodeId: id,
      parentId,
      role: { value: "image" },
      name: { value: name },
      backendDOMNodeId: Number(id) + 100,
      properties: [{ name: "url", value: { value: src } }],
    });
    const nodes: AxNode[] = [
      {
        nodeId: "1",
        role: { value: "RootWebArea" },
        name: { value: "Hovers" },
        childIds: ["2", "3", "4", "5"],
      },
      img("2", "User Avatar", "1", "https://t.test/avatar.jpg"),
      img("3", "User Avatar", "1", "https://t.test/avatar.jpg"),
      img("4", "User Avatar", "1", "https://t.test/avatar.jpg"),
      {
        nodeId: "5",
        parentId: "1",
        role: { value: "link" },
        name: { value: "Honey" },
        backendDOMNodeId: 105,
        childIds: ["6"],
      },
      img("6", "Jar", "5", "https://t.test/jar.jpg"),
      img("7", "Honey", "1", "https://t.test/honey.jpg"),
    ];
    const entries = cdp.axEntries(nodes);
    expect(entries.map((e) => cdp.entryLine(e))).toEqual([
      '[e102] image "User Avatar"',
      '[e103] image "User Avatar"',
      '[e104] image "User Avatar"',
      '[e105] link "Honey"',
    ]);
    expect(cdp.chooseTarget(nodes, entries, /avatar/i, { showable: true }).several?.length).toBe(3);
    expect(cdp.chooseTarget(nodes, entries, /avatar/i, { nth: 2, showable: true }).pick?.ref).toBe(
      "e103",
    );
    expect(cdp.chooseTarget(nodes, entries, /avatar/i).none).toBe(true);
  });

  // A DOMSnapshot document from a list of nodes: parent index, type (1 element, 3 text), tag, text, styles
  // [display, visibility, opacity] and bounds [x, y, w, h]. Nodes without a box get no layout entry.
  interface N {
    parent: number;
    type: number;
    tag?: string;
    text?: string;
    style?: [string, string, string];
    box?: [number, number, number, number];
    attrs?: Record<string, string>;
    picked?: boolean;
  }
  function snapOf(ns: N[]) {
    const strings: string[] = [];
    const at = (v: string) => {
      const i = strings.indexOf(v);
      return i >= 0 ? i : strings.push(v) - 1;
    };
    const layout = {
      nodeIndex: [] as number[],
      styles: [] as number[][],
      bounds: [] as number[][],
    };
    ns.forEach((n, i) => {
      if (!n.box) return;
      layout.nodeIndex.push(i);
      layout.styles.push((n.style ?? ["inline", "visible", "1"]).map(at));
      layout.bounds.push(n.box);
    });
    return {
      strings,
      documents: [
        {
          nodes: {
            parentIndex: ns.map((n) => n.parent),
            nodeType: ns.map((n) => n.type),
            nodeName: ns.map((n) => at(n.tag ?? (n.type === 3 ? "#text" : "SPAN"))),
            nodeValue: ns.map((n) => (n.text === undefined ? -1 : at(n.text))),
            backendNodeId: ns.map((_, i) => 1000 + i),
            // attribute names and values as string indexes; an empty value is -1, as Chrome sends it
            attributes: ns.map((n) =>
              Object.entries(n.attrs ?? {}).flatMap(([k, v]) => [at(k), v === "" ? -1 : at(v)]),
            ),
            optionSelected: { index: ns.flatMap((n, i) => (n.picked ? [i] : [])) },
          },
          layout,
        },
      ],
    };
  }
  const BLOCKSTYLE: [string, string, string] = ["block", "visible", "1"];
  const doc = { parent: -1, type: 9, tag: "#document" };
  const div = {
    parent: 0,
    type: 1,
    tag: "DIV",
    style: BLOCKSTYLE,
    box: [0, 0, 400, 100] as [number, number, number, number],
  };
  const t = (text: string, box: [number, number, number, number], parent = 1): N => ({
    parent,
    type: 3,
    text,
    box,
  });

  it("joins text that touches and spaces text that stands apart, from layout alone", () => {
    expect(
      cdp.snapshotLines(snapOf([doc, div, t("145", [0, 0, 30, 16]), t(",95 zł", [30, 0, 40, 16])])),
    ).toEqual(["145,95 zł"]);
    expect(
      cdp.snapshotLines(
        snapOf([doc, div, t("293,55 zł", [0, 0, 60, 16]), t("cena", [70, 0, 30, 16])]),
      ),
    ).toEqual(["293,55 zł cena"]);
    expect(
      cdp.snapshotLines(
        snapOf([doc, div, t("first", [0, 0, 40, 16]), t("second", [0, 20, 50, 16])]),
      ),
    ).toEqual(["first second"]);
    const br = {
      parent: 1,
      type: 1,
      tag: "BR",
      box: [40, 0, 0, 16] as [number, number, number, number],
    };
    expect(
      cdp.snapshotLines(snapOf([doc, div, t("a", [0, 0, 40, 16]), br, t("b", [40, 0, 10, 16])])),
    ).toEqual(["a b"]);
  });

  it("leaves out text and elements a person cannot see", () => {
    const faded = {
      parent: 1,
      type: 1,
      tag: "SPAN",
      style: ["inline", "visible", "0"] as [string, string, string],
      box: [0, 40, 50, 16] as [number, number, number, number],
    };
    const snap = snapOf([
      doc,
      div,
      t("shown", [0, 0, 40, 16]),
      t("sr-only", [0, 20, 1, 1]),
      t("offscreen", [-10000, 20, 60, 16]),
      faded,
      t("faded", [0, 40, 50, 16], 5),
      {
        parent: 1,
        type: 3,
        text: "invisible",
        style: ["inline", "hidden", "1"],
        box: [60, 0, 40, 16],
      },
    ]);
    expect(cdp.snapshotLines(snap)).toEqual(["shown"]);
    const hidden = cdp.hiddenElements(snap);
    expect(hidden.has(1005)).toBe(true); // the opacity-0 span
    expect(hidden.has(1001)).toBe(false); // the visible block
  });

  it("leaves out text cut away by overflow hidden or a clip rect, and keeps what scrolls or escapes", () => {
    type St = [string, string, string, string, string, string, string];
    const st = (position: string, overflow: string, clip = "auto"): St => [
      "block",
      "visible",
      "1",
      position,
      overflow,
      overflow,
      clip,
    ];
    const box = (x: number, y: number, w: number, h: number): [number, number, number, number] => [
      x,
      y,
      w,
      h,
    ];
    const el = (parent: number, style: St, b: [number, number, number, number]) => ({
      parent,
      type: 1,
      tag: "DIV",
      style: style as unknown as [string, string, string],
      box: b,
    });
    const snap = snapOf([
      doc, // 0
      el(0, st("static", "visible"), box(0, 0, 400, 300)), // 1 page
      el(1, st("static", "hidden"), box(0, 0, 100, 0)), // 2 collapsed: overflow hidden, no height
      t("collapsed", [0, 0, 80, 16], 2),
      el(1, st("absolute", "hidden", "rect(0px, 0px, 0px, 0px)"), box(0, 50, 1, 1)), // 4 sr-only
      t("screen reader", [0, 50, 90, 16], 4),
      el(1, st("static", "auto"), box(0, 100, 100, 20)), // 6 scrollable: its content is one scroll away
      t("scrollable", [0, 130, 80, 16], 6),
      el(1, st("static", "hidden"), box(0, 150, 100, 0)), // 8 hidden box that an absolute child escapes
      { ...el(8, st("absolute", "visible"), box(0, 160, 90, 16)), tag: "DIV" }, // 9
      t("escapes", [0, 160, 80, 16], 9),
      t("visible", [0, 200, 80, 16]),
    ]);
    expect(cdp.snapshotLines(snap)).toEqual(["scrollable", "escapes", "visible"]);
  });

  it("finds the frames of a page: same-process ones from the frame tree, others from the target list", () => {
    expect(
      cdp.childFrameIds({
        frame: { id: "root" },
        childFrames: [
          { frame: { id: "a" }, childFrames: [{ frame: { id: "b" } }] },
          { frame: { id: "c" } },
        ],
      }),
    ).toEqual(["a", "b", "c"]);
    const ws = "ws://127.0.0.1:1/x";
    const list = [
      { id: "PAGE", type: "page", webSocketDebuggerUrl: ws },
      { id: "N2", type: "iframe", parentId: "N1", webSocketDebuggerUrl: ws },
      { id: "N1", type: "iframe", parentId: "PAGE", webSocketDebuggerUrl: ws },
      { id: "OTHER", type: "iframe", parentId: "ELSEWHERE", webSocketDebuggerUrl: ws },
      { id: "WORKER", type: "service_worker", parentId: "PAGE", webSocketDebuggerUrl: ws },
    ];
    const found = cdp.iframeTargets(list, "PAGE");
    expect(found.map((f) => f.id)).toEqual(["N1", "N2"]); // nested ones follow their holder; others are not this page's
    expect(found[0]?.tag).toBe("N1");
    expect(cdp.iframeTargets(list, "PAGE", { max: 1 })).toHaveLength(1);
  });

  it("gives an iframe's accessibility nodes their own ids and refs", () => {
    const nodes = cdp.prefixNodes(tree(), "AB12", "AB12");
    expect(nodes[0]?.nodeId).toBe("AB121");
    expect(nodes[0]?.childIds?.[0]).toBe("AB122");
    expect(nodes[1]?.parentId).toBe("AB121");
    const [first] = cdp.axEntries(nodes);
    expect(first?.ref).toBe("e104@AB12");
    expect(cdp.axEntries(tree())[0]?.ref).toBe("e104");
  });

  it("places a frame's boxes in the page", () => {
    const q = [10, 20, 30, 20, 30, 40, 10, 40];
    expect(cdp.quadOrigin(q)).toEqual({ x: 10, y: 20 });
    expect(cdp.shiftQuad(q, 100, 200)).toEqual([110, 220, 130, 220, 130, 240, 110, 240]);
  });

  it("measures a horizontal scrollbar from where hit testing stops", async () => {
    // Hit testing covers the page area including the scrollbar: clientHeight 637 of 652 means 15 px of bar.
    const reaches = (bottom: number) => (y: number) => Promise.resolve(y < bottom);
    expect(await cdp.scrollbarThickness(reaches(652), 637)).toBe(15);
    expect(await cdp.scrollbarThickness(reaches(637), 637)).toBe(0);
    expect(await cdp.scrollbarThickness(reaches(522), 520.5)).toBeCloseTo(1.5, 5);
    expect(await cdp.scrollbarThickness(() => Promise.resolve(false), 637)).toBe(0);
  });

  it("wraps long blocks into lines and reports only what an action added", () => {
    const long = `${"word ".repeat(60)}end`;
    const wrapped = cdp.wrapLines(["short", long], 100);
    expect(wrapped[0]).toBe("short");
    expect(wrapped.length).toBeGreaterThan(3);
    expect(wrapped.every((l) => l.length <= 100)).toBe(true);
    expect(wrapped.join(" ")).toBe(`short ${long}`);
    expect(cdp.newLines(["a", "b"], ["a", "b", "c", "c", "d"])).toEqual(["c", "d"]);
  });

  it("maps a viewport point to the screen below the toolbar and inside the frame", () => {
    const g = { win: { x: 0, y: 0, height: 800 }, viewport: { height: 650 }, frame: 4 };
    expect(cdp.screenPoint(g, { x: 100, y: 10 })).toEqual({ x: 104, y: 156 });
    expect(cdp.screenPoint({ ...g, zoom: 2, viewport: { height: 300 } }, { x: 10, y: 10 })).toEqual(
      { x: 24, y: 216 },
    );
  });

  it("counts only a slightly larger box around the element as a wrapper, not a dialog's text over it", () => {
    const box = (l: number, t: number, r: number, b: number) => [l, t, r, t, r, b, l, b];
    const link = box(100, 100, 300, 120);
    expect(cdp.wraps(box(98, 98, 302, 130), link)).toBe(true);
    expect(cdp.wraps(box(150, 105, 200, 115), link)).toBe(false); // smaller text under the point: covered
    expect(cdp.wraps(box(0, 0, 1280, 800), link)).toBe(false); // a full-page layer
  });

  it("reports an open dialog with the elements in it, in any language", () => {
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      parentId?: string,
      extra: Partial<AxNode> = {},
    ): AxNode => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      ...(parentId ? { parentId } : {}),
      backendDOMNodeId: Number(nodeId) + 100,
      ...extra,
    });
    const nodes = [
      ax("1", "RootWebArea", "Page", undefined, { childIds: ["2", "5"] }),
      ax("2", "dialog", "Prywatność", "1", { childIds: ["3", "4"] }),
      ax("3", "button", "Zgadzam się", "2"),
      ax("4", "button", "Ustawienia", "2"),
      ax("5", "main", "", "1", { childIds: ["6"] }),
      ax("6", "link", "Item", "5"),
    ];
    const ds = cdp.dialogs(nodes);
    expect(ds).toHaveLength(1);
    expect(cdp.dialogLines(ds)).toEqual([
      'open dialog "Prywatność" (act on it first):',
      '  [e103] button "Zgadzam się"',
      '  [e104] button "Ustawienia"',
    ]);
    expect(cdp.mainFirst(nodes, cdp.axEntries(nodes)).map((e) => e.ref)).toEqual([
      "e106",
      "e103",
      "e104",
    ]);
    expect(cdp.dialogs(nodes.filter((n) => n.nodeId !== "2"))).toEqual([]);
  });

  it("outlines headings with the text line they start at", () => {
    const nodes: AxNode[] = [
      {
        nodeId: "1",
        role: { value: "heading" },
        name: { value: "Results" },
        properties: [{ name: "level", value: { value: 1 } }],
      },
      {
        nodeId: "2",
        role: { value: "heading" },
        name: { value: "Filters" },
        properties: [{ name: "level", value: { value: 2 } }],
      },
    ];
    expect(cdp.outline(nodes, ["nav", "Results for honey", "x", "Filters"])).toEqual([
      "2: # Results",
      "4: ## Filters",
    ]);
  });

  it("lists a select's options with their state, from the layout snapshot", () => {
    const snap = snapOf([
      doc, // 0
      { parent: 0, type: 1, tag: "SELECT", style: BLOCKSTYLE, box: [0, 0, 100, 20] }, // 1
      { parent: 1, type: 1, tag: "OPTION" }, // 2
      { parent: 2, type: 3, text: "Pick one" },
      { parent: 1, type: 1, tag: "OPTION", attrs: { disabled: "" } }, // 4
      { parent: 4, type: 3, text: "Off" },
      { parent: 1, type: 1, tag: "OPTGROUP", attrs: { disabled: "" } }, // 6
      { parent: 6, type: 1, tag: "OPTION" }, // 7
      { parent: 7, type: 3, text: "In  a dead\n group" },
      { parent: 1, type: 1, tag: "OPTION", picked: true, attrs: { label: "Shown label" } }, // 9
      { parent: 9, type: 3, text: "ignored text" },
      { parent: 1, type: 1, tag: "OPTION", attrs: { hidden: "" } }, // 11
      { parent: 11, type: 3, text: "Hidden" },
      { parent: 0, type: 1, tag: "SELECT", attrs: { multiple: "", size: "4" } }, // 13
    ]);
    const infos = cdp.selectInfos(snap);
    expect(infos.get(1001)).toEqual({
      multiple: false,
      size: 0,
      options: [
        { text: "Pick one", selected: false, disabled: false },
        { text: "Off", selected: false, disabled: true },
        { text: "In a dead group", selected: false, disabled: true },
        { text: "Shown label", selected: true, disabled: false },
        { text: "Hidden", selected: false, disabled: true },
      ],
    });
    expect(infos.get(1013)).toMatchObject({ multiple: true, size: 4 });
  });

  it("matches an option by exact text, then ignoring case, then as a regex, and lists ambiguity", () => {
    const texts = ["Option 1", "option 10", "Fifth Choice", "Option 3"];
    expect(cdp.matchOption(texts, "Option 1")).toEqual({ index: 0 });
    expect(cdp.matchOption(texts, "OPTION 3")).toEqual({ index: 3 });
    expect(cdp.matchOption(texts, "^fifth")).toEqual({ index: 2 });
    expect(cdp.matchOption(texts, "Option")).toEqual({ several: [0, 1, 3] });
    expect(cdp.matchOption(texts, "zebra")).toEqual({ none: true });
    expect(cdp.matchOption(["a", "A"], "a")).toEqual({ index: 0 }); // exact before case-insensitive
    expect(cdp.matchOption(["(x", "y"], "(x")).toEqual({ index: 0 }); // not a valid regex: still the text
  });

  it("counts arrow presses over enabled options only, from the selected one", () => {
    const o = (text: string, selected = false, disabled = false): Opt => ({
      text,
      selected,
      disabled,
    });
    const opts = [o("Pick", true), o("One"), o("Off", false, true), o("Three"), o("Four")];
    expect(cdp.arrowSteps(opts, 3)).toBe(2); // One, then Three: the disabled one is skipped
    expect(cdp.arrowSteps(opts, 4)).toBe(3);
    expect(cdp.arrowSteps(opts, 0)).toBe(0);
    const later = [o("Pick"), o("One"), o("Off", false, true), o("Three", true), o("Four")];
    expect(cdp.arrowSteps(later, 1)).toBe(-1);
    expect(cdp.arrowSteps(later, 4)).toBe(1);
    expect(cdp.arrowSteps([o("A"), o("B")], 1)).toBe(1); // nothing selected: counts from the first
  });

  it("shows a select's options in its snap line, cut to a few and said so", () => {
    const e = {
      ref: "e11",
      backendNodeId: 11,
      nodeId: "1",
      role: "combobox",
      name: "Size",
      value: "B",
      options: ["A", "B", "C (x)"].map((text) => ({
        text,
        selected: text === "B",
        disabled: text.startsWith("C"),
      })),
    };
    expect(cdp.entryLine(e)).toBe(
      '[e11] combobox "Size" value="B" options: A | B | C (x) (disabled)',
    );
    const many = Array.from({ length: 30 }, (_, i) => ({
      text: `Choice ${String(i)}`,
      selected: false,
      disabled: false,
    }));
    const line = cdp.optionsText(many);
    expect(line).toMatch(/\| \(\+\d+ more\)$/);
    expect(line.length).toBeLessThan(260);
  });

  it("knows a page that is still working from a progress bar or a busy element", () => {
    const n = (
      role: string,
      props: { name: string; value: { value: unknown } }[] = [],
      ignored = false,
    ): AxNode => ({
      nodeId: role,
      role: { value: role },
      properties: props,
      ignored,
    });
    expect(cdp.busy([n("button"), n("progressbar")])).toBe(true);
    expect(cdp.busy([n("main", [{ name: "busy", value: { value: true } }])])).toBe(true);
    expect(
      cdp.busy([
        n("main", [{ name: "busy", value: { value: false } }]),
        n("progressbar", [], true),
      ]),
    ).toBe(false);
  });

  it("marks nameless pictures inline only when asked, from their markup", () => {
    const box = (x: number, y: number, w: number, h: number): [number, number, number, number] => [
      x,
      y,
      w,
      h,
    ];
    const inline = ["inline-block", "visible", "1"] as [string, string, string];
    const nodes: N[] = [
      doc, // 0
      { parent: 0, type: 1, tag: "DIV", style: BLOCKSTYLE, box: box(0, 0, 400, 200) }, // 1 page
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: box(0, 0, 400, 16) }, // 2
      t("Rating", box(0, 0, 40, 16), 2), // 3
      // a block of empty icons: one mark for the block, from its own class words, not one per icon
      {
        parent: 1,
        type: 1,
        tag: "P",
        style: BLOCKSTYLE,
        box: box(0, 20, 400, 16),
        attrs: { class: "star-rating Three" },
      }, // 4
      {
        parent: 4,
        type: 1,
        tag: "I",
        style: inline,
        box: box(0, 20, 14, 14),
        attrs: { class: "icon-star" },
      }, // 5
      {
        parent: 4,
        type: 1,
        tag: "I",
        style: inline,
        box: box(16, 20, 14, 14),
        attrs: { class: "icon-star" },
      }, // 6
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: box(0, 40, 400, 20) }, // 7
      t("status", box(0, 40, 40, 16), 7), // 8
      // an inline icon in a line of text: a generated class name says nothing, the data attribute does
      {
        parent: 7,
        type: 1,
        tag: "SPAN",
        style: inline,
        box: box(45, 40, 12, 12),
        attrs: { class: "x1a2b3c4d5 dot", "data-state": "up" },
      }, // 9
      t("fine", box(60, 40, 30, 16), 7), // 10
      {
        parent: 7,
        type: 1,
        tag: "IMG",
        style: inline,
        box: box(95, 40, 40, 20),
        attrs: { src: "/img/brand-mark.png?v=2" },
      }, // 11
      {
        parent: 7,
        type: 1,
        tag: "IMG",
        style: inline,
        box: box(140, 40, 40, 20),
        attrs: { src: "/a.png", alt: "Logo" },
      }, // 12 has a name
      {
        parent: 7,
        type: 1,
        tag: "SPAN",
        style: inline,
        box: box(190, 40, 1, 1),
        attrs: { class: "speck" },
      }, // 13 too small to see
      {
        parent: 7,
        type: 1,
        tag: "INPUT",
        style: inline,
        box: box(200, 40, 80, 16),
        attrs: { class: "field" },
      }, // 14 a control
    ];
    expect(cdp.snapshotLines(snapOf(nodes))).toEqual(["Rating", "status fine"]);
    expect(cdp.snapshotLines(snapOf(nodes), { marks: true })).toEqual([
      "Rating",
      "‹star-rating Three›",
      "status ‹dot state=up› fine ‹src:brand-mark.png›",
    ]);
  });

  // Elements for annotate and textTargets: [display, visibility, opacity, position, overflow-x, overflow-y, clip, cursor].
  const sty = (display: string, opacity = "1", cursor = "auto") =>
    [display, "visible", opacity, "static", "visible", "visible", "auto", cursor] as unknown as [
      string,
      string,
      string,
    ];
  const el = (
    parent: number,
    tag: string,
    style: [string, string, string],
    box: [number, number, number, number],
    attrs?: Record<string, string>,
  ): N => ({ parent, type: 1, tag, style, box, ...(attrs ? { attrs } : {}) });

  it("keeps a hidden checkbox whose label a person sees, clicked through the label, and drops a honeypot", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 400, 200]), // 1
      el(1, "LABEL", sty("block", "1", "pointer"), [0, 0, 200, 20]), // 2 label around its input
      el(2, "INPUT", sty("inline-block", "0"), [0, 0, 14, 14], { type: "checkbox" }), // 3
      t("Very good: 8+", [20, 0, 90, 16], 2), // 4
      el(1, "INPUT", sty("inline-block", "0"), [0, 30, 14, 14], { type: "checkbox", id: "s" }), // 5
      el(1, "LABEL", sty("block"), [0, 30, 200, 20], { for: "s" }), // 6 label tied by for=
      t("Superb", [20, 30, 60, 16], 6), // 7
      el(1, "INPUT", sty("inline-block", "0"), [0, 60, 14, 14], { type: "checkbox" }), // 8 honeypot
      el(1, "INPUT", sty("inline-block"), [0, 90, 200, 20], {
        placeholder: "Where are you going?",
        type: "password",
      }), // 9
    ]);
    const hidden = cdp.hiddenElements(snap);
    expect(hidden.has(1003) && hidden.has(1005) && hidden.has(1008)).toBe(true);
    const e = (id: number, role: string, name: string): Entry => ({
      ref: `e${String(id)}`,
      backendNodeId: id,
      nodeId: String(id),
      role,
      name,
    });
    const out = cdp.annotate(
      [
        e(1003, "checkbox", "Very good: 8+"),
        e(1005, "checkbox", "Superb"),
        e(1008, "checkbox", "Trap"),
        e(1009, "textbox", "Destination"),
      ],
      snap,
      hidden,
    );
    expect(out.map((x) => [x.ref, x.via])).toEqual([
      ["e1003", 1002],
      ["e1005", 1006],
      ["e1009", undefined],
    ]);
    expect(cdp.entryLine(out[2] as Entry)).toBe(
      '[e1009] textbox "Destination" placeholder="Where are you going?"',
    );
  });

  it("names a nameless control from its markup, else from its row, and drops one with neither", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "BUTTON", sty("inline-block"), [0, 0, 30, 30], { class: "tool mode-car" }), // 1
      el(0, "BUTTON", sty("inline-block"), [40, 0, 30, 30]), // 2
      el(2, "SPAN", sty("inline-block"), [45, 5, 16, 16], { class: "icon icon-bike" }), // 3
      el(0, "INPUT", sty("inline-block"), [0, 40, 100, 20]), // 4
      el(0, "BUTTON", sty("inline-block"), [0, 80, 30, 30], { class: "x1a2b3c4d5" }), // 5
      el(0, "INPUT", sty("inline-block"), [0, 120, 14, 14], {
        type: "radio",
        value: "car",
        class: "btn-check",
      }), // 6
    ]);
    const e = (id: number, role: string, name: string, nodeId: string): Entry => ({
      ref: `e${String(id)}`,
      backendNodeId: id,
      nodeId,
      role,
      name,
    });
    const entries = cdp.annotate(
      [
        e(1001, "button", "", "b1"),
        e(1002, "button", "", "b2"),
        e(1004, "combobox", "", "c"),
        e(1005, "button", "", "b3"),
        e(1006, "radio", "", "r"),
      ],
      snap,
      new Set(),
    );
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      parentId?: string,
      kids?: string[],
    ) => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      ...(parentId ? { parentId } : {}),
      ...(kids ? { childIds: kids } : {}),
    });
    const nodes: AxNode[] = [
      ax("root", "RootWebArea", "", undefined, ["tools", "row", "b3", "r"]),
      ax("tools", "generic", "", "root", ["b1", "b2"]),
      ax("b1", "button", "", "tools"),
      ax("b2", "button", "", "tools"),
      ax("row", "generic", "", "root", ["lbl", "c"]),
      ax("lbl", "StaticText", "State", "row"),
      ax("c", "combobox", "", "row"),
      ax("b3", "button", "", "root"),
      ax("r", "radio", "", "root"),
    ];
    const named = cdp.nameUnnamed(nodes, entries);
    expect(named.map((x) => cdp.entryLine(x))).toEqual([
      "[e1001] button ‹tool mode-car›",
      '[e1002] button "" ‹icon icon-bike›',
      '[e1004] combobox "" near "State"',
      "[e1006] radio ‹value=car btn-check›",
    ]);
    expect(cdp.chooseTarget(nodes, named, /bike/i).pick?.ref).toBe("e1002");
    expect(cdp.chooseTarget(nodes, named, /state/i).pick?.ref).toBe("e1004");
  });

  it("finds clickable text no element is named by, but not a link's own text or text a person cannot see", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 400, 300]), // 1
      el(1, "DIV", sty("block", "1", "pointer"), [0, 0, 300, 20]), // 2 a role-less option
      t("Ultra HD 3840 x 2160", [0, 0, 150, 16], 2), // 3
      el(1, "DIV", sty("block"), [0, 30, 300, 20]), // 4 plain text
      t("Ultra HD explained", [0, 30, 150, 16], 4), // 5
      el(1, "A", sty("block", "1", "pointer"), [0, 60, 300, 20]), // 6 a listed link
      t("Ultra HD offers", [0, 60, 150, 16], 6), // 7
      el(1, "DIV", sty("block", "0", "pointer"), [0, 90, 300, 20]), // 8 transparent
      t("Ultra HD trap", [0, 90, 150, 16], 8), // 9
    ]);
    expect(cdp.textTargets(snap, /ultra hd/i, { skip: new Set([1006]) })).toEqual([
      { backendNodeId: 1002, name: "Ultra HD 3840 x 2160", clickable: true },
    ]);
    // what a drag picks up or drops on needs no click listener: with `any` plain visible text counts, marked so
    expect(cdp.textTargets(snap, /ultra hd/i, { skip: new Set([1006]), any: true })).toEqual([
      { backendNodeId: 1002, name: "Ultra HD 3840 x 2160", clickable: true },
      { backendNodeId: 1004, name: "Ultra HD explained", clickable: false },
    ]);
    // a click listener (isClickable) counts like the cursor
    const plain = snapOf([
      doc,
      el(0, "DIV", sty("block"), [0, 0, 300, 20]),
      t("4K", [0, 0, 20, 16], 1),
    ]);
    expect(cdp.textTargets(plain, /4K/)).toEqual([]);
    const doc0 = (plain as { documents: { nodes: Record<string, unknown> }[] }).documents[0];
    if (doc0) doc0.nodes.isClickable = { index: [1] };
    expect(cdp.textTargets(plain, /4K/)).toEqual([
      { backendNodeId: 1001, name: "4K", clickable: true },
    ]);
  });

  it("reports state changes, closed dialogs and new alert text", () => {
    const e = (ref: string, role: string, name: string, extra: Partial<Entry> = {}): Entry => ({
      ref,
      backendNodeId: 1,
      nodeId: ref,
      role,
      name,
      ...extra,
    });
    expect(cdp.stateDiff({ checked: "false" }, { checked: "true" })).toEqual([
      "checked false -> true",
    ]);
    expect(cdp.stateDiff({ value: "a", name: "Show" }, { value: "b", name: "Show" })).toEqual([
      'value "a" -> "b"',
    ]);
    expect(
      cdp.controlDiffs(
        [
          e("e1", "radio", "Male", { checked: "true" }),
          e("e2", "radio", "Female", { checked: "false" }),
        ],
        [
          e("e1", "radio", "Male", { checked: "false" }),
          e("e2", "radio", "Female", { checked: "true" }),
        ],
        { skip: "e2" },
      ),
    ).toEqual(['[e1] radio "Male": checked true -> false']);
    expect(
      cdp.closedDialogs(
        [
          { role: "dialog", name: "Cookies" },
          { role: "dialog", name: "Sign in" },
        ],
        [{ role: "dialog", name: "Sign in" }],
      ),
    ).toEqual(['dialog "Cookies"']);
    const nodes: AxNode[] = [
      { nodeId: "1", role: { value: "alert" }, name: { value: "" }, childIds: ["2"] },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "StaticText" },
        name: { value: "Email is required" },
      },
      { nodeId: "3", role: { value: "status" }, name: { value: "3 results" } },
    ];
    expect(cdp.liveTexts(nodes)).toEqual(['alert "Email is required"', 'status "3 results"']);
  });

  it("matches a field by its placeholder", () => {
    const f: Entry = {
      ref: "e1",
      backendNodeId: 1,
      nodeId: "1",
      role: "textbox",
      name: "Enter destination",
      placeholder: "Where are you going?",
    };
    expect(cdp.chooseTarget([], [f], /where/i).pick?.ref).toBe("e1");
  });

  it("lists a slider with its value and range, and a file input with how to fill it", () => {
    const prop = (name: string, v: unknown) => ({ name, value: { value: v } });
    const nodes: AxNode[] = [
      {
        nodeId: "1",
        role: { value: "slider" },
        name: { value: "Volume" },
        backendDOMNodeId: 11,
        value: { value: 25 },
        properties: [prop("valuemin", 0), prop("valuemax", 100), prop("valuetext", "25")],
      },
      {
        nodeId: "2",
        role: { value: "slider" },
        name: { value: "Rating" },
        backendDOMNodeId: 12,
        value: { value: 2 },
        properties: [
          prop("valuemin", 0),
          prop("valuemax", 5),
          prop("valuetext", "2 stars"),
          prop("orientation", "vertical"),
        ],
      },
    ];
    expect(cdp.axEntries(nodes).map((e) => cdp.entryLine(e))).toEqual([
      '[e11] slider "Volume" value=25 min=0 max=100',
      '[e12] slider "Rating" value=2 "2 stars" min=0 max=5 vertical',
    ]);
    const snap = snapOf([
      doc,
      el(0, "INPUT", sty("inline-block"), [0, 0, 200, 20], { type: "file" }),
    ]);
    const [file] = cdp.annotate(
      [{ ref: "e1001", backendNodeId: 1001, nodeId: "1", role: "button", name: "Resume" }],
      snap,
      new Set(),
    );
    expect(cdp.entryLine(file as Entry)).toBe(
      '[e1001] button "Resume" (file input: desktop-web upload)',
    );
  });

  it("aims a slider press at the value's proportional point and counts the arrow presses left", () => {
    const box = { x: 100, y: 50, w: 220, h: 20 };
    // a native range: the thumb travels inside half a thumb from each end
    expect(cdp.sliderPoint(box, { min: 0, max: 100 }, 0)).toEqual({ x: 110, y: 60 });
    expect(cdp.sliderPoint(box, { min: 0, max: 100 }, 75)).toEqual({ x: 260, y: 60 });
    expect(cdp.sliderPoint(box, { min: 0, max: 100 }, 500)).toEqual({ x: 310, y: 60 });
    expect(cdp.sliderPoint(box, { min: 0, max: 10 }, 5, { inset: 0 })).toEqual({ x: 210, y: 60 });
    // vertical: the bottom is the minimum
    const tall = { x: 0, y: 0, w: 20, h: 220 };
    expect(cdp.sliderPoint(tall, { min: 0, max: 100, vertical: true }, 0)).toEqual({
      x: 10,
      y: 210,
    });
    expect(cdp.sliderPoint(tall, { min: 0, max: 100, vertical: true }, 100)).toEqual({
      x: 10,
      y: 10,
    });
    // the first press learns the step; then as many as the distance needs; none when a step would overshoot more
    expect(cdp.sliderPresses(70, 75, undefined)).toBe(1);
    expect(cdp.sliderPresses(80, 75, undefined)).toBe(-1);
    expect(cdp.sliderPresses(71, 75, 1)).toBe(4);
    expect(cdp.sliderPresses(75, 73, 5)).toBe(0);
    expect(cdp.sliderPresses(70, 73, 5)).toBe(1);
    expect(cdp.sliderPresses(75, 75, 1)).toBe(0);
    expect(cdp.sliderPresses(0, 10000, 1)).toBe(200);
  });

  it("finds the track of a slider drawn as a thumb alone, not of one that is its own track", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 600, 200]), // 1
      el(1, "DIV", sty("block"), [20, 100, 300, 8]), // 2 the track
      el(2, "DIV", sty("block"), [110, 94, 20, 20]), // 3 the thumb (role slider)
      el(1, "INPUT", sty("inline-block"), [20, 150, 300, 20], { type: "range" }), // 4 a native range
    ]);
    expect(cdp.sliderTrack(snap, 1003)).toBe(1002);
    expect(cdp.sliderTrack(snap, 1004)).toBeUndefined();
  });

  it("reads which file inputs hold a file, shown or not", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "INPUT", sty("inline-block"), [0, 0, 200, 20], { type: "file" }), // 1
      { parent: 0, type: 1, tag: "INPUT", attrs: { type: "FILE" } }, // 2 display:none, behind a button
      el(0, "INPUT", sty("inline-block"), [0, 30, 200, 20], { type: "text" }), // 3
    ]);
    const d = snap as { strings: string[]; documents: { nodes: Record<string, unknown> }[] };
    const nodes = d.documents[0]?.nodes;
    if (nodes)
      nodes.inputValue = {
        index: [2, 3],
        value: [d.strings.push("C:\\fakepath\\x.txt") - 1, d.strings.push("hi") - 1],
      };
    expect(cdp.fileInputs([snap])).toEqual([
      { backendNodeId: 1001, value: "" },
      { backendNodeId: 1002, value: "C:\\fakepath\\x.txt" },
    ]);
  });

  it("drops a button that repeats a matching link's name, but lists a different button", () => {
    const e = (ref: string, role: string, name: string): Entry => ({
      ref,
      backendNodeId: Number(ref.slice(1)),
      nodeId: ref,
      role,
      name,
    });
    const nodes: AxNode[] = [];
    const companion = [
      e("e1", "link", "Honey 250 g"),
      e("e2", "button", "Add Honey 250 g to cart"),
    ];
    expect(cdp.chooseTarget(nodes, companion, /honey/i).pick?.ref).toBe("e1");
    const real = [e("e1", "link", "Honey offers"), e("e3", "button", "Honey filter")];
    expect(cdp.chooseTarget(nodes, real, /honey/i).several?.map((x) => x.ref)).toEqual([
      "e1",
      "e3",
    ]);
  });
});

describe("desktop-lib's reading of Chrome's own dialog", () => {
  const lib = createRequire(import.meta.url)(join(files, "desktop-lib.cjs")) as {
    dialogWindows(
      wins: { id: string; name: string; transientFor: boolean; type?: string }[],
    ): { id: string }[];
    atspiDialog(tree: unknown):
      | {
          title: string;
          message: string;
          buttons: { name: string; focused: boolean }[];
          fields: string[];
        }
      | undefined;
  };
  it("reads the title, message, buttons and a prompt's field from the accessibility tree", () => {
    const tree = {
      role: "window",
      children: [
        {
          role: "dialog",
          name: "127.0.0.1:1 says",
          description: "Your name?",
          children: [
            {
              role: "group",
              children: [
                { role: "statictext", name: "Your name?" },
                { role: "textfield", value: "default" },
              ],
            },
            {
              role: "group",
              children: [
                { role: "button", name: "Cancel" },
                { role: "button", name: "OK", states: ["focused"] },
              ],
            },
          ],
        },
      ],
    };
    expect(lib.atspiDialog(tree)).toEqual({
      title: "127.0.0.1:1 says",
      message: "Your name?",
      buttons: [
        { name: "Cancel", focused: false },
        { name: "OK", focused: true },
      ],
      fields: ["default"],
    });
    expect(lib.atspiDialog({ role: "window", children: [{ role: "group" }] })).toBeUndefined();
    expect(lib.atspiDialog(undefined)).toBeUndefined();
  });

  it("tells the browser's file chooser window from the browser window and a dropdown's popup", () => {
    const wins = [
      {
        id: "1",
        name: "Page - Google Chrome",
        transientFor: false,
        type: "_NET_WM_WINDOW_TYPE_NORMAL",
      },
      { id: "2", name: "", transientFor: true, type: "_NET_WM_WINDOW_TYPE_COMBO" },
      { id: "3", name: "Open File", transientFor: true, type: "_NET_WM_WINDOW_TYPE_DIALOG" },
      { id: "4", name: "Other", transientFor: false, type: "_NET_WM_WINDOW_TYPE_DIALOG" },
    ];
    expect(lib.dialogWindows(wins).map((w) => w.id)).toEqual(["3"]);
  });
});
