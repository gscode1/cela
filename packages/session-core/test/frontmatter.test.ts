import { describe, expect, it } from "vitest";
import { FRONTMATTER_LIMITS, parseFrontmatter } from "../src/frontmatter.ts";

const fields = (text: string) => {
  const parsed = parseFrontmatter(text);
  if (parsed.kind !== "ok") throw new Error(`${parsed.kind}: ${JSON.stringify(parsed)}`);
  return Object.fromEntries(parsed.fields);
};
const error = (text: string) => {
  const parsed = parseFrontmatter(text);
  if (parsed.kind !== "error") throw new Error(`expected an error, got ${parsed.kind}`);
  return parsed.message;
};

describe("parseFrontmatter", () => {
  it("reads plain scalars, trims them and returns the body", () => {
    const parsed = parseFrontmatter(
      "---\nname:  pdf \ndescription: Summarise a PDF\n---\n# Body\n",
    );
    expect(parsed).toMatchObject({ kind: "ok", body: "# Body\n" });
    expect(fields("---\nname:  pdf \ndescription: Summarise a PDF\n---\n")).toEqual({
      name: "pdf",
      description: "Summarise a PDF",
    });
  });

  it("has no frontmatter unless the text starts with a --- line", () => {
    for (const text of ["", "# Title\n", "\n---\na: b\n---\n", "----\na: b\n---\n", "--- x\n"]) {
      expect(parseFrontmatter(text)).toEqual({ kind: "none" });
    }
  });

  it("accepts CRLF line ends, a byte order mark and trailing blanks on delimiters", () => {
    expect(fields("\uFEFF---  \r\na: b\r\n---\t\r\nbody")).toEqual({ a: "b" });
  });

  it("reads double- and single-quoted strings with their escapes", () => {
    expect(
      fields(
        [
          "---",
          'a: "x: y # not a comment"',
          'b: "tab\\there \\"q\\" \\\\ \\u00e9"',
          "c: 'it''s: fine'",
          'd: ""',
          "e: ''",
          "---",
        ].join("\n"),
      ),
    ).toEqual({
      a: "x: y # not a comment",
      b: 'tab\there "q" \\ é',
      c: "it's: fine",
      d: "",
      e: "",
    });
  });

  it("drops a trailing comment, keeps a # inside a word, and skips blank and comment lines", () => {
    expect(
      fields("---\n# a comment\n\ndescription: use c# today # gone\nk: 'v' # note\n---\n"),
    ).toEqual({ description: "use c# today", k: "v" });
  });

  it("keeps an empty plain value as an empty string and a colon without a space inside a value", () => {
    expect(fields("---\na:\nurl: http://x.test/a:b\n---\n")).toEqual({
      a: "",
      url: "http://x.test/a:b",
    });
  });

  it("keeps the first delimiter's frontmatter when the body has more --- lines", () => {
    const parsed = parseFrontmatter("---\na: b\n---\nbody\n---\nmore\n");
    expect(parsed).toMatchObject({ kind: "ok", body: "body\n---\nmore\n" });
  });

  it.each([
    ["unclosed", "---\na: b\n", "not closed"],
    ["duplicate key", "---\na: b\na: c\n---\n", 'key "a" appears twice'],
    ["nested value", "---\na:\n  b: c\n---\n", "indented"],
    ["indented line", "---\n a: b\n---\n", "indented"],
    ["block scalar |", "---\na: |\n  x\n---\n", "single-line string"],
    ["block scalar >", "---\na: >-\n  x\n---\n", "single-line string"],
    ["flow list", "---\na: [x, y]\n---\n", "single-line string"],
    ["flow map", "---\na: {x: y}\n---\n", "single-line string"],
    ["anchor", "---\na: &x y\n---\n", "single-line string"],
    ["tag", "---\na: !!str y\n---\n", "single-line string"],
    ["list item", "---\n- a\n---\n", "plain key"],
    ["no colon", "---\nabc\n---\n", "plain key"],
    ["bad key", "---\nA B: c\n---\n", "plain key"],
    ["empty key", "---\n: c\n---\n", "plain key"],
    ["nested mapping in a plain value", "---\na: b: c\n---\n", "single-line string"],
    ["unterminated quote", '---\na: "b\n---\n', "single-line string"],
    ["text after a quote", "---\na: 'b' c\n---\n", "single-line string"],
    ["unknown escape", '---\na: "\\q"\n---\n', "single-line string"],
    ["short unicode escape", '---\na: "\\u12"\n---\n', "single-line string"],
  ])("refuses %s", (_name, text, message) => {
    expect(error(text)).toContain(message);
  });

  it("is bounded: too many lines or too many bytes is refused, however the block ends", () => {
    const keys = Array.from({ length: FRONTMATTER_LIMITS.lines + 5 }, (_, i) => `k${String(i)}: v`);
    const manyLines = `---\n${keys.join("\n")}\n---\n`;
    expect(error(manyLines)).toContain("larger than");
    const manyBytes = `---\nk: ${"x".repeat(FRONTMATTER_LIMITS.bytes)}\n---\n`;
    expect(error(manyBytes)).toContain("larger than");
    // An unclosed block of a megabyte is cut off at the limit, not scanned to the end.
    expect(error(`---\n${"#".repeat(1000)}\n`.repeat(1) + "# c\n".repeat(200_000))).toContain(
      "larger than",
    );
  });
});
