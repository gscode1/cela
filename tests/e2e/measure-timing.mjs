#!/usr/bin/env node
// p50/p90 of each phase of the orchestrator's `turn-timing` events, and the RSS of its bridges (docs/metrics.md).
//
//   node tests/e2e/measure-timing.mjs --context <kube context> --namespace <ns> [--since 24h] [--deployment pi-orchestrator]
//   node tests/e2e/measure-timing.mjs --file orchestrator.log        (offline: a saved log, "-" for stdin)
//
// Read-only: the only kubectl call is `kubectl logs`. Runs on the Mac; needs Node 20+ and kubectl, nothing else.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

/** Nearest-rank percentile of a non-empty array of numbers. */
export function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

/** The parsed JSON lines of one event name; lines that are not JSON (other output) are skipped. */
export function eventsOf(text, name) {
  const found = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      if (event.event === name) found.push(event);
    } catch {
      // Not one of ours.
    }
  }
  return found;
}

/** Rows of { state, name, n, p50, p90, max } for the phases and spans of the turn-timing events, by sandbox state. */
export function summarize(turns) {
  const groups = new Map();
  const add = (state, name, ms) => {
    const key = `${state}\0${name}`;
    const list = groups.get(key) ?? [];
    list.push(ms);
    groups.set(key, list);
  };
  for (const turn of turns) {
    for (const [name, ms] of Object.entries(turn.phases ?? {}))
      add(turn.sandbox, `phase:${name}`, ms);
    for (const [name, ms] of Object.entries(turn.spans ?? {}))
      add(turn.sandbox, `span:${name}`, ms);
  }
  return [...groups]
    .map(([key, values]) => {
      const [state, name] = key.split("\0");
      return {
        state,
        name,
        n: values.length,
        p50: percentile(values, 50),
        p90: percentile(values, 90),
        max: Math.max(...values),
      };
    })
    .sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name));
}

/** Per session: samples, median and peak RSS in MiB. */
export function summarizeRss(samples) {
  const bySession = new Map();
  for (const s of samples) {
    const list = bySession.get(s.session) ?? [];
    list.push(s.rssBytes / 1048576);
    bySession.set(s.session, list);
  }
  return [...bySession].map(([session, mib]) => ({
    session,
    n: mib.length,
    p50: percentile(mib, 50),
    max: Math.max(...mib),
  }));
}

function table(rows, columns) {
  const cells = rows.map((row) =>
    columns.map((c) => String(typeof row[c] === "number" ? Math.round(row[c] * 10) / 10 : row[c])),
  );
  const widths = columns.map((c, i) => Math.max(c.length, ...cells.map((r) => r[i].length)));
  const line = (r) => r.map((v, i) => v.padEnd(widths[i])).join("  ");
  return [line(columns), ...cells.map(line)].join("\n");
}

function main() {
  const { values } = parseArgs({
    options: {
      context: { type: "string" },
      namespace: { type: "string" },
      since: { type: "string", default: "24h" },
      deployment: { type: "string", default: "pi-orchestrator" },
      file: { type: "string" },
    },
  });
  let text;
  if (values.file !== undefined) {
    text = readFileSync(values.file === "-" ? 0 : values.file, "utf8");
  } else {
    if (values.context === undefined || values.namespace === undefined) {
      console.error(
        "usage: measure-timing.mjs --context <ctx> --namespace <ns> [--since 24h] [--deployment pi-orchestrator]",
      );
      process.exit(64);
    }
    text = execFileSync(
      "kubectl",
      [
        "--context",
        values.context,
        "-n",
        values.namespace,
        "logs",
        `deploy/${values.deployment}`,
        `--since=${values.since}`,
      ],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
    );
  }
  const turns = eventsOf(text, "turn-timing");
  if (turns.length === 0) {
    console.log("no turn-timing events found (a turn is only timed when it runs a tool call)");
  } else {
    const counts = {};
    for (const t of turns) counts[t.sandbox] = (counts[t.sandbox] ?? 0) + 1;
    console.log(
      `${turns.length} turns: ${Object.entries(counts)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ")}\n`,
    );
    console.log("ms since the turn started (phase:*) or between two phases (span:*)");
    console.log(table(summarize(turns), ["state", "name", "n", "p50", "p90", "max"]));
  }
  const rss = eventsOf(text, "bridge-rss");
  if (rss.length > 0) {
    console.log("\nbridge RSS per session, MiB");
    console.log(table(summarizeRss(rss), ["session", "n", "p50", "max"]));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
