/**
 * A small, bounded reader for the YAML frontmatter of a SKILL.md (docs/decisions/0011-skills-in-postgres.md). It is
 * deliberately not YAML: a block between two `---` lines made of `key: value` lines whose values are scalars, plain or
 * quoted. Anything else (nesting, lists, block scalars, anchors, tags, a repeated key) is refused with a message
 * instead of being guessed at, so what the admin store and a repo accept is the same, and the input an attacker can
 * make the parser chew on is capped. No dependency; repo skills (#71) reuse it.
 */

export const FRONTMATTER_LIMITS = {
  /** Bytes of UTF-8 between the delimiters. */
  bytes: 8 * 1024,
  lines: 100,
} as const;

export type FrontmatterResult =
  /** No frontmatter: the text does not start with a `---` line. */
  | { kind: "none" }
  | { kind: "ok"; fields: Map<string, string>; body: string }
  | { kind: "error"; message: string };

const KEY = /^[A-Za-z0-9_-]{1,64}$/;
/** Characters that start YAML constructs this reader does not implement, so a plain scalar may not begin with one. */
const RESERVED_START = /^[[{|>&*!%@`#]/;
const DELIMITER = /^---[ \t]*$/;

const fail = (message: string): FrontmatterResult => ({ kind: "error", message });

function unquoteDouble(raw: string): string | undefined {
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i] as string;
    if (ch === '"') return undefined;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    const simple: Record<string, string> = {
      "\\": "\\",
      '"': '"',
      "/": "/",
      n: "\n",
      t: "\t",
      r: "\r",
    };
    if (next !== undefined && next in simple) {
      out += simple[next] ?? "";
    } else if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else {
      return undefined;
    }
  }
  return out;
}

/** The scalar of `value` (already trimmed of leading space), or undefined when it is not one this reader accepts. */
function scalar(value: string): string | undefined {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    // The closing quote is the last one before an optional ` # comment`.
    let end = -1;
    for (let i = 1; i < value.length; i++) {
      if (quote === "'" && value[i] === "'" && value[i + 1] === "'") i++;
      else if (quote === '"' && value[i] === "\\") i++;
      else if (value[i] === quote) {
        end = i;
        break;
      }
    }
    if (end < 0) return undefined;
    const rest = value.slice(end + 1).trim();
    if (rest !== "" && !rest.startsWith("#")) return undefined;
    const quoted = value.slice(0, end + 1);
    return quote === '"' ? unquoteDouble(quoted) : quoted.slice(1, -1).replaceAll("''", "'");
  }
  if (RESERVED_START.test(value)) return undefined;
  const comment = value.search(/[ \t]#/);
  const plain = (comment < 0 ? value : value.slice(0, comment)).trim();
  // `key: a: b` is a mapping in YAML, not a scalar.
  return /:(?:[ \t]|$)/.test(plain) ? undefined : plain;
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (!DELIMITER.test(lines[0] ?? "")) return { kind: "none" };
  const fields = new Map<string, string>();
  let bytes = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (DELIMITER.test(line)) {
      return { kind: "ok", fields, body: lines.slice(i + 1).join("\n") };
    }
    bytes += Buffer.byteLength(line) + 1;
    if (i > FRONTMATTER_LIMITS.lines || bytes > FRONTMATTER_LIMITS.bytes) {
      return fail(
        `frontmatter is larger than ${String(FRONTMATTER_LIMITS.lines)} lines or ${String(FRONTMATTER_LIMITS.bytes)} bytes, or is not closed by a --- line`,
      );
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      return fail(
        `frontmatter line ${String(i + 1)} is indented: only flat "key: value" lines are supported (no nesting or multi-line values)`,
      );
    }
    const colon = line.indexOf(":");
    const key = colon < 0 ? "" : line.slice(0, colon);
    if (!KEY.test(key)) {
      return fail(`frontmatter line ${String(i + 1)} is not "key: value" with a plain key`);
    }
    if (fields.has(key)) return fail(`frontmatter key "${key}" appears twice`);
    const value = scalar(line.slice(colon + 1).trim());
    if (value === undefined) {
      return fail(
        `frontmatter "${key}" is not a plain or quoted single-line string (lists, objects, | and > blocks are not supported)`,
      );
    }
    fields.set(key, value);
  }
  return fail("frontmatter is not closed by a --- line");
}
