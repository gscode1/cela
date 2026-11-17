import { SKILL_LIMITS } from "@/lib/skills/limits";

/**
 * A port of the API's strict SKILL.md frontmatter reader (packages/session-core/src/frontmatter.ts and the checks of
 * skills.ts), so the review step can show the name and description the API will see, and the reason when it would
 * refuse the file. It is a preview: the API reads the file again and decides.
 */

const FRONTMATTER_BYTES = 8 * 1024;
const FRONTMATTER_LINES = 100;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_START = /^[[{|>&*!%@`#]/;
const DELIMITER = /^---[ \t]*$/;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const encoder = new TextEncoder();

export type SkillMeta =
  | { ok: true; name: string | undefined; description: string; disableModelInvocation: boolean }
  | { ok: false; message: string };

function unquoteDouble(raw: string): string | undefined {
  const simple: Record<string, string> = {
    "\\": "\\",
    '"': '"',
    "/": "/",
    n: "\n",
    t: "\t",
    r: "\r",
  };
  let out = "";
  for (let i = 1; i < raw.length - 1; i++) {
    const ch = raw[i] as string;
    if (ch === '"') return undefined;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
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

function scalar(value: string): string | undefined {
  const quote = value[0];
  if (quote === '"' || quote === "'") {
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
  return /:(?:[ \t]|$)/.test(plain) ? undefined : plain;
}

function readFields(text: string): Map<string, string> | string {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r?\n/);
  if (!DELIMITER.test(lines[0] ?? ""))
    return "SKILL.md must start with a YAML frontmatter block (--- lines) that has a description";
  const fields = new Map<string, string>();
  let bytes = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (DELIMITER.test(line)) return fields;
    bytes += encoder.encode(line).length + 1;
    if (i > FRONTMATTER_LINES || bytes > FRONTMATTER_BYTES)
      return `SKILL.md: frontmatter is larger than ${String(FRONTMATTER_LINES)} lines or ${String(FRONTMATTER_BYTES)} bytes, or is not closed by a --- line`;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (/^[ \t]/.test(line))
      return `SKILL.md: frontmatter line ${String(i + 1)} is indented: only flat "key: value" lines are supported`;
    const colon = line.indexOf(":");
    const key = colon < 0 ? "" : line.slice(0, colon);
    if (!KEY.test(key))
      return `SKILL.md: frontmatter line ${String(i + 1)} is not "key: value" with a plain key`;
    if (fields.has(key)) return `SKILL.md: frontmatter key "${key}" appears twice`;
    const value = scalar(line.slice(colon + 1).trim());
    if (value === undefined)
      return `SKILL.md: frontmatter "${key}" is not a plain or quoted single-line string`;
    fields.set(key, value);
  }
  return "SKILL.md: frontmatter is not closed by a --- line";
}

/** The name, description and model-invocation flag of a SKILL.md as the API would read them, or why it would refuse. */
export function readSkillMeta(text: string): SkillMeta {
  const fields = readFields(text);
  if (typeof fields === "string") return { ok: false, message: fields };
  const description = fields.get("description");
  if (
    description === undefined ||
    description.trim() === "" ||
    Array.from(description).length > SKILL_LIMITS.description ||
    !description.isWellFormed() ||
    description.includes("\u0000") ||
    CONTROL.test(description)
  )
    return {
      ok: false,
      message: `SKILL.md: frontmatter must have a non-empty description of at most ${String(SKILL_LIMITS.description)} characters, on one line, without control characters`,
    };
  const flag = fields.get("disable-model-invocation");
  if (flag !== undefined && flag !== "true" && flag !== "false")
    return {
      ok: false,
      message: "SKILL.md: frontmatter disable-model-invocation must be true or false",
    };
  return {
    ok: true,
    name: fields.get("name"),
    description,
    disableModelInvocation: flag === "true",
  };
}
