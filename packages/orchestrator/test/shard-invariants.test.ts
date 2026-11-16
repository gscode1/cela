import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Architectural invariant of docs/decisions/0017-schema-sharding.md: conversation ids repeat across shards, so no
 * orchestrator code may identify a conversation, a session or a claim by the conversation id alone.
 */
const here = fileURLToPath(new URL(".", import.meta.url));
const SOURCES = [
  join(here, "../src"),
  join(here, "../../session-core/src"),
  join(here, "../../ingest/src"),
];

function sourceFiles(): { file: string; text: string }[] {
  return SOURCES.flatMap((dir) =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({ file: join(dir, name), text: readFileSync(join(dir, name), "utf8") })),
  );
}

const code = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
    .join("\n");

describe("shard invariants", () => {
  it("every SQL predicate on conversation_id also names the shard", () => {
    const offenders: string[] = [];
    for (const { file, text } of sourceFiles()) {
      const body = code(text);
      for (const match of body.matchAll(/\bconversation_id\s*(=|in)\s*(\$\d|\()/gi)) {
        const at = match.index;
        // The statement: from the opening quote or backtick before the match to the closing one after it.
        const start = Math.max(body.lastIndexOf("`", at), body.lastIndexOf('"', at));
        const nextTick = body.indexOf("`", at);
        const nextQuote = body.indexOf('"', at);
        const end = Math.min(
          nextTick === -1 ? Infinity : nextTick,
          nextQuote === -1 ? Infinity : nextQuote,
        );
        const statement = body.slice(start, end === Infinity ? undefined : end);
        if (!/\bshard\b/.test(statement)) offenders.push(`${file}: ${statement.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("claim and PVC names come from lifecycle.ts, never from a literal pi-conv- prefix elsewhere", () => {
    const offenders = sourceFiles()
      .filter(({ file }) => !file.endsWith("/lifecycle.ts"))
      .filter(({ text }) => /pi-conv-/.test(code(text)))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("the old unscoped lookups are gone", () => {
    for (const { file, text } of sourceFiles()) {
      expect(code(text), file).not.toMatch(
        /select [^"`]*from inbox\.sessions where conversation_id/,
      );
    }
  });
});
