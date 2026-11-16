/* global process, fetch, console, AbortController, setTimeout, clearTimeout, TextDecoder */
// Tiny session-API client for tests/e2e/run-phase4b.sh. Runs inside an ingest pod (`kubectl exec -i ... node - ...`), where
// PI_API_TOKENS is already in the environment, so no token ever leaves the cluster or is printed. For a local stack
// set API_BASE and PI_API_TOKENS (or API_TOKEN) in the environment.
//
//   node client.mjs call OWNER METHOD PATH [BODY]  -> {"status":N,"body":...}
//   node client.mjs stream OWNER SESSION NEEDLE SECONDS -> prints "found" or "timeout"; exit 0 either way
//   node client.mjs dump OWNER SESSION SECONDS -> the raw event stream, for debugging
//   node client.mjs answer OWNER SESSION NEEDLE SECONDS -> prints "found <tools>" when an ASSISTANT text contains
//     NEEDLE after at least one tool call (<tools> = number of calls seen), else "timeout" or "failed"
const base = process.env.API_BASE ?? "http://127.0.0.1:8080";

function tokenFor(owner) {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  // Same parsing as packages/session-core/src/auth.ts: split on newline or comma, trim, split at the first colon.
  for (const entry of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) {
    const line = entry.trim();
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at) === owner && line.length > at + 1) return line.slice(at + 1);
  }
  throw new Error(`no token for owner ${owner}`);
}

const [command, owner, ...rest] = process.argv.slice(2);
const headers = { authorization: `Bearer ${tokenFor(owner)}`, "content-type": "application/json" };

if (command === "call") {
  const [method, path, body] = rest;
  const response = await fetch(base + path, { method, headers, body: body || undefined });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON (an empty body): report the status only.
  }
  console.log(JSON.stringify({ status: response.status, body: parsed }));
} else if (command === "stream") {
  const [session, needle, seconds] = rest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(seconds) * 1000);
  let seen = "";
  let found = false;
  try {
    const response = await fetch(`${base}/sessions/${session}/stream`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      seen += decoder.decode(chunk, { stream: true });
      if (seen.toLowerCase().includes(needle.toLowerCase())) {
        found = true;
        break;
      }
    }
  } catch {
    // Aborted by the timer.
  }
  clearTimeout(timer);
  controller.abort();
  console.log(found ? "found" : "timeout");
} else if (command === "dump") {
  // Debugging aid: print the raw event stream for SECONDS (entries and live state; no secrets pass through here).
  const [session, seconds] = rest;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), Number(seconds) * 1000);
  try {
    const response = await fetch(`${base}/sessions/${session}/stream`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    for await (const chunk of response.body)
      process.stdout.write(decoder.decode(chunk, { stream: true }));
  } catch {
    // Aborted by the timer.
  }
} else if (command === "answer") {
  const [session, needle, seconds] = rest;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(seconds) * 1000);
  let buffer = "";
  let calls = 0;
  let result = "timeout";
  try {
    const response = await fetch(`${base}/sessions/${session}/stream`, {
      headers: { ...headers, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const decoder = new TextDecoder();
    outer: for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (!block.includes("event: entry")) continue;
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        const entry = JSON.parse(data.slice(6));
        for (const message of entry.messages ?? []) {
          if (message.role !== "assistant") continue;
          calls += (message.calls ?? []).length;
          if (calls > 0 && (message.text ?? "").toLowerCase().includes(needle.toLowerCase())) {
            result = `found ${calls}`;
            break outer;
          }
        }
      }
    }
  } catch {
    // Aborted by the timer.
  }
  clearTimeout(timer);
  controller.abort();
  console.log(result);
} else {
  throw new Error("usage: call|stream|dump|answer");
}
