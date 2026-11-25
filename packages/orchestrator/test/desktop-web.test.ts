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
  labelEl?: number;
  boxEl?: number;
  label?: string;
  noSubmit?: boolean;
  description?: string;
  expanded?: unknown;
  selected?: unknown;
  pressed?: unknown;
  hasPopup?: string;
  focusable?: boolean;
  disabled?: boolean;
  sort?: string;
  group?: string;
  inner?: number[];
  iconOnly?: boolean;
}
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
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
    o?: {
      near?: RegExp;
      nth?: number;
      showable?: boolean;
      texts?: () => Entry[];
      fields?: boolean;
      landmark?: (e: Entry) => boolean;
      inView?: (e: Entry) => boolean;
    },
  ): { pick?: Entry; note?: string; several?: Entry[]; none?: boolean };
  closedMenus(entries: Entry[]): Entry[];
  aimPoints(own: Box, inner: Box[]): { x: number; y: number }[];
  matchTexts(e: Entry): string[];
  snapshotLines(snap: unknown, o?: { marks?: boolean; table?: boolean }): string[];
  titleAround(snap: unknown, backendNodeId: number): string | undefined;
  rowAround(snap: unknown, backendNodeId: number): number | undefined;
  fixedAncestors(snap: unknown, backendNodeId: number): number[];
  layerControls(
    nodes: AxNode[],
    ids: Set<number>,
    o?: { tag?: string; max?: number },
  ): { entries: Entry[]; more: number; buttons: number };
  shotCrop(box: Rect, row: Rect | undefined, area: Rect | undefined, pad: number): Rect;
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
  appearedControls(before: Entry[], after: Entry[]): Entry[];
  orderChange(before: string[], after: string[]): { from: number; to: number } | undefined;
  focusOf(
    nodes: AxNode[],
    entries: Entry[],
  ): { key: string; entry?: Entry; line: string } | undefined;
  findAgain(
    entries: Entry[],
    entry: Entry,
  ): { entry?: Entry; redrawn?: boolean; several?: boolean } | undefined;
  dialogs(
    nodes: AxNode[],
    o?: { max?: number },
  ): { role: string; name: string; backendNodeId?: number; entries: Entry[]; more: number }[];
  dialogLines(ds: { role: string; name: string; modal?: boolean; entries: Entry[] }[]): string[];
  outline(
    nodes: AxNode[],
    lines: string[],
    o?: { lineOf?: (n: AxNode) => number | undefined },
  ): string[];
  snapshotText(
    snap: unknown,
    o?: { width?: number; table?: boolean },
  ): {
    lines: string[];
    xs: number[];
    at: Map<number, number>;
    rows: ({ table: string; head: boolean } | undefined)[];
  };
  indentLevels(xs: number[]): number[];
  decodeEntities(s: string): string;
  pageNotices(
    parts: { snap: unknown; hidden?: Set<number>; url?: string }[],
    o: { lines: string[]; title: string; sighting?: (host: string) => number },
  ): string[];
  challengeOf(url: string): string | undefined;
  cutOff(
    snap: unknown,
    re: RegExp,
  ): { count: number; boxes: { x: number; y: number; w: number; h: number }[] };
  showsBox(snap: unknown, backendNodeId: number): boolean;
  mainFirst(nodes: AxNode[], entries: Entry[]): Entry[];
  ownedNodes(nodes: AxNode[], entry: Entry): Set<string>;
  inLandmark(nodes: AxNode[], entry: Entry, roles: Set<string>): boolean;
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
  properties?: {
    name: string;
    value: { value?: unknown; relatedNodes?: { backendDOMNodeId: number }[] };
  }[];
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

  it("joins an inline-block that sits on its line of text, and keeps cards and wrapped columns apart", () => {
    const ib: [string, string, string] = ["inline-block", "visible", "1"];
    const nodes: N[] = [
      doc, // 0
      { ...div, box: [0, 0, 600, 200] }, // 1
      { parent: 1, type: 1, tag: "P", style: BLOCKSTYLE, box: [0, 0, 600, 20] }, // 2
      t("Distance: ", [0, 0, 70, 16], 2), // 3
      { parent: 2, type: 1, tag: "OUTPUT", style: ib, box: [70, 0, 40, 18] }, // 4
      t("13km", [70, 1, 40, 16], 4), // 5
      t(". Time:", [110, 0, 50, 16], 2), // 6
      // two cards side by side: each holds blocks of its own, so each stays apart
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 40, 600, 40] }, // 7
      { parent: 7, type: 1, tag: "DIV", style: ib, box: [0, 40, 160, 40] }, // 8
      { parent: 8, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 40, 160, 20] }, // 9
      t("Card A", [0, 40, 50, 16], 9), // 10
      { parent: 8, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 60, 160, 20] }, // 11
      t("10 zł", [0, 60, 40, 16], 11), // 12
      { parent: 7, type: 1, tag: "DIV", style: ib, box: [170, 40, 160, 40] }, // 13
      { parent: 13, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [170, 40, 160, 20] }, // 14
      t("Card B", [170, 40, 50, 16], 14), // 15
      // a column whose text wraps (two fragments) next to a short one
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 100, 600, 32] }, // 16
      { parent: 16, type: 1, tag: "SPAN", style: ib, box: [0, 100, 100, 32] }, // 17
      t("Left words", [0, 100, 100, 32], 17), // 18
      { parent: 16, type: 1, tag: "SPAN", style: ib, box: [110, 100, 100, 16] }, // 19
      t("Right", [110, 100, 40, 16], 19), // 20
    ];
    const snap = snapOf(nodes) as unknown as {
      documents: [{ layout: { nodeIndex: number[] }; textBoxes?: unknown }];
    };
    const li = snap.documents[0].layout.nodeIndex.indexOf(18);
    snap.documents[0].textBoxes = {
      layoutIndex: [li, li],
      bounds: [
        [0, 100, 100, 16],
        [0, 116, 60, 16],
      ],
    };
    expect(cdp.snapshotLines(snap)).toEqual([
      "Distance: 13km. Time:",
      "Card A",
      "10 zł",
      "Card B",
      "Left words",
      "Right",
    ]);
  });

  it("joins the items of a flex row that stand close, with a space, and keeps padded tabs apart", () => {
    const flex: [string, string, string] = ["flex", "visible", "1"];
    const nodes: N[] = [
      doc, // 0
      { ...div, box: [0, 0, 600, 200] }, // 1
      // a price drawn as three items side by side: "699" "00" "zł"
      { parent: 1, type: 1, tag: "DIV", style: flex, box: [0, 0, 600, 24] }, // 2
      { parent: 2, type: 1, tag: "SPAN", style: BLOCKSTYLE, box: [0, 0, 36, 24] }, // 3
      t("699", [0, 0, 36, 24], 3), // 4
      { parent: 2, type: 1, tag: "SPAN", style: BLOCKSTYLE, box: [36, 4, 14, 12] }, // 5
      t("00", [36, 4, 14, 12], 5), // 6
      { parent: 2, type: 1, tag: "SPAN", style: BLOCKSTYLE, box: [53, 4, 16, 18] }, // 7
      t("zł", [53, 4, 16, 18], 7), // 8
      // tabs padded 12 px each side: the boxes touch, the texts stand 24 px apart (links are controls and never join)
      { parent: 1, type: 1, tag: "NAV", style: flex, box: [0, 40, 600, 18] }, // 9
      { parent: 9, type: 1, tag: "SPAN", style: BLOCKSTYLE, box: [0, 40, 64, 18] }, // 10
      t("News", [12, 40, 40, 18], 10), // 11
      { parent: 9, type: 1, tag: "SPAN", style: BLOCKSTYLE, box: [64, 40, 64, 18] }, // 12
      t("Sport", [76, 40, 40, 18], 12), // 13
      // a column of items: one under the other
      { parent: 1, type: 1, tag: "DIV", style: flex, box: [0, 80, 600, 40] }, // 14
      { parent: 14, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 80, 600, 18] }, // 15
      t("upper", [0, 80, 40, 18], 15), // 16
      { parent: 14, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 100, 600, 18] }, // 17
      t("lower", [0, 100, 40, 18], 17), // 18
    ];
    expect(cdp.snapshotLines(snapOf(nodes))).toEqual([
      "699 00 zł",
      "News",
      "Sport",
      "upper",
      "lower",
    ]);
  });

  it("counts matches in text a box with overflow hidden cuts away, without the text", () => {
    const st = (overflow: string): string[] => [
      "block",
      "visible",
      "1",
      "static",
      overflow,
      overflow,
      "auto",
    ];
    const el = (parent: number, style: string[], box: [number, number, number, number]): N => ({
      parent,
      type: 1,
      tag: "DIV",
      style: style as unknown as [string, string, string],
      box,
    });
    const snap = snapOf([
      doc, // 0
      el(0, st("visible"), [0, 0, 600, 400]), // 1 page
      el(1, st("hidden"), [0, 0, 500, 60]), // 2 a spec table cut at 60 px
      el(2, st("visible"), [0, 0, 500, 20]), // 3
      t("Screen 27 in", [0, 0, 90, 16], 3),
      el(2, st("visible"), [0, 100, 500, 20]), // 5
      t("Ports USB-C, HDMI", [0, 100, 130, 16], 5),
      el(2, st("visible"), [0, 120, 500, 20]), // 7
      t("Cable USB-C", [0, 120, 90, 16], 7),
      el(1, st("hidden"), [0, 300, 1, 1]), // 9 a screen-reader-only box
      t("USB-C hidden", [0, 300, 90, 16], 9),
    ]);
    expect(cdp.snapshotLines(snap)).toEqual(["Screen 27 in"]);
    expect(cdp.cutOff(snap, /USB-C/)).toEqual({ count: 2, boxes: [{ x: 0, y: 0, w: 500, h: 60 }] });
    expect(cdp.cutOff(snap, /Screen/)).toEqual({ count: 0, boxes: [] });
  });

  it("marks struck-through text and labels a line without letters by the element around it", () => {
    const s9 = (display: string, deco = "none") =>
      [
        display,
        "visible",
        "1",
        "static",
        "visible",
        "visible",
        "auto",
        "auto",
        deco,
      ] as unknown as [string, string, string];
    const snap = snapOf([
      doc, // 0
      { parent: 0, type: 1, tag: "DIV", style: s9("block"), box: [0, 0, 400, 100] }, // 1
      { parent: 1, type: 1, tag: "P", style: s9("block"), box: [0, 0, 400, 20] }, // 2
      t("Price", [0, 0, 40, 16], 2), // 3
      { parent: 2, type: 1, tag: "DEL", style: s9("inline", "line-through"), box: [45, 0, 50, 16] }, // 4
      { parent: 4, type: 1, tag: "B", style: s9("inline"), box: [45, 0, 25, 16] }, // 5
      t("637", [45, 0, 25, 16], 5), // 6
      t(" zł", [70, 0, 25, 16], 4), // 7
      t("384 zł", [100, 0, 50, 16], 2), // 8
      {
        parent: 1,
        type: 1,
        tag: "BUTTON",
        style: s9("block"),
        box: [0, 30, 40, 20],
        attrs: { "aria-label": "Upvote" },
      }, // 9
      t("94", [0, 30, 20, 16], 9), // 10
      // a title without letters says nothing
      {
        parent: 1,
        type: 1,
        tag: "P",
        style: s9("block"),
        box: [0, 60, 40, 20],
        attrs: { title: "12" },
      }, // 11
      t("7", [0, 60, 10, 16], 11), // 12
      // a toolbar named as a whole: far wider than the count, so it names nothing in it
      {
        parent: 1,
        type: 1,
        tag: "DIV",
        style: s9("block"),
        box: [0, 80, 400, 20],
        attrs: { "aria-label": "Actions for this post" },
      }, // 13
      t("48", [0, 80, 16, 16], 13), // 14
    ]);
    expect(cdp.snapshotLines(snap)).toEqual(["Price ~637 zł~ 384 zł", "94 ‹Upvote›", "7", "48"]);
  });

  it("maps headings to their lines by node, in line order, and leaves out one without a line", () => {
    const snap = snapOf([
      doc, // 0
      div, // 1
      { parent: 1, type: 1, tag: "P", style: BLOCKSTYLE, box: [0, 0, 400, 16] }, // 2
      t("Offers come first", [0, 0, 120, 16], 2), // 3
      { parent: 1, type: 1, tag: "H2", style: BLOCKSTYLE, box: [20, 20, 380, 16] }, // 4
      t("Offers", [20, 20, 50, 16], 4), // 5
    ]);
    const text = cdp.snapshotText(snap);
    expect(text.lines).toEqual(["Offers come first", "Offers"]);
    expect(text.xs).toEqual([0, 20]);
    expect(text.at.get(1004)).toBe(1);
    const h = (id: string, name: string, level: number, backend: number): AxNode => ({
      nodeId: id,
      role: { value: "heading" },
      name: { value: name },
      backendDOMNodeId: backend,
      properties: [{ name: "level", value: { value: level } }],
    });
    const nodes = [h("1", "Offers", 2, 1004), h("2", "Intro", 1, 900), h("3", "Unseen", 2, 901)];
    const at = new Map([...text.at, [900, 0]]);
    expect(
      cdp.outline(nodes, text.lines, { lineOf: (n) => at.get(n.backendDOMNodeId ?? -1) }),
    ).toEqual(["1: # Intro", "2: ## Offers"]);
  });

  it("counts indent levels from left edges several lines share", () => {
    expect(cdp.indentLevels([0, 0, 0, 40, 41, 40, 80, 80, 0, 300])).toEqual([
      0, 0, 0, 1, 1, 1, 2, 2, 0, 3,
    ]);
  });

  it("decodes the HTML entities of a title", () => {
    expect(cdp.decodeEntities("Stripe&#39;s &amp; 27&quot; &#x41;&nbsp;&bogus;")).toBe(
      "Stripe's & 27\" A &bogus;",
    );
  });

  it("says when a page is Chrome's error page, may be an error page, looks like a bot check or has a frame loading", () => {
    interface Snap {
      strings: string[];
      documents: [{ documentURL?: number }];
    }
    const page = (url: string, extra: N[] = []) => {
      const s = snapOf([doc, div, t("x", [0, 0, 10, 16]), ...extra]) as unknown as Snap;
      s.documents[0].documentURL = s.strings.push(url) - 1;
      return s;
    };
    const frame = (src: string): N => ({
      parent: 1,
      type: 1,
      tag: "IFRAME",
      style: BLOCKSTYLE,
      box: [0, 20, 300, 65],
      attrs: { src },
    });
    const short = { lines: ["Checking your browser"], title: "Just a moment" };
    const long = {
      lines: Array.from({ length: 41 }, (_, i) => `line ${String(i)}`),
      title: "Shop",
    };
    expect(cdp.pageNotices([{ snap: page("chrome-error://chromewebdata/") }], short)).toEqual([
      "Chrome error page: the page did not load (Chrome's reason is in its text)",
    ]);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/x") }], {
        lines: ["Oops"],
        title: "404 Not Found",
      }),
    ).toEqual([
      "may be an error page: a status number in the title, a heading or a line of its own",
    ]);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/x") }], { ...long, title: "404 - Shop" }),
    ).toEqual([
      "may be an error page: a status number in the title, a heading or a line of its own",
    ]);
    const longer = Array.from({ length: 151 }, (_, i) => `line ${String(i)}`);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/x") }], { lines: longer, title: "Error 404" }),
    ).toEqual([]);
    // a number inside a title is a product's, not a status
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/x") }], { ...long, title: "SSD 500 GB" }),
    ).toEqual([]);
    const error = [
      "may be an error page: a status number in the title, a heading or a line of its own",
    ];
    // a status at the edge of one of the title's parts, a line that is only a word and the status
    const at = (title: string, lines: string[]) =>
      cdp.pageNotices([{ snap: page("https://a.test/x") }], { lines, title });
    expect(at("a.test | 522: Connection timed out", ["x"])).toEqual(error);
    expect(at("Shop - 503", ["x"])).toEqual(error);
    expect(at("a.test/c/1634", ["Home", "Error 404", "Oops"])).toEqual(error);
    expect(at("a.test/c/1634", ["Home", "404"])).toEqual(error);
    // a price, a hyphenated name and a number inside a line are no status
    expect(
      at("Monitors - Shop", ["Monitor Alpha", "404 zł", "1 404,00 zł", "Top 500 models"]),
    ).toEqual([]);
    expect(at("Wi-Fi 500 Mbps router", long.lines)).toEqual([]);
    const challenge = page("https://a.test/", [
      frame("https://challenges.cloudflare.com/turnstile"),
    ]);
    expect(cdp.pageNotices([{ snap: challenge }], short)).toEqual([
      "looks like a bot check (Cloudflare challenge): never click or solve it. It can be a one-off: open one ordinary page of the site (its home or section page), then this page once more.",
    ]);
    // the second time on the host: the site's answer
    expect(cdp.pageNotices([{ snap: challenge }], { ...short, sighting: () => 2 })).toEqual([
      "bot check again (Cloudflare challenge, 2nd time on a.test): stop and report it. Do not retry, wait it out, or try other addresses or mirrors.",
    ]);
    expect(cdp.challengeOf("https://www.google.com/recaptcha/api2/anchor?k=1")).toBe("reCAPTCHA");
    expect(cdp.challengeOf("https://www.google.com/search?q=recaptcha")).toBeUndefined();
    expect(cdp.pageNotices([{ snap: challenge }], long)).toEqual([]);
    // a page of one short line says almost nothing: no bot check there, but maybe an error or block page
    const nearlyEmpty =
      "page shows almost no text (1 line, no form field): an error or block page, or a picture-only one; look with desktop-shot";
    expect(cdp.pageNotices([{ snap: challenge, hidden: new Set([1003]) }], short)).toEqual([
      nearlyEmpty,
    ]);
    const badge = page("https://a.test/", [
      frame("https://www.google.com/recaptcha/api2/anchor?k=1&size=invisible"),
    ]);
    expect(cdp.pageNotices([{ snap: badge }], short)).toEqual([nearlyEmpty]);
    // out-of-process frames come as parts with their target URL: one drew a challenge, one has drawn nothing yet
    const hc = {
      snap: page("https://newassets.hcaptcha.com/c"),
      url: "https://newassets.hcaptcha.com/c",
    };
    const blank = {
      snap: snapOf([doc, { ...div, tag: "HTML", box: [0, 0, 300, 150] }]),
      url: "https://pay.test/frame",
    };
    // a frame that has laid out nothing (a tracker's, its iframe not shown) is not loading
    const unlaid = { snap: snapOf([doc]), url: "https://m.test/frame" };
    expect(cdp.pageNotices([{ snap: page("https://a.test/") }, unlaid], short)).toEqual([
      nearlyEmpty,
    ]);
    expect(cdp.pageNotices([{ snap: page("https://a.test/") }, hc, blank], short)).toEqual([
      "looks like a bot check (hCaptcha): never click or solve it. It can be a one-off: open one ordinary page of the site (its home or section page), then this page once more.",
      "a frame is still loading (pay.test): read again in a moment",
    ]);
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

  it("says a page of a few short lines and no field may be an error or block page", () => {
    interface Snap {
      strings: string[];
      documents: [{ documentURL?: number }];
    }
    const page = (url: string, extra: N[] = []) => {
      const s = snapOf([doc, div, t("x", [0, 0, 10, 16]), ...extra]) as unknown as Snap;
      s.documents[0].documentURL = s.strings.push(url) - 1;
      return s;
    };
    const say = (n: number) =>
      `page shows almost no text (${String(n)} line${n === 1 ? "" : "s"}, no form field): an error or block page, or a picture-only one; look with desktop-shot`;
    const sorry = { lines: ["Sorry, something went wrong."], title: "Shop" };
    expect(cdp.pageNotices([{ snap: page("https://a.test/s") }], sorry)).toEqual([say(1)]);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/s") }], {
        lines: ["a", "b", "c"],
        title: "Shop",
      }),
    ).toEqual([say(3)]);
    // more lines, long lines, no lines yet (nothing drawn) or a page that is not a site's: nothing said
    const four = { lines: ["a", "b", "c", "d"], title: "Shop" };
    expect(cdp.pageNotices([{ snap: page("https://a.test/s") }], four)).toEqual([]);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/s") }], {
        lines: ["w".repeat(201)],
        title: "Shop",
      }),
    ).toEqual([]);
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/s") }], { lines: [], title: "Shop" }),
    ).toEqual([]);
    expect(cdp.pageNotices([{ snap: page("file:///workspace/a.html") }], sorry)).toEqual([]);
    // a field with a box makes it a page to use (a search start page); a hidden one does not
    const field = (tag: string): N => ({ parent: 1, type: 1, tag, box: [0, 20, 200, 24] });
    expect(cdp.pageNotices([{ snap: page("https://a.test/s", [field("INPUT")]) }], sorry)).toEqual(
      [],
    );
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/s", [field("TEXTAREA")]) }], sorry),
    ).toEqual([]);
    expect(
      cdp.pageNotices(
        [{ snap: page("https://a.test/s", [field("INPUT")]), hidden: new Set([1003]) }],
        sorry,
      ),
    ).toEqual([say(1)]);
    const unboxed: N = { parent: 1, type: 1, tag: "SELECT" };
    expect(cdp.pageNotices([{ snap: page("https://a.test/s", [unboxed]) }], sorry)).toEqual([
      say(1),
    ]);
    // a heading with a button is a small real page; a heading alone, or a button alone, is still nearly empty
    const at = (tag: string, y: number): N => ({ parent: 1, type: 1, tag, box: [0, y, 100, 24] });
    const h1 = at("H1", 0);
    const btn = at("BUTTON", 40);
    expect(cdp.pageNotices([{ snap: page("https://a.test/s", [h1, btn]) }], sorry)).toEqual([]);
    expect(cdp.pageNotices([{ snap: page("https://a.test/s", [h1]) }], sorry)).toEqual([say(1)]);
    expect(cdp.pageNotices([{ snap: page("https://a.test/s", [btn]) }], sorry)).toEqual([say(1)]);
    // a page a status already names is said once, by that
    expect(
      cdp.pageNotices([{ snap: page("https://a.test/s") }], { lines: ["Not found"], title: "404" }),
    ).toEqual([
      "may be an error page: a status number in the title, a heading or a line of its own",
    ]);
  });

  it("says when kept lines changed their order, and where they are now", () => {
    expect(cdp.orderChange(["h", "A", "B", "f"], ["h", "B", "A", "f"])).toEqual({ from: 2, to: 3 });
    expect(
      cdp.orderChange(["t", "Plum", "Apple", "Mango", "x"], ["t", "Apple", "Mango", "Plum", "x"]),
    ).toEqual({ from: 2, to: 4 });
    // lines that appeared or went between kept ones are no reorder; a range is of the lines as they read now
    expect(cdp.orderChange(["a", "b", "c"], ["a", "new", "b", "c"])).toBeUndefined();
    expect(cdp.orderChange(["a", "b", "c"], ["a", "c"])).toBeUndefined();
    expect(cdp.orderChange(["a", "b", "c", "d"], ["new", "a", "d", "x", "c", "b"])).toEqual({
      from: 3,
      to: 6,
    });
    // a line shown twice (a repeated "Edit" link) cannot say which copy moved: left out
    expect(cdp.orderChange(["Edit", "a", "Edit", "b"], ["Edit", "Edit", "a", "b"])).toBeUndefined();
    expect(cdp.orderChange([], ["a"])).toBeUndefined();
  });

  it("finds the element that has focus, and the acted-on one again when the page drew it anew", () => {
    const focused = { properties: [{ name: "focused", value: { value: true } }] };
    const nodes: AxNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, backendDOMNodeId: 101, ...focused },
      {
        nodeId: "2",
        parentId: "1",
        role: { value: "textbox" },
        name: { value: "Last name" },
        backendDOMNodeId: 102,
        ...focused,
      },
      {
        nodeId: "3",
        parentId: "1",
        role: { value: "generic" },
        name: { value: "" },
        backendDOMNodeId: 103,
      },
    ];
    const entries = cdp.axEntries(nodes);
    expect(cdp.focusOf(nodes, entries)).toMatchObject({
      key: ":102",
      line: '[e102] textbox "Last name" focused',
    });
    // a focused element that is no entry is named by its role; the page itself is no focus
    expect(cdp.focusOf(nodes, [])?.line).toBe('textbox "Last name"');
    expect(cdp.focusOf(nodes.slice(0, 1), [])).toBeUndefined();
    const option = (ref: string, name: string, selected: boolean): Entry => ({
      ref,
      backendNodeId: Number(ref.slice(1)),
      nodeId: ref,
      role: "option",
      name,
      selected,
    });
    const was = option("e5", "docs", false);
    expect(cdp.findAgain([option("e5", "docs", true)], was)).toMatchObject({ redrawn: false });
    expect(
      cdp.findAgain([option("e9", "bug", false), option("e8", "docs", true)], was),
    ).toMatchObject({
      entry: { ref: "e8" },
      redrawn: true,
    });
    expect(cdp.findAgain([option("e8", "docs", true), option("e9", "docs", false)], was)).toEqual({
      several: true,
    });
    expect(cdp.findAgain([option("e9", "bug", false)], was)).toBeUndefined();
  });

  it("joins a table row's cells with | only when asked, keeps empty cells and marks header rows", () => {
    const st = (d: string): [string, string, string] => [d, "visible", "1"];
    const cell = (parent: number, tag: string, x: number, y: number): N => ({
      parent,
      type: 1,
      tag,
      style: st("table-cell"),
      box: [x, y, 80, 20],
    });
    const snap = snapOf([
      doc,
      { parent: 0, type: 1, tag: "TABLE", style: st("table"), box: [0, 0, 240, 60] },
      { parent: 1, type: 1, tag: "THEAD", style: st("table-header-group"), box: [0, 0, 240, 20] },
      { parent: 2, type: 1, tag: "TR", style: st("table-row"), box: [0, 0, 240, 20] },
      cell(3, "TH", 0, 0),
      t("City", [2, 2, 30, 16], 4),
      cell(3, "TH", 80, 0),
      t("Population", [82, 2, 70, 16], 6),
      cell(3, "TH", 160, 0),
      t("Note", [162, 2, 30, 16], 8),
      { parent: 1, type: 1, tag: "TBODY", style: st("table-row-group"), box: [0, 20, 240, 40] },
      { parent: 10, type: 1, tag: "TR", style: st("table-row"), box: [0, 20, 240, 20] },
      cell(11, "TD", 0, 20),
      t("Oslo", [2, 22, 30, 16], 12),
      cell(11, "TD", 80, 20),
      t("700", [82, 22, 30, 16], 14),
      cell(11, "TD", 160, 20),
      { parent: 0, type: 1, tag: "P", style: BLOCKSTYLE, box: [0, 70, 240, 20] },
      t("After the table", [0, 70, 100, 16], 17),
    ]);
    expect(cdp.snapshotLines(snap)).toEqual([
      "City Population Note",
      "Oslo 700",
      "After the table",
    ]);
    expect(cdp.snapshotLines(snap, { table: true })).toEqual([
      "City | Population | Note",
      "Oslo | 700 | ",
      "After the table",
    ]);
    expect(cdp.snapshotText(snap, { table: true }).rows).toEqual([
      { table: "0:1", head: true },
      { table: "0:1", head: false },
      undefined,
    ]);
  });

  it("reads an ARIA grid's rows by role whatever their display, empty cells kept", () => {
    const st = (d: string): [string, string, string] => [d, "visible", "1"];
    const div = (
      parent: number,
      role: string,
      d: string,
      box: [number, number, number, number],
    ): N => ({
      parent,
      type: 1,
      tag: "DIV",
      style: st(d),
      box,
      attrs: { role },
    });
    const snap = snapOf([
      doc, // 0
      div(0, "grid", "block", [0, 0, 300, 60]), // 1
      div(1, "rowgroup", "block", [0, 0, 300, 20]), // 2
      div(2, "row", "flex", [0, 0, 300, 20]), // 3
      div(3, "columnheader", "block", [0, 0, 100, 20]), // 4
      t("Day", [2, 2, 30, 16], 4), // 5
      div(3, "columnheader", "block", [100, 0, 100, 20]), // 6
      t("Rain", [102, 2, 30, 16], 6), // 7
      div(3, "columnheader", "block", [200, 0, 100, 20]), // 8
      t("Wind", [202, 2, 30, 16], 8), // 9
      div(1, "rowgroup", "block", [0, 20, 300, 20]), // 10
      div(10, "row", "flex", [0, 20, 300, 20]), // 11
      div(11, "rowheader", "block", [0, 20, 100, 20]), // 12
      t("Thu", [2, 22, 30, 16], 12), // 13
      div(11, "gridcell", "block", [100, 20, 100, 20]), // 14 no rain: empty
      div(11, "gridcell", "block", [200, 20, 100, 20]), // 15
      { parent: 15, type: 1, tag: "SPAN", style: st("inline"), box: [202, 22, 30, 16] }, // 16
      t("3 m/s", [202, 22, 30, 16], 16), // 17
    ]);
    expect(cdp.snapshotLines(snap, { table: true })).toEqual([
      "Day | Rain | Wind",
      "Thu |  | 3 m/s",
    ]);
    expect(cdp.snapshotText(snap, { table: true }).rows).toEqual([
      { table: "0:1", head: true },
      { table: "0:1", head: false },
    ]);
    expect(cdp.snapshotLines(snap)).toEqual(["Day", "Rain", "Wind", "Thu", "3 m/s"]);
  });

  it("wraps long blocks into lines and reports only what an action added", () => {
    const long = `${"word ".repeat(60)}end`;
    const wrapped = cdp.wrapLines(["short", long], 100);
    expect(wrapped[0]).toBe("short");
    expect(wrapped.length).toBeGreaterThan(3);
    expect(wrapped.every((l) => l.length <= 100)).toBe(true);
    expect(wrapped.join(" ")).toBe(`short ${long}`);
    expect(cdp.newLines(["a", "b"], ["a", "b", "c", "c", "d"])).toEqual(["c", "d"]);
    // counted: "Red" picked in a second list is new though the first list shows it too, and one copy fewer is gone
    expect(cdp.newLines(["Red", "Blue"], ["Red", "Blue", "Red"])).toEqual(["Red"]);
    expect(cdp.newLines(["Red", "Blue", "Red"], ["Red", "Blue"])).toEqual([]);
    expect(cdp.newLines(["Red", "Blue"], ["Red", "Blue", "Red"]).length).toBe(1);
    expect(cdp.newLines(["Red", "Blue", "Red"], ["Blue", "Red"])).toEqual([]);
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

  it("finds the row around a narrow target and the fixed layer around an element", () => {
    const st = (d: string, pos = "static") =>
      [d, "visible", "1", pos, "visible", "visible", "auto", "auto"] as unknown as [
        string,
        string,
        string,
      ];
    const snap = snapOf([
      doc, // 0
      { parent: 0, type: 1, tag: "BODY", style: st("block"), box: [0, 0, 1000, 2000] }, // 1
      { parent: 1, type: 1, tag: "TABLE", style: st("block"), box: [0, 0, 800, 400] }, // 2 too tall to be the row
      { parent: 2, type: 1, tag: "DIV", style: st("flex"), box: [0, 40, 800, 30] }, // 3 the row
      { parent: 3, type: 1, tag: "SPAN", style: st("block"), box: [0, 40, 300, 30] }, // 4 a cell
      { parent: 4, type: 1, tag: "B", style: st("inline"), box: [0, 44, 60, 18] }, // 5 the label
      t("Area", [0, 44, 60, 18], 5), // 6
      { parent: 1, type: 1, tag: "DIV", style: st("block", "fixed"), box: [0, 600, 1000, 120] }, // 7 a fixed banner
      { parent: 7, type: 1, tag: "P", style: st("block"), box: [10, 610, 400, 20] }, // 8
      t("We use cookies", [10, 610, 100, 18], 8), // 9
      { parent: 7, type: 1, tag: "DIV", style: st("block", "fixed"), box: [0, 0, 1000, 720] }, // 10 its dimming layer
    ]);
    expect(cdp.rowAround(snap, 1005)).toBe(1003);
    expect(cdp.rowAround(snap, 1003)).toBeUndefined();
    expect(cdp.fixedAncestors(snap, 1010)).toEqual([1010, 1007]);
    expect(cdp.fixedAncestors(snap, 1008)).toEqual([1007]);
    expect(cdp.fixedAncestors(snap, 1005)).toEqual([]);
  });

  it("crops a shot to at least 480x160 and the row, shifted to stay inside the page area", () => {
    const area = { x: 0, y: 100, w: 1280, h: 700 };
    // a small icon in the middle: the minimum, centred on it
    expect(cdp.shotCrop({ x: 600, y: 400, w: 20, h: 20 }, undefined, area, 14)).toEqual({
      x: 370,
      y: 330,
      w: 480,
      h: 160,
    });
    // a label at the page's top left: shifted, not cut, and as wide as its row
    expect(
      cdp.shotCrop({ x: 2, y: 104, w: 60, h: 20 }, { x: 2, y: 100, w: 900, h: 28 }, area, 14),
    ).toEqual({
      x: 0,
      y: 100,
      w: 928,
      h: 160,
    });
    // a wide heading alone: cut to a readable width at its left edge
    expect(cdp.shotCrop({ x: 10, y: 300, w: 1200, h: 40 }, undefined, area, 14)).toEqual({
      x: 0,
      y: 240,
      w: 668,
      h: 160,
    });
  });

  it("lists the controls of a fixed layer and counts its buttons", () => {
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      extra: Partial<AxNode> = {},
    ): AxNode => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      backendDOMNodeId: Number(nodeId) + 100,
      ...extra,
    });
    const nodes = [
      ax("1", "RootWebArea", "Shop", { childIds: ["2", "3", "4"] }),
      ax("2", "link", "Behind", { parentId: "1" }),
      ax("3", "button", "Reject all", { parentId: "1" }),
      ax("4", "link", "Privacy policy", { parentId: "1" }),
    ];
    const layer = cdp.layerControls(nodes, new Set([103, 104]));
    expect(layer.entries.map((e) => cdp.entryLine(e))).toEqual([
      '[e103] button "Reject all"',
      '[e104] link "Privacy policy"',
    ]);
    expect(layer.buttons).toBe(1);
    expect(cdp.layerControls(nodes, new Set([102])).buttons).toBe(0);
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
      ax("2", "dialog", "Prywatność", "1", {
        childIds: ["3", "4"],
        properties: [{ name: "modal", value: { value: true } }],
      }),
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
    // a dialog that does not hold the page back (a <dialog open>) says so
    const open = nodes.map((n) => (n.nodeId === "2" ? { ...n, properties: [] } : n));
    expect(cdp.dialogLines(cdp.dialogs(open))[0]).toBe('open dialog "Prywatność" (not modal):');
  });

  it("lists a dialog's buttons first when its controls pass the cap", () => {
    const kids = ["3", "4", "5", "6", "7", "8"];
    const nodes: AxNode[] = [
      { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Page" }, childIds: ["2"] },
      {
        nodeId: "2",
        role: { value: "dialog" },
        name: { value: "Cookies" },
        parentId: "1",
        childIds: kids,
        properties: [{ name: "modal", value: { value: true } }],
      },
      ...kids.map((id, i): AxNode => {
        const button = i >= 4;
        return {
          nodeId: id,
          role: { value: button ? "button" : "link" },
          name: { value: button ? `Choice ${String(i)}` : `Link ${String(i)}` },
          parentId: "2",
          backendDOMNodeId: Number(id) + 100,
          ...(button ? {} : { properties: [{ name: "url", value: { value: `/l${String(i)}` } }] }),
        };
      }),
    ];
    const [d] = cdp.dialogs(nodes, { max: 3 });
    expect(d?.entries.map((e) => e.name)).toEqual(["Choice 4", "Choice 5", "Link 0"]);
    expect(d?.more).toBe(3);
    // under the cap nothing moves
    expect(cdp.dialogs(nodes, { max: 8 })[0]?.entries.map((e) => e.name)).toEqual([
      "Link 0",
      "Link 1",
      "Link 2",
      "Link 3",
      "Choice 4",
      "Choice 5",
    ]);
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
      'status ‹dot state=up› fine ‹src:brand-mark.png› ‹"Logo"›',
    ]);
  });

  it("marks a named icon by its name, and a datetime or a title that says more, only when asked", () => {
    const inline = ["inline", "visible", "1"] as [string, string, string];
    const nodes: N[] = [
      doc, // 0
      { parent: 0, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 0, 400, 200] }, // 1
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 0, 400, 20] }, // 2
      t("813", [0, 0, 30, 16], 2), // 3
      // an icon named by aria-label: its name, and nothing of the svg inside it
      {
        parent: 2,
        type: 1,
        tag: "DIV",
        style: ["inline-block", "visible", "1"],
        box: [40, 0, 18, 18],
        attrs: { "aria-label": "Accepted", title: "Loading when this answer was accepted" },
      }, // 4
      {
        parent: 4,
        type: 1,
        tag: "svg",
        style: inline,
        box: [40, 0, 18, 18],
        attrs: { class: "svg-icon iconCheckmarkLg" },
      }, // 5
      { parent: 1, type: 1, tag: "P", style: BLOCKSTYLE, box: [0, 30, 400, 20] }, // 6
      t("posted", [0, 30, 40, 16], 6), // 7
      {
        parent: 6,
        type: 1,
        tag: "TIME",
        style: inline,
        box: [45, 30, 80, 16],
        attrs: { datetime: "2026-11-25T08:14:00.000Z" },
      }, // 8
      t("4 hours ago", [45, 30, 80, 16], 8), // 9
      t("by Ann", [130, 30, 40, 16], 6), // 10
      { parent: 1, type: 1, tag: "P", style: BLOCKSTYLE, box: [0, 60, 400, 20] }, // 11
      // a title that repeats the text says nothing; one that says more is a mark
      {
        parent: 11,
        type: 1,
        tag: "A",
        style: inline,
        box: [0, 60, 40, 16],
        attrs: { title: "Home" },
      }, // 12
      t("Home", [0, 60, 40, 16], 12), // 13
      {
        parent: 11,
        type: 1,
        tag: "ABBR",
        style: inline,
        box: [50, 60, 40, 16],
        attrs: { title: "Gross domestic product" },
      }, // 14
      t("GDP", [50, 60, 40, 16], 14), // 15
      // a shop's logo: a link with no name of its own around a named picture
      { parent: 1, type: 1, tag: "DIV", style: BLOCKSTYLE, box: [0, 90, 400, 40] }, // 16
      {
        parent: 16,
        type: 1,
        tag: "A",
        style: BLOCKSTYLE,
        box: [0, 90, 100, 40],
        attrs: { class: "store-logo go-to-shop" },
      }, // 17
      {
        parent: 17,
        type: 1,
        tag: "IMG",
        style: inline,
        box: [0, 90, 100, 40],
        attrs: { alt: "shop.example" },
      }, // 18
      t("959,00 zł", [200, 90, 60, 16], 16), // 19
    ];
    expect(cdp.snapshotLines(snapOf(nodes))).toEqual([
      "813",
      "posted 4 hours ago by Ann",
      "Home GDP",
      "959,00 zł",
    ]);
    expect(cdp.snapshotLines(snapOf(nodes), { marks: true })).toEqual([
      '813 ‹"Accepted"›',
      "posted 4 hours ago ‹datetime=2026-11-25T08:14:00.000Z› by Ann",
      'Home GDP ‹title:"Gross domestic product"›',
      // a block of its own, a line of its own
      '‹"shop.example"›',
      "959,00 zł",
    ]);
    // the tooltip a hover waits for: the element's title or that of one around it that holds little more
    expect(cdp.titleAround(snapOf(nodes), 1015)).toBe("Gross domestic product");
    expect(cdp.titleAround(snapOf(nodes), 1009)).toBeUndefined();
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

  it("keeps a hidden checkbox whose label a person sees, clicked through the label, or a clickable box of its own, and drops a honeypot", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 400, 200]), // 1
      el(1, "LABEL", sty("block", "1", "pointer"), [0, 0, 200, 20]), // 2 label around its input
      el(2, "INPUT", sty("inline-block", "0"), [0, 0, 14, 14], { type: "checkbox" }), // 3
      t("Very good: 8+", [20, 0, 90, 16], 2), // 4
      el(1, "INPUT", sty("inline-block", "0"), [0, 30, 14, 14], { type: "checkbox", id: "s" }), // 5
      el(1, "LABEL", sty("block"), [0, 30, 200, 20], { for: "s" }), // 6 label tied by for=
      t("Superb", [20, 30, 60, 16], 6), // 7
      el(1, "INPUT", sty("inline-block", "0"), [0, 60, 1, 1], { type: "checkbox" }), // 8 honeypot
      el(1, "INPUT", sty("inline-block"), [0, 90, 200, 20], {
        placeholder: "Where are you going?",
        type: "password",
      }), // 9
      el(1, "INPUT", sty("inline-block", "0"), [0, 120, 40, 40], { type: "checkbox" }), // 10 a row's toggle, no label
      el(1, "INPUT", sty("inline-block", "0"), [0, 170, 6, 6], { type: "checkbox" }), // 11 too small to aim at
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
        e(1010, "checkbox", "Toggle Todo"),
        e(1011, "checkbox", "Tiny"),
      ],
      snap,
      hidden,
    );
    expect(out.map((x) => [x.ref, x.via])).toEqual([
      ["e1003", 1002],
      ["e1005", 1006],
      ["e1009", undefined],
      ["e1010", undefined],
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

  it("lists a role-less tabindex=0 element as focusable, never tabindex=-1, a scroller or a container of controls", () => {
    const scroll = [
      "block",
      "visible",
      "1",
      "static",
      "auto",
      "auto",
      "auto",
      "auto",
    ] as unknown as [string, string, string];
    const handle = { tabindex: "0", class: "ui-slider-handle ui-corner-all" };
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 600, 400]), // 1
      el(1, "P", sty("block"), [0, 0, 300, 20]), // 2
      t("Price range:", [0, 0, 90, 16], 2), // 3
      el(1, "DIV", sty("block"), [0, 40, 300, 10]), // 4 the track
      el(4, "SPAN", sty("block"), [45, 35, 18, 18], handle), // 5
      el(4, "SPAN", sty("block"), [180, 35, 18, 18], handle), // 6
      el(1, "DIV", sty("block"), [0, 80, 300, 20], { tabindex: "-1" }), // 7
      t("Only script focuses this", [0, 80, 160, 16], 7), // 8
      el(1, "DIV", scroll, [0, 110, 300, 60], { tabindex: "0" }), // 9
      t("A long text", [0, 110, 80, 16], 9), // 10
      el(1, "DIV", sty("block"), [0, 180, 300, 20], { tabindex: "0" }), // 11 a card around a link
      el(11, "A", sty("inline"), [0, 180, 60, 16], { href: "#c" }), // 12
      t("its link", [0, 180, 60, 16], 12), // 13
    ]);
    const focusable = { properties: [{ name: "focusable", value: { value: true } }] };
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      id?: number,
      parentId?: string,
      kids?: string[],
      extra = {},
    ) => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      ...(id ? { backendDOMNodeId: id } : {}),
      ...(parentId ? { parentId } : {}),
      ...(kids ? { childIds: kids } : {}),
      ...extra,
    });
    const nodes: AxNode[] = [
      ax("root", "RootWebArea", "Price", 1000, undefined, ["c"], focusable),
      ax("c", "generic", "", 1001, "root", ["p", "s", "m", "sc", "card"]),
      ax("p", "paragraph", "", 1002, "c", ["st"]),
      ax("st", "StaticText", "Price range:", 1003, "p"),
      ax("s", "generic", "", 1004, "c", ["h1", "h2"]),
      ax("h1", "generic", "", 1005, "s", [], focusable),
      ax("h2", "generic", "", 1006, "s", [], focusable),
      ax("m", "generic", "", 1007, "c", [], focusable),
      ax("sc", "generic", "", 1009, "c", [], focusable),
      ax("card", "generic", "", 1011, "c", ["a"], focusable),
      ax("a", "link", "its link", 1012, "card", ["at"]),
      ax("at", "StaticText", "its link", 1013, "a"),
    ];
    const entries = cdp.axEntries(nodes);
    expect(entries.map((e) => `${e.ref} ${e.role}`)).toEqual([
      "e1005 focusable",
      "e1006 focusable",
      "e1007 focusable",
      "e1009 focusable",
      "e1011 focusable",
      "e1012 link",
    ]);
    const kept = cdp.nameUnnamed(nodes, cdp.annotate(entries, snap, cdp.hiddenElements(snap)));
    expect(kept.map((e) => e.ref)).toEqual(["e1005", "e1006", "e1012"]);
    // a handle's own row has no text (the other handle shares the track): the text around the track names it
    expect(cdp.entryLine(kept[0] as Entry)).toMatch(
      /^\[e1005\] focusable ‹[^›]*ui-slider-handle[^›]*› near "Price range: its link"$/,
    );
    const r = cdp.chooseTarget(nodes, kept, /focusable/i, { near: /Price range/i });
    expect(r.pick?.ref).toBe("e1005");
  });

  it("shows the row of controls that share a role and name, and never matches a name against it", () => {
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
      ax("root", "RootWebArea", "", undefined, ["l", "add"]),
      ax("l", "list", "", "root", ["li1", "li2"]),
      ax("li1", "listitem", "", "l", ["t1", "s1"]),
      ax("t1", "checkbox", "Toggle Todo", "li1"),
      ax("s1", "StaticText", "write report", "li1"),
      ax("li2", "listitem", "", "l", ["t2", "s2"]),
      ax("t2", "checkbox", "Toggle Todo", "li2"),
      ax("s2", "StaticText", "call mom", "li2"),
      ax("add", "button", "Add", "root"),
    ];
    const e = (nodeId: string, role: string, name: string): Entry => ({
      ref: `e${nodeId}`,
      backendNodeId: 1,
      nodeId,
      role,
      name,
    });
    const named = cdp.nameUnnamed(nodes, [
      e("t1", "checkbox", "Toggle Todo"),
      e("t2", "checkbox", "Toggle Todo"),
      e("add", "button", "Add"),
    ]);
    expect(named.map((x) => cdp.entryLine(x))).toEqual([
      '[et1] checkbox "Toggle Todo" near "write report"',
      '[et2] checkbox "Toggle Todo" near "call mom"',
      '[eadd] button "Add"',
    ]);
    expect(cdp.chooseTarget(nodes, named, /write report/i).none).toBe(true);
    expect(cdp.chooseTarget(nodes, named, /toggle/i, { near: /call mom/i }).pick?.ref).toBe("et2");
  });

  it("names the controls an action added, a new ref and a new row first", () => {
    const e = (ref: string, role: string, name: string, near?: string): Entry => ({
      ref,
      backendNodeId: 1,
      nodeId: ref,
      role,
      name,
      ...(near ? { near } : {}),
    });
    // a pick adds a second "Remove Red" (the first now shows its row too); the option list is not a control that appeared
    const before = [e("e1", "button", "Remove Red"), e("e2", "button", "Remove Blue")];
    const after = [
      e("e1", "button", "Remove Red", "Red"),
      e("e2", "button", "Remove Blue"),
      e("e9", "button", "Remove Red", "Red"),
      e("h", "heading", "Colours"),
    ];
    expect(cdp.appearedControls(before, after).map((x) => x.ref)).toEqual(["e9"]);
    // a list drawn again: every ref is new, the row that came back is the one that appeared
    const was = [
      e("a1", "checkbox", "Toggle", "buy milk"),
      e("a3", "checkbox", "Toggle", "call mom"),
    ];
    const now = [
      e("b1", "checkbox", "Toggle", "buy milk"),
      e("b2", "checkbox", "Toggle", "write report"),
      e("b3", "checkbox", "Toggle", "call mom"),
    ];
    expect(cdp.appearedControls(was, now).map((x) => x.ref)).toEqual(["b2"]);
    expect(cdp.appearedControls(now, now)).toEqual([]);
  });

  it("gives a control its label and its own box, the highest ancestor that holds no other control", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 400, 300]), // 1 holds both rows
      el(1, "DIV", sty("block"), [0, 0, 300, 30]), // 2 row of the first checkbox
      el(2, "INPUT", sty("inline-block"), [4, 8, 13, 13], { type: "checkbox" }), // 3
      el(2, "SPAN", sty("inline-block"), [0, 0, 30, 30], { class: "deco" }), // 4 its drawn box
      el(1, "DIV", sty("block"), [0, 40, 300, 30]), // 5 row of the second
      el(5, "INPUT", sty("inline-block"), [4, 48, 13, 13], { type: "checkbox", id: "u" }), // 6
      el(5, "LABEL", sty("inline-block"), [20, 40, 100, 30], { for: "u" }), // 7
      t("USB-C", [24, 44, 50, 16], 7), // 8
    ]);
    const e = (id: number, name: string): Entry => ({
      ref: `e${String(id)}`,
      backendNodeId: id,
      nodeId: String(id),
      role: "checkbox",
      name,
    });
    const out = cdp.annotate([e(1003, "DisplayPort"), e(1006, "USB-C")], snap, new Set());
    expect(out.map((x) => [x.boxEl, x.labelEl])).toEqual([
      [1002, undefined],
      [1005, 1007],
    ]);
  });

  it("names an unnamed field by the text beside it: left, above or on its top border, never its own text", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "DIV", sty("block"), [0, 0, 600, 20]), // 1 a line of the row above
      t("Page heading", [0, 0, 120, 16], 1), // 2
      el(0, "DIV", sty("block"), [0, 24, 600, 30]), // 3 a row: its label, then the field with its own value
      t("Sort by", [0, 30, 50, 16], 3), // 4
      el(3, "DIV", sty("inline-block"), [60, 24, 180, 30], { class: "gx7q2" }), // 5 the field
      t("Most relevant", [64, 30, 100, 16], 5), // 6
      el(0, "DIV", sty("block"), [0, 70, 600, 20]), // 7 a label above the next field
      t("Subjects", [0, 70, 70, 16], 7), // 8
      el(0, "INPUT", sty("inline-block"), [0, 92, 200, 24]), // 9
      el(0, "FORM", sty("block"), [0, 130, 600, 40]), // 10 a form with no button
      el(10, "INPUT", sty("inline-block"), [0, 130, 200, 24], { placeholder: "From" }), // 11
      el(0, "DIV", sty("block"), [0, 200, 600, 60]), // 12 a floating label on the field's top border, a banner far left
      t("Promo text", [0, 230, 100, 18], 12), // 13
      t("Sorting", [320, 212, 60, 16], 12), // 14
      el(12, "DIV", sty("inline-block"), [300, 220, 240, 40]), // 15
    ]);
    const e = (id: number, role: string): Entry => ({
      ref: `e${String(id)}`,
      backendNodeId: id,
      nodeId: String(id),
      role,
      name: "",
    });
    const out = cdp.annotate(
      [e(1005, "combobox"), e(1009, "combobox"), e(1011, "textbox"), e(1015, "combobox")],
      snap,
      new Set(),
    );
    expect(out.map((x) => x.label)).toEqual(["Sort by", "Subjects", undefined, "Sorting"]);
    expect(out.map((x) => x.noSubmit)).toEqual([undefined, undefined, true, undefined]);
    const sort = out[0] as Entry;
    expect(cdp.entryLine({ ...sort, near: "Most relevant" })).toBe(
      '[e1005] combobox "" label "Sort by" near "Most relevant"',
    );
    // a row text that starts with the label says it already; markup words only when nothing else names it
    expect(cdp.entryLine({ ...sort, near: "Sort by Most relevant" })).toBe(
      '[e1005] combobox "" near "Sort by Most relevant"',
    );
    expect(cdp.entryLine({ ...sort, label: "" })).toBe("[e1005] combobox ‹gx7q2›");
    expect(cdp.chooseTarget([], out, /^sort by$/i).pick?.ref).toBe("e1005");
  });

  it("finds a dropdown's own options, through aria-controls, and fields in the header and menus", () => {
    const ax = (
      nodeId: string,
      role: string,
      parentId?: string,
      kids?: string[],
      extra: Partial<AxNode> = {},
    ): AxNode => ({
      nodeId,
      role: { value: role },
      name: { value: "" },
      backendDOMNodeId: Number(nodeId) + 100,
      ...(parentId ? { parentId } : {}),
      ...(kids ? { childIds: kids } : {}),
      ...extra,
    });
    const nodes: AxNode[] = [
      ax("1", "RootWebArea", undefined, ["2", "5", "8"]),
      ax("2", "banner", "1", ["3", "4"]),
      ax("3", "searchbox", "2"),
      ax("4", "menuitem", "2"),
      ax("5", "main", "1", ["6", "7"]),
      ax("6", "combobox", "5", [], {
        properties: [{ name: "controls", value: { relatedNodes: [{ backendDOMNodeId: 108 }] } }],
      }),
      ax("7", "searchbox", "5"),
      ax("8", "listbox", "1", ["9"]),
      ax("9", "option", "8"),
    ];
    const entry = (id: string): Entry => ({
      ref: `e${String(Number(id) + 100)}`,
      backendNodeId: Number(id) + 100,
      nodeId: id,
      role: "combobox",
      name: "",
    });
    expect([...cdp.ownedNodes(nodes, entry("6"))].sort()).toEqual(["6", "8", "9"]);
    const top = new Set(["banner", "navigation"]);
    expect(cdp.inLandmark(nodes, entry("3"), top)).toBe(true);
    expect(cdp.inLandmark(nodes, entry("7"), top)).toBe(false);
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

  it("reads selected, pressed and haspopup, and lists only named column headers", () => {
    const prop = (name: string, v: unknown) => ({ name, value: { value: v } });
    const node = (
      id: number,
      role: string,
      name: string,
      props: [string, unknown][] = [],
    ): AxNode => ({
      nodeId: String(id),
      role: { value: role },
      name: { value: name },
      backendDOMNodeId: id,
      properties: props.map(([k, v]) => prop(k, v)),
    });
    const entries = cdp.axEntries([
      node(1, "tab", "Prices", [["selected", true]]),
      node(2, "tab", "Specs", [["selected", false]]),
      node(3, "button", "Bold", [["pressed", "true"]]),
      node(4, "button", "More", [
        ["hasPopup", "menu"],
        ["expanded", false],
      ]),
      node(5, "columnheader", "Population", [["focusable", true]]),
      node(6, "columnheader", ""),
    ]);
    expect(entries.map((e) => cdp.entryLine(e))).toEqual([
      '[e1] tab "Prices" selected',
      '[e2] tab "Specs"',
      '[e3] button "Bold" pressed=true',
      '[e4] button "More" expanded=false',
      '[e5] columnheader "Population" sort=none',
    ]);
    expect(entries[3]?.hasPopup).toBe("menu");
    expect(cdp.stateDiff({ selected: false }, { selected: true })).toEqual([
      "selected false -> true",
    ]);
    expect(
      cdp.stateDiff({ role: "columnheader" }, { role: "columnheader", sort: "ascending" }),
    ).toEqual(["sort none -> ascending"]);
  });

  it("keeps sortable column headers, names twins by the group above, and records links inside", () => {
    const snap = snapOf([
      doc, // 0
      el(0, "TABLE", sty("table"), [0, 0, 600, 80]), // 1
      el(1, "TH", sty("table-cell"), [0, 0, 300, 20]), // 2 group: Metro
      el(1, "TH", sty("table-cell"), [300, 0, 300, 20]), // 3 group: Proper
      el(1, "TH", sty("table-cell"), [0, 20, 150, 20], { "aria-sort": "ascending" }), // 4 Population (Metro)
      el(1, "TH", sty("table-cell", "1", "pointer"), [300, 20, 150, 20]), // 5 Population (Proper)
      el(5, "A", sty("inline"), [420, 22, 20, 14], { href: "x" }), // 6 a footnote link in it
      el(1, "TH", sty("table-cell"), [450, 20, 150, 20]), // 7 Remarks: a label only
    ]);
    const h = (id: number, name: string, extra: Partial<Entry> = {}): Entry => ({
      ref: `e${String(id)}`,
      backendNodeId: id,
      nodeId: String(id),
      role: "columnheader",
      name,
      ...extra,
    });
    const out = cdp.annotate(
      [
        h(1002, "Metro"),
        h(1003, "Proper"),
        h(1004, "Population"),
        h(1005, "Population"),
        { ref: "e1006", backendNodeId: 1006, nodeId: "1006", role: "link", name: "[1]" },
        h(1007, "Remarks"),
      ],
      snap,
      new Set(),
    );
    expect(out.map((e) => cdp.entryLine(e))).toEqual([
      '[e1004] columnheader "Population" in "Metro" sort=ascending',
      '[e1005] columnheader "Population" in "Proper" sort=none',
      '[e1006] link "[1]"',
    ]);
    expect(out[1]?.inner).toEqual([1006]);
    // the group and name are matched together, and exactly
    expect(cdp.chooseTarget([], out, /Proper Population/i).pick?.ref).toBe("e1005");
    expect(cdp.chooseTarget([], out, /^Population$/i).several?.length).toBe(2);
  });

  it("matches a description, a column's group and the role word of an unnamed control", () => {
    const e = (extra: Partial<Entry>): Entry => ({
      ref: "e1",
      backendNodeId: 1,
      nodeId: "1",
      role: "combobox",
      name: "",
      ...extra,
    });
    expect(cdp.matchTexts(e({ description: "Select City", label: "NCR" }))).toEqual([
      "NCR",
      "Select City",
      "combobox",
    ]);
    expect(cdp.matchTexts(e({ role: "slider", name: "Volume" }))).toEqual(["Volume"]);
  });

  it("prefers an exact match, then the open modal, then a field outside the header, then a twin in view", () => {
    const e = (ref: string, role: string, name: string, nodeId: string): Entry => ({
      ref,
      backendNodeId: Number(ref.slice(1)),
      nodeId,
      role,
      name,
    });
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      parentId?: string,
      kids?: string[],
      extra: Partial<AxNode> = {},
    ): AxNode => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      ...(parentId ? { parentId } : {}),
      ...(kids ? { childIds: kids } : {}),
      ...extra,
    });
    // one exact line of text beats elements that only contain the pattern (drag "A")
    const els = [e("e1", "button", "Add", "1"), e("e2", "link", "About", "2")];
    const line: Entry = { ref: "e9", backendNodeId: 9, nodeId: "", role: "text", name: "A" };
    const r1 = cdp.chooseTarget([], els, /A/i, {
      texts: () => [line, { ...line, ref: "e8", name: "Alpha" }],
    });
    expect(r1.pick?.ref).toBe("e9");
    expect(r1.note).toMatch(/only contain/);
    // a field in an open modal dialog beats the header's
    const nodes: AxNode[] = [
      ax("r", "RootWebArea", "", undefined, ["b", "d"]),
      ax("b", "banner", "", "r", ["f1"]),
      ax("f1", "textbox", "Search", "b"),
      ax("d", "dialog", "Filters", "r", ["f2"], {
        properties: [{ name: "modal", value: { value: true } }],
      }),
      ax("f2", "textbox", "Search", "d"),
    ];
    const fields = [e("e11", "textbox", "Search", "f1"), e("e12", "textbox", "Search", "f2")];
    const r2 = cdp.chooseTarget(nodes, fields, /Search/i, { fields: true });
    expect(r2.pick?.ref).toBe("e12");
    expect(r2.note).toMatch(/open dialog/);
    // without the dialog, the field outside the header and navigation
    const open: AxNode[] = nodes.map((n) =>
      n.nodeId === "d" ? { ...n, role: { value: "generic" }, properties: [] } : n,
    );
    const r3 = cdp.chooseTarget(open, fields, /Search/i, {
      fields: true,
      landmark: (x) => x.nodeId === "f1",
    });
    expect(r3.pick?.ref).toBe("e12");
    expect(r3.note).toMatch(/outside the page's header/);
    // twins (same role, name, row and place): the one in view; buttons in different rows still list
    const twins = [e("e21", "button", "Filters", "t1"), e("e22", "button", "Filters", "t2")];
    const flat: AxNode[] = [
      ax("r", "RootWebArea", "", undefined, ["t1", "t2"]),
      ax("t1", "button", "Filters", "r"),
      ax("t2", "button", "Filters", "r"),
    ];
    const r4 = cdp.chooseTarget(flat, twins, /Filters/i, { inView: (x) => x.ref === "e22" });
    expect(r4.pick?.ref).toBe("e22");
    expect(r4.note).toMatch(/one in view/);
    expect(cdp.chooseTarget(flat, twins, /Filters/i).pick?.ref).toBe("e21");
    expect(cdp.chooseTarget(tree(), cdp.axEntries(tree()), /honey/i).several?.length).toBe(2);
  });

  it("lets --near match the group around a control or the heading before it, and keeps such twins apart", () => {
    const ax = (
      nodeId: string,
      role: string,
      name: string,
      parentId?: string,
      kids?: string[],
    ): AxNode => ({
      nodeId,
      role: { value: role },
      name: { value: name },
      ...(/^\d+$/.test(nodeId) ? { backendDOMNodeId: Number(nodeId) } : {}),
      ...(parentId ? { parentId } : {}),
      ...(kids ? { childIds: kids } : {}),
    });
    // listed out of document order, as Chrome sends them
    const nodes: AxNode[] = [
      ax("r", "RootWebArea", "", undefined, ["h1", "g1", "h2", "g2"]),
      ax("g2", "radiogroup", "", "r", ["12"]),
      ax("12", "radio", "3", "g2"),
      ax("g1", "radiogroup", "Experience", "r", ["11"]),
      ax("11", "radio", "3", "g1"),
      ax("h1", "heading", "How experienced are you?", "r"),
      ax("h2", "heading", "How satisfied are you?", "r"),
    ];
    const entries = cdp.axEntries(nodes).filter((x) => x.role === "radio");
    expect(cdp.chooseTarget(nodes, entries, /^3$/).several?.length).toBe(2);
    expect(cdp.chooseTarget(nodes, entries, /^3$/, { near: /satisfied/i }).pick?.ref).toBe("e12");
    expect(cdp.chooseTarget(nodes, entries, /^3$/, { near: /^Experience$/ }).pick?.ref).toBe("e11");
  });

  it("points to closed menus, icon-only and menu ones first, and aims beside the controls inside one", () => {
    const e = (ref: string, name: string, extra: Partial<Entry>): Entry => ({
      ref,
      backendNodeId: 1,
      nodeId: ref,
      role: "button",
      name,
      ...extra,
    });
    const menus = cdp.closedMenus([
      e("e1", "Author", { hasPopup: "dialog", expanded: false }),
      e("e2", "Search", { role: "searchbox", hasPopup: "listbox" }),
      e("e3", "Open", { expanded: true }),
      e("e4", "More list controls", { hasPopup: "menu", expanded: false, iconOnly: true }),
      e("e5", "Labels", { hasPopup: "menu", expanded: false }),
      e("e6", "Section", { expanded: false }),
      e("e7", "Other", { expanded: false }),
    ]);
    expect(menus.map((m) => m.ref)).toEqual(["e4", "e5", "e1", "e6"]);
    const pts = cdp.aimPoints({ l: 0, t: 0, r: 100, b: 20 }, [{ l: 40, t: 0, r: 60, b: 20 }]);
    expect(pts.length).toBeGreaterThan(0);
    for (const p of pts) expect(p.x < 37 || p.x > 63).toBe(true);
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
