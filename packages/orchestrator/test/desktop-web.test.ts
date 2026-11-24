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

  it("reads text per block element, joining split prices and skipping hidden text", () => {
    // nodes: 0 document, 1 div (block), 2 span "145", 3 span ",95 zł" text, 4 hidden div, 5 its text
    const strings = ["block", "inline", "visible", "hidden", "145", ",95 zł", "secret", "#text"];
    const snap = {
      strings,
      documents: [
        {
          nodes: {
            parentIndex: [-1, 0, 1, 1, 0, 4],
            nodeType: [9, 1, 3, 3, 1, 3],
            nodeValue: [-1, -1, 4, 5, -1, 6],
          },
          layout: {
            nodeIndex: [1, 2, 3, 4, 5],
            styles: [
              [0, 2],
              [1, 2],
              [1, 2],
              [0, 3],
              [1, 3],
            ],
          },
        },
      ],
    };
    expect(cdp.snapshotLines(snap)).toEqual(["145,95 zł"]);
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
});
