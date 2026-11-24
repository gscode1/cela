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
}
interface CdpLib {
  ALLOWED: Set<string>;
  assertAllowed(method: string): void;
  axEntries(nodes: AxNode[]): Entry[];
  entryLine(e: Entry): string;
  rowTexts(nodes: AxNode[], candidates: Entry[]): string[];
  chooseTarget(
    nodes: AxNode[],
    entries: Entry[],
    re: RegExp,
    o?: { near?: RegExp; nth?: number },
  ): { pick?: Entry; several?: Entry[]; none?: boolean };
  snapshotLines(snap: unknown): string[];
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

  it("lists clickable elements and named headings with refs, without duplicates of link names or disabled ones", () => {
    const lines = cdp.axEntries(tree()).map((e) => cdp.entryLine(e));
    expect(lines).toEqual([
      '[e104] link "Honey 250 g"',
      '[e105] link "Honey 250 g"',
      '[e108] link "Honey 250 g"',
      '[e131] textbox ""',
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

  // A DOMSnapshot document from a list of nodes: parent index, type (1 element, 3 text), tag, text, styles
  // [display, visibility, opacity] and bounds [x, y, w, h]. Nodes without a box get no layout entry.
  interface N {
    parent: number;
    type: number;
    tag?: string;
    text?: string;
    style?: [string, string, string];
    box?: [number, number, number, number];
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
