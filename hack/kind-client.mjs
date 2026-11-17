/* global process, fetch, console, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout */
// The session API client of hack/kind-smoke.sh. It runs INSIDE an ingest pod (`kubectl exec deploy/pi-ingest -- node
// --input-type=module -e "$(cat this file)" <command> ...`), so API tokens stay in the cluster: the token is read from the
// pod's own PI_API_TOKENS and is never printed. Output is plain lines the shell script greps.
//
//   status <owner> <final>            GET /admin/status; waits (exit 3) until the isolation probe has run unless <final> is 1
//   create <owner>                    POST /sessions, prints `session <id>`
//   ask <owner> <id> <text> <until> <seconds>
//                                     POST a message, stream until an assistant entry contains <until>; prints `TOOL <text>`
//                                     for every tool result and `ANSWER <text>`; exit 3 on timeout
//   delete <owner> <id> <seconds>     DELETE, waits for status deleted
const [command, owner, ...args] = process.argv.slice(1);
const base = `http://127.0.0.1:${process.env.PI_INGEST_PORT ?? "8080"}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function token() {
  for (const entry of (process.env.PI_API_TOKENS ?? "").split(/[\n,]/)) {
    const line = entry.trim();
    const at = line.indexOf(":");
    if (at > 0 && line.slice(0, at) === owner) return line.slice(at + 1);
  }
  console.error(`no token for owner ${owner}`);
  process.exit(2);
}
const headers = { authorization: `Bearer ${token()}` };

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}
function fail(what, res) {
  console.error(`${what} answered ${String(res.status)}: ${res.text.slice(0, 300)}`);
  process.exit(2);
}

async function status() {
  const final = args[0] === "1";
  const res = await call("GET", "/admin/status");
  if (res.status !== 200) fail("GET /admin/status", res);
  const { shards, networkPolicy } = res.json;
  if (["unknown", "running"].includes(networkPolicy.state) && !final) {
    console.error("waiting: the isolation probe has not finished");
    process.exit(3);
  }
  for (const s of shards) {
    console.log(
      `shard ${String(s.shard)} configuredRuntime=${s.configuredRuntime || "(node default)"} observedRuntime=${String(s.observedRuntime)} networkPolicy=${s.networkPolicy}`,
    );
  }
  console.log(
    `isolation-probe state=${networkPolicy.state} checkedAt=${String(networkPolicy.checkedAt)}`,
  );
  if (networkPolicy.state !== "enforced")
    console.log(`isolation-probe detail=${JSON.stringify(networkPolicy.detail ?? null)}`);
  for (const t of networkPolicy.detail?.targets ?? [])
    console.log(`probe-target ${t.name} ${t.address} ${t.outcome} ${t.verdict}`);
}

async function create() {
  const res = await call("POST", "/sessions", {});
  if (res.status !== 201) fail("POST /sessions", res);
  console.log(`session ${res.json.sessionId}`);
}

async function ask() {
  const [id, text, until, seconds] = args;
  const sent = await call("POST", `/sessions/${id}/events`, { kind: "message", text });
  if (sent.status !== 202) fail("POST /sessions/{id}/events", sent);
  const deadline = Date.now() + Number(seconds) * 1000;
  let answered = false;
  while (Date.now() < deadline && !answered) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    try {
      const res = await fetch(`${base}/sessions/${id}/stream`, {
        headers: { ...headers, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!res.ok) {
        // 503 while the orchestrator is not ready yet: retry until the deadline.
        await res.body?.cancel().catch(() => undefined);
        await sleep(2000);
        continue;
      }
      const decoder = new TextDecoder();
      let buffer = "";
      read: for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let name = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) name = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (name !== "entry") continue;
          for (const m of JSON.parse(data).messages) {
            if (m.role === "toolResult")
              console.log(`TOOL ${String(m.text).replace(/\s+/g, " ").slice(0, 400)}`);
            if (m.role === "assistant" && String(m.text ?? "").includes(until)) {
              console.log(`ANSWER ${m.text}`);
              answered = true;
              break read;
            }
          }
        }
      }
    } catch {
      if (controller.signal.aborted) break;
      await sleep(2000);
    }
    clearTimeout(timer);
    // Aborted only after the loop is left: aborting inside it makes the iterator's cleanup throw.
    controller.abort();
  }
  if (answered) return;
  console.error(`timeout: no assistant answer containing ${until} within ${seconds}s`);
  process.exit(3);
}

async function del() {
  const [id, seconds] = args;
  const res = await call("DELETE", `/sessions/${id}`);
  if (res.status !== 202) fail("DELETE /sessions/{id}", res);
  const deadline = Date.now() + Number(seconds) * 1000;
  while (Date.now() < deadline) {
    const got = await call("GET", `/sessions/${id}`);
    if (got.status === 410 || got.json?.status === "deleted") {
      console.log("deleted");
      return;
    }
    await sleep(2000);
  }
  console.error("timeout: the session is not deleted");
  process.exit(3);
}

const commands = { status, create, ask, delete: del };
if (!(command in commands)) {
  console.error(`unknown command ${command}`);
  process.exit(64);
}
await commands[command]();
