/* global process, fetch, console, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout */
// Test client for tests/e2e/run-phase4.sh. It runs INSIDE an ingest pod (`kubectl exec -i pod -- node - ...`
// with this file on stdin), so API tokens never leave the cluster: it reads PI_API_TOKENS from the pod's
// environment and picks the entry of the named owner. Nothing here prints a token.
//
//   call   <owner|bad|none> <METHOD> <path> [json-body]   [--base URL]
//          prints one line: {"status":N,"body":<json or text>}
//   stream <owner|bad|none> <sessionId> [--base URL] [--last-id N] [--until-text T] [--max-entries N]
//          [--reconnect] [--timeout SECONDS]
//          prints  CONNECT <n> last=<id> status=<code>
//                  ENTRY <id> <json>        one transcript entry (SSE id = entry id)
//                  LIVE <json>              the run in progress (no id)
//                  END <reason>             the connection ended
//                  DONE | DROP last=<id> | TIMEOUT
//          Exits when an assistant entry contains T (DONE), after N entries (DROP, a simulated client drop),
//          or at the timeout. With --reconnect it reconnects with Last-Event-ID after every end.
const [command, who, ...rest] = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    flags[name] = name === "reconnect" ? true : rest[++i];
  } else positional.push(arg);
}
// Loopback: the client runs inside an ingest pod; the pi-ingest Service would be ingest->ingest, which policy denies.
const base = flags.base ?? "http://127.0.0.1:8080";

function token() {
  if (who === "none") return undefined;
  if (who === "bad") return "0".repeat(48);
  for (const line of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) {
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at) === who) return line.slice(at + 1);
  }
  throw new Error(`no token for owner ${who}`);
}
const auth = () => {
  const t = token();
  return t === undefined ? {} : { authorization: `Bearer ${t}` };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call() {
  const [method, path, body] = positional;
  const res = await fetch(base + path, {
    method,
    headers: { ...auth(), ...(body ? { "content-type": "application/json" } : {}) },
    body: body || undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* plain text */
  }
  console.log(JSON.stringify({ status: res.status, body: parsed }));
}

async function stream() {
  const [sessionId] = positional;
  let last = Number(flags["last-id"] ?? 0);
  const maxEntries = flags["max-entries"] === undefined ? Infinity : Number(flags["max-entries"]);
  const timeoutMs = Number(flags.timeout ?? 300) * 1000;
  const until = flags["until-text"];
  const deadline = Date.now() + timeoutMs;
  let connections = 0;
  let entries = 0;

  while (Date.now() < deadline) {
    connections++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let res;
    try {
      res = await fetch(`${base}/sessions/${sessionId}/stream`, {
        headers: {
          ...auth(),
          accept: "text/event-stream",
          ...(last > 0 ? { "last-event-id": String(last) } : {}),
        },
        signal: controller.signal,
      });
    } catch {
      console.log(`CONNECT ${connections} last=${last} status=error`);
      clearTimeout(timer);
      if (!flags.reconnect) break;
      await sleep(1000);
      continue;
    }
    console.log(`CONNECT ${connections} last=${last} status=${res.status}`);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      clearTimeout(timer);
      if (!flags.reconnect) break;
      await sleep(1000);
      continue;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let outcome;
    try {
      read: for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = { name: "message", id: undefined, data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) event.name = line.slice(7);
            else if (line.startsWith("id: ")) event.id = Number(line.slice(4));
            else if (line.startsWith("data: ")) event.data += line.slice(6);
          }
          if (event.name === "live") console.log(`LIVE ${event.data}`);
          else if (event.name === "entry") {
            console.log(`ENTRY ${String(event.id)} ${event.data}`);
            last = event.id;
            entries++;
            const parsed = JSON.parse(event.data);
            const finished = parsed.messages.some(
              (m) => m.role === "assistant" && until !== undefined && m.text.includes(until),
            );
            if (finished) {
              outcome = "DONE";
              break read;
            }
            if (entries >= maxEntries) {
              outcome = `DROP last=${String(last)}`;
              break read;
            }
          } else if (event.name === "deleted") console.log("DELETED");
        }
      }
      if (outcome === undefined) console.log("END closed-by-server");
    } catch {
      console.log(`END ${controller.signal.aborted ? "aborted" : "error"}`);
      if (controller.signal.aborted) break;
    }
    clearTimeout(timer);
    if (outcome !== undefined) {
      // Leave the loop first and abort afterwards: aborting inside it makes the iterator's cleanup throw.
      console.log(outcome);
      controller.abort();
      return;
    }
    if (!flags.reconnect) break;
    await sleep(1000);
  }
  console.log("TIMEOUT");
  process.exitCode = 3;
}

// stdin scripts run as CommonJS: no top-level await.
(command === "call" ? call() : stream()).catch((error) => {
  console.error(String(error));
  process.exit(2);
});
